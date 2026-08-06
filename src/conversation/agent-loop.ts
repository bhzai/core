/** @file Agent loop core — sendMessage, context event, message states (TASK_0025, TASK_0026, TASK_0027, TASK_0030) */

import Ajv from "ajv"
import type { BHZAI } from "../core/bhzai.js"
import { parseModelRef } from "../core/models.js"
import { DEFAULT_RETRY_POLICY, callDriverWithRetry } from "../core/retry.js"
import type { RequestDispatch, RequestEventPayload, RetryPolicy } from "../core/retry.js"
import { resolveAvailableTools } from "../tools/availability.js"
import { normalizeToolResult } from "../tools/registry.js"
import type { CallToolResult, ContentBlock } from "../types/content.js"
import type { BHZAIDriver, ChatRequest, DriverEvent } from "../types/driver.js"
import type { BHZAIToolDefinition } from "../types/index.js"
import type { BHZAIMessage, ConversationStatus, ToolCallRecord } from "../types/message.js"
import type { BHZAIConversationImpl } from "./conversation.js"
import { createMessage, withMessageFields } from "./message.js"
import { computePreContextSystemPrompt, ensureStarted } from "./system-prompt.js"
import { createThinkSplitter } from "./think-stream.js"

/**
 * Error thrown when sendMessage() is called with deliverAs: 'immediate' (default)
 * on a non-idle conversation (TASK_0030).
 */
export class ConversationBusyError extends Error {
	constructor(message: string) {
		super(message)
		this.name = "ConversationBusyError"
	}
}

/**
 * Options for sendMessage (TASK_0025).
 *
 * `deliverAs` is declared here as a forward-looking field; TASK_0030 fully
 * implements its semantics. This task only supports the default 'immediate' behavior.
 */
export interface SendOptions {
	/**
	 * Delivery mode: 'immediate' (default) fires the loop and waits,
	 * 'steer' and 'followUp' are TASK_0030 extensions.
	 */
	deliverAs?: "immediate" | "steer" | "followUp"
}

/**
 * Options for addMessage (TASK_0025).
 *
 * Controls whether the message is included in context-event filtering.
 */
export interface AddOptions {
	/** Whether this message is included in context events (default true). */
	contextIncluded?: boolean
	/** Additional metadata to merge into the message. */
	meta?: Record<string, unknown>
}

/**
 * Helper: get all messages that should be sent to the driver in context events.
 *
 * Per § 11.6 and TASK_0024's convention, returns every message in
 * `conversation.messages` whose `meta.contextIncluded !== false`.
 * Only explicit `false` is excluded; `undefined` and `true` both include the message.
 *
 * Exported so TASK_0031 (compaction) can reuse this filter.
 *
 * @param conversation The conversation to filter.
 * @returns Messages whose meta.contextIncluded is not false.
 */
export function effectiveContextMessages(conversation: BHZAIConversationImpl): BHZAIMessage[] {
	return conversation.messages.filter((msg) => msg.meta.contextIncluded !== false)
}

/**
 * Apply context-event system-prompt patches to a base prompt.
 *
 * Implements layer 4 of § 11.6 (ARCHITECTURE.md 1165–1204) with three-way precedence:
 * 1. If `patch.systemPrompt !== undefined` → replace outright (highest precedence).
 * 2. Else if `patch.appendSystemPrompt !== undefined` → append to `base` with a blank-line separator.
 * 3. Else → `base` unchanged (fallback).
 *
 * Appending uses the same rule as layer 3: if base is non-empty, append with `\n\n` separator;
 * if base is empty, use the appendSystemPrompt value directly.
 *
 * Exported so this logic is directly unit-testable and also exercised through sendMessage's
 * full integration path.
 *
 * @param base The pre-context system prompt (from layer 3).
 * @param patch Context-event patch object, may contain `systemPrompt` and/or `appendSystemPrompt`.
 * @returns The effective system prompt after applying the patch.
 */
export function applyContextSystemPromptPatch(
	base: string,
	patch: { systemPrompt?: string; appendSystemPrompt?: string },
): string {
	if (patch.systemPrompt !== undefined) {
		return patch.systemPrompt
	}
	if (patch.appendSystemPrompt !== undefined) {
		return base ? `${base}\n\n${patch.appendSystemPrompt}` : patch.appendSystemPrompt
	}
	return base
}

/**
 * Construct a BHZAIMessage from a string or ContentBlock array.
 *
 * @internal Used by sendMessage and addMessage (including tool results).
 */
function constructMessage(
	content: string | ContentBlock[],
	role: "user" | "assistant" | "system" | "tool",
	conversation: BHZAIConversationImpl,
): BHZAIMessage {
	return createMessage({ role, content }, conversation._getBh()._getMessageFields())
}

/**
 * Send a user message and drive the agent loop.
 *
 * Per TASK_0025/TASK_0026/TASK_0027, this implements the full bounded pipeline:
 * 1. Construct user message
 * 2. Call ensureStarted() for initialization
 * 3. Fire loop(start)
 * 4. Fire message(before) — may block
 * 5. If not blocked: append message, fire message(waiting)
 * 6. For each iteration (bounded by maxIterations, default 8, per TASK_0027):
 *    - Check abort signal at top; break if aborted
 *    - Check maxIterations bound; break if reached (flag last message with truncatedBy)
 *    - Fire turn(start)
 *    - Fire context event, resolve driver capabilities
 *    - Call driver via retry wrapper (with per-turn timeout if configured)
 *    - Consume DriverEvents (message.delta, usage, tool-call buffering)
 *    - Finalize assistant message, fire message(sent)
 *    - If tool-calls: execute tool batch, collect results
 *    - Fire turn(end) with payload including toolResults
 *    - Check turn(end) veto (continueWith): if present, inject message and continue
 *    - Check termination conditions (natural stop, universal terminate hint, abort)
 *    - If no early termination: increment iteration counter, loop back
 *
 * **Bounded termination conditions (TASK_0027 § 11.2)**:
 * - **Natural stop**: stopReason !== 'tool-calls' (driver produced no tool calls)
 * - **Universal terminate hint**: every tool result carries _meta['BHZAI/terminate']: true (strict "every")
 * - **maxIterations**: iteration >= maxIterations (default 8; configurable per conversation)
 * - **Abort**: conversation._getAbortSignal().aborted (fires abort event, returns with meta.aborted=true)
 *
 * **Blocked message contract**: If message(before) blocks, sendMessage() RESOLVES
 * (does not reject) with a synthetic BHZAIMessage flagged `meta.blocked: true`
 * and `meta.blockedReason?: string`. No driver call, no loop events, status
 * returns to/remains 'idle'.
 *
 * @param conversation The conversation to send to.
 * @param content User message content — plain string or ContentBlock array.
 * @param options Delivery mode (this task only supports the default 'immediate').
 * @returns Promise resolving with the assistant's response message (or a blocked message).
 */
export async function sendMessage(
	conversation: BHZAIConversationImpl,
	content: string | ContentBlock[],
	options?: SendOptions,
): Promise<BHZAIMessage> {
	const bh = conversation._getBh()

	// TASK_0030: Busy-check at entry point.
	const deliverAs = options?.deliverAs ?? "immediate"
	if (conversation.status !== "idle") {
		if (deliverAs === "immediate") {
			throw new ConversationBusyError(
				`Conversation is busy (status: ${conversation.status}); use deliverAs: "steer" or "followUp", or wait for idle.`,
			)
		}
		// Queue the message and return a promise that resolves later.
		return new Promise<BHZAIMessage>((resolve, reject) => {
			if (deliverAs === "steer") {
				conversation._pushSteerQueue({ content, resolve, reject })
			} else {
				conversation._pushFollowUpQueue({ content, resolve, reject })
			}
		})
	}

	// Step 1: Construct the user message.
	const userMessage = constructMessage(content, "user", conversation)

	// Step 2: Ensure the conversation has been started (fire start event, apply prepends, etc.).
	const createOptions = conversation._getCreateOptions()
	await ensureStarted(conversation, bh, createOptions, userMessage)

	// Step 3: Fire loop(start).
	await conversation._dispatchConversationEvent("loop", {
		state: "start" as const,
		trigger: userMessage,
	})

	// Step 4: Fire message(before) — blockable.
	const beforeResult = await conversation._dispatchConversationEvent(
		"message",
		{
			conversationId: conversation.id,
			messageId: userMessage.id,
			role: "user",
			message: userMessage,
			time: Date.now(),
			state: "before" as const,
			conversation,
		} as unknown,
		{ blockable: true },
	)

	// If blocked, return immediately without calling the driver.
	// `withMessageFields` rather than a bare spread: message-field accessors are
	// non-enumerable and would not survive the copy, so the returned message
	// would lose every plugin field.
	if (beforeResult.blocked) {
		return withMessageFields(
			userMessage,
			{
				meta: {
					...userMessage.meta,
					blocked: true,
					blockedReason: beforeResult.reason,
				},
			},
			bh._getMessageFields(),
		)
	}

	// Step 5: Apply any patches from message(before), append message, fire message(waiting).
	const patchedMessage = withMessageFields(
		userMessage,
		beforeResult.patch as Partial<BHZAIMessage>,
		bh._getMessageFields(),
	)
	conversation._pushMessage(patchedMessage)

	await conversation._dispatchConversationEvent("message", {
		conversationId: conversation.id,
		messageId: patchedMessage.id,
		role: "user",
		message: patchedMessage,
		time: Date.now(),
		state: "waiting" as const,
		conversation,
	})

	conversation._setStatus("streaming")

	// Step 6: Bounded loop (TASK_0027) — continue until a termination condition fires.
	const maxIterations = createOptions.maxIterations ?? 8
	const turnTimeoutMs = createOptions.turnTimeoutMs
	const parseThink = createOptions.parseThink ?? false
	const retryPolicy = createOptions.retryPolicy ?? DEFAULT_RETRY_POLICY

	let iteration = 0
	let lastAssistantMessage: BHZAIMessage | undefined
	let pendingSteerResolutions: Array<{
		content: string | ContentBlock[]
		resolve: (msg: BHZAIMessage) => void
		reject: (err: unknown) => void
	}> = []

	while (true) {
		// Termination condition: check if conversation was aborted mid-loop.
		if (conversation._getAbortSignal().aborted) {
			break
		}

		// Termination condition: check if we've hit maxIterations.
		if (iteration >= maxIterations) {
			if (lastAssistantMessage) {
				// Mutation exception: TASK_0027 allows meta mutation for host bookkeeping.
				// This is a deliberate carve-out for flagging truncation, distinct from
				// the message-lifecycle mutation methods (append/setContent) which remain 'before'-only.
				lastAssistantMessage.meta.truncatedBy = "max-iterations"
			}
			break
		}

		// TASK_0030: Steer delivery — inject at the top of the loop iteration.
		// Drain the steer queue and deliver queued messages in FIFO order.
		// Each queued message runs through the full message(before) middleware.
		pendingSteerResolutions = []
		const steerEntries = conversation._drainSteerQueue()
		for (const entry of steerEntries) {
			const steerMessage = constructMessage(entry.content, "user", conversation)
			const beforeResult = await conversation._dispatchConversationEvent(
				"message",
				{
					conversationId: conversation.id,
					messageId: steerMessage.id,
					role: "user",
					message: steerMessage,
					time: Date.now(),
					state: "before" as const,
					conversation,
				} as unknown,
				{ blockable: true },
			)

			if (beforeResult.blocked) {
				// Blocked: settle this entry's promise with blocked message.
				entry.resolve({
					...steerMessage,
					meta: {
						...steerMessage.meta,
						blocked: true,
						blockedReason: beforeResult.reason,
					},
				})
			} else {
				// Not blocked: apply patches, append to history, and register for resolution.
				const patchedMessage = { ...steerMessage, ...beforeResult.patch }
				conversation._pushMessage(patchedMessage)
				pendingSteerResolutions.push(entry)
			}
		}

		// Fire turn(start) event at the beginning of this iteration.
		await conversation._dispatchConversationEvent("turn", {
			state: "start" as const,
			turn: iteration,
			messages: undefined,
			toolResults: undefined,
			conversation,
		} as unknown)

		// Resolve driver before building context.
		const modelRef = conversation._getModelRef()
		if (!modelRef) {
			throw new Error(
				"sendMessage(): conversation has no resolved model — did you forget to set a model?",
			)
		}

		const parsed = parseModelRef(modelRef)
		if (!parsed) {
			throw new Error(
				`sendMessage(): invalid model ref "${modelRef}" — not in 'driver/model' format`,
			)
		}

		const driver = bh._getDriver(parsed.driver)
		if (!driver) {
			throw new Error(`sendMessage(): driver "${parsed.driver}" not found`)
		}

		// Use the BARE model id (not the qualified ref) for capabilities lookup —
		// driver caches are keyed by the bare id (`entry.id` from `listModels()`).
		// Passing the qualified ref here silently missed the cache and returned
		// conservative defaults (`toolCalls: false`), stripping every tool.
		const driverCapabilities = driver.capabilities(parsed.id)

		// Construct base context payload.
		const systemPrompt = computePreContextSystemPrompt(conversation)
		const messages = effectiveContextMessages(conversation)
		const allTools = bh.listTools()

		// Deep copy context payload per TASK_0025 § 6.1.
		const clonedMessages = messages.map((msg) => ({
			id: msg.id,
			role: msg.role,
			content: msg.content,
			blocks: structuredClone(msg.blocks),
			time: msg.time,
			meta: structuredClone(msg.meta),
		})) as BHZAIMessage[]

		const contextPayload = {
			conversation,
			messages: clonedMessages,
			systemPrompt: structuredClone(systemPrompt),
			tools: [...allTools],
		}

		// Fire context event (non-blockable, observe-and-patch only).
		const contextResult = await conversation._dispatchConversationEvent(
			"context",
			contextPayload as unknown,
		)

		// Apply patches: use patched values if returned, otherwise use base.
		const contextPatch = contextResult.patch as Record<string, unknown> | undefined
		const effectiveMessages =
			(contextPatch?.messages as BHZAIMessage[] | undefined) ?? contextPayload.messages
		const effectiveSystemPrompt = applyContextSystemPromptPatch(contextPayload.systemPrompt, {
			systemPrompt: contextPatch?.systemPrompt as string | undefined,
			appendSystemPrompt: contextPatch?.appendSystemPrompt as string | undefined,
		})
		const effectiveTools =
			(contextPatch?.tools as typeof allTools | undefined) ?? contextPayload.tools

		// Resolve available tools with driver-capability gating.
		const resolvedTools = resolveAvailableTools(
			allTools,
			undefined,
			effectiveTools !== allTools ? effectiveTools : undefined,
			driverCapabilities,
		)
		const advertisedTools = resolvedTools.map((rt) => rt.tool)

		// Project tools to wire format.
		const toolWireDefinitions = advertisedTools.map((tool) => ({
			name: tool.name,
			description: tool.description,
			inputSchema: tool.inputSchema,
		}))

		// Build ChatRequest. The model is the BARE model id (not the qualified
		// `'<driver>/<model>'` ref) — the driver knows its own id via `this.id`
		// and decides how to format the model name on the wire. See
		// `ChatRequest.model` JSDoc in `src/types/driver.ts`.
		const chatRequest: ChatRequest = {
			model: parsed.id,
			messages: effectiveMessages,
			systemPrompt: effectiveSystemPrompt,
			tools: toolWireDefinitions.length > 0 ? toolWireDefinitions : undefined,
			signal: conversation._getAbortSignal(),
		}

		// Create a new assistant message for this turn.
		const assistantMessage = constructMessage("", "assistant", conversation)
		const toolCallBuffer: DriverEvent[] = []
		// One splitter per assistant turn, so a `<think>` block never bleeds
		// across turns. Only allocated when the conversation opted in.
		const thinkSplitter = parseThink ? createThinkSplitter() : undefined

		// Fire request(before) via dispatch wrapper for retry logic.
		const requestDispatch: RequestDispatch = async (
			event: "request",
			payload: RequestEventPayload,
			options?: { blockable?: boolean },
		) => {
			return conversation._dispatchConversationEvent<RequestEventPayload>(event, payload, options)
		}

		// Wrap the driver call in per-turn timeout if configured.
		const driverCallPromise = callDriverWithRetry(driver, chatRequest, retryPolicy, requestDispatch)

		// TASK_0027: Implement per-turn timeout if configured.
		// Note: This is a simplified timeout implementation that prevents further
		// event consumption but doesn't cancel in-flight operations.
		let timeoutHandle: ReturnType<typeof setTimeout> | undefined
		let timeoutFired = false
		if (turnTimeoutMs !== undefined) {
			timeoutHandle = setTimeout(() => {
				timeoutFired = true
			}, turnTimeoutMs)
		}

		// Consume driver events.
		let stopReason: string | undefined
		let naturalStop = false
		for await (const event of driverCallPromise) {
			// TASK_0027: Check if per-turn timeout has fired; if so, stop consuming events.
			if (timeoutFired) {
				break
			}

			if (event.type === "delta") {
				if (thinkSplitter) {
					// parseThink: split this chunk into reasoning and answer text,
					// then emit each on the channel it belongs to. Either delta may
					// be empty (a chunk wholly inside or wholly outside the tags, or
					// one held back mid-tag); skip the dispatch in that case so
					// consumers never see empty deltas.
					const { thoughtDelta, answerDelta } = thinkSplitter.push(event.text)
					if (thoughtDelta) {
						assistantMessage.think = (assistantMessage.think ?? "") + thoughtDelta
						await conversation._dispatchConversationEvent("message.delta", {
							conversationId: conversation.id,
							messageId: assistantMessage.id,
							delta: thoughtDelta,
							kind: "reasoning" as const,
						})
					}
					if (answerDelta) {
						assistantMessage.append(answerDelta)
						await conversation._dispatchConversationEvent("message.delta", {
							conversationId: conversation.id,
							messageId: assistantMessage.id,
							delta: answerDelta,
							kind: "text" as const,
						})
					}
				} else {
					assistantMessage.append(event.text)
					await conversation._dispatchConversationEvent("message.delta", {
						conversationId: conversation.id,
						messageId: assistantMessage.id,
						delta: event.text,
						kind: "text" as const,
					})
				}
			} else if (event.type === "reasoning-delta") {
				if (!assistantMessage.meta.reasoning) {
					assistantMessage.meta.reasoning = ""
				}
				;(assistantMessage.meta.reasoning as string) += event.text
				await conversation._dispatchConversationEvent("message.delta", {
					conversationId: conversation.id,
					messageId: assistantMessage.id,
					delta: event.text,
					kind: "reasoning" as const,
				})
			} else if (event.type === "usage") {
				conversation._accumulateUsage(event.inputTokens ?? 0, event.outputTokens ?? 0)
			} else if (event.type === "tool-call-delta" || event.type === "tool-call") {
				// Buffer tool calls — TASK_0026 owns execution.
				toolCallBuffer.push(event)
			} else if (event.type === "done") {
				stopReason = event.stopReason

				// On non-tool-calls terminal reasons (including timeout), mark natural stop.
				if (stopReason !== "tool-calls") {
					naturalStop = true
				}

				break
			}
		}

		// Clear timeout if still pending.
		if (timeoutHandle) {
			clearTimeout(timeoutHandle)
		}

		// Record the tool calls this turn produced ON the assistant message that
		// made them, as `meta.toolCalls` (§ 11.1's open message-field contract).
		//
		// WHY: `toolCallBuffer` is local to this iteration, but the message list
		// is what a driver sees on the NEXT one — so without this the calls are
		// unrecoverable from history. Two things depend on having them:
		//
		//  1. Providers that validate conversation structure. OpenAI rejects a
		//     `role: 'tool'` message whose preceding assistant message does not
		//     advertise the matching `tool_call_id`, so its driver has to rebuild
		//     that pairing; the tool-result message alone carries the id and name
		//     but never the arguments.
		//  2. Any consumer replaying history — a snapshot restore, a host
		//     rendering the call the model chose, a different driver picking up
		//     an existing conversation.
		//
		// Shaped as plain JSON (`{ id, name, arguments }` with `arguments` a raw
		// string) so it survives the snapshot round-trip unchanged, and so it
		// matches what every provider's wire format wants. `input` is normally
		// already the raw argument string the driver accumulated; a driver that
		// yields a structured value gets serialized here rather than at each
		// consumer.
		const producedToolCalls = toolCallBuffer.filter((e) => e.type === "tool-call") as Array<{
			type: "tool-call"
			toolCallId: string
			name: string
			input: unknown
		}>
		if (producedToolCalls.length > 0) {
			assistantMessage.meta.toolCalls = producedToolCalls.map(
				(call): ToolCallRecord => ({
					id: call.toolCallId,
					name: call.name,
					arguments: typeof call.input === "string" ? call.input : JSON.stringify(call.input),
				}),
			)
		}

		// Finalize the assistant message (for both natural stop and tool-calls paths).
		conversation._pushMessage(assistantMessage)

		// Fire message(sent) for the assistant message.
		await conversation._dispatchConversationEvent("message", {
			conversationId: conversation.id,
			messageId: assistantMessage.id,
			role: "assistant",
			message: assistantMessage,
			time: Date.now(),
			state: "sent" as const,
			conversation,
		})

		// Auto-compaction check (TASK_0031).
		// Place: right after message(sent) so all turn state is settled before checking context window.
		// Trigger condition: if compaction is enabled AND the active driver reports contextWindow AND
		// remaining free tokens < reserveTokens, then run compaction in the background.
		// This happens without blocking the turn flow — compaction runs as a side effect and
		// returns immediately, leaving messages marked contextIncluded:false for the next context event.
		// If driver doesn't report contextWindow, auto-compaction is disabled (natural consequence,
		// not a bug — threshold calculation requires the window size).
		const createOpts = conversation._getCreateOptions()
		if (createOpts.compaction?.auto) {
			const modelRef = conversation._getModelRef()
			if (modelRef) {
				const bh = conversation._getBh()
				// Use `parseModelRef` (first-slash split) instead of `split("/")` —
				// a model id can itself contain slashes (e.g. HuggingFace repo
				// paths like `meta-llama/Llama-3.1-8B-Instruct`), so a naive
				// `split("/")` would over-split and pass the wrong id to
				// `capabilities()`.
				const parsedRef = parseModelRef(modelRef)
				if (parsedRef) {
					const driver = bh._getDriver(parsedRef.driver)
					if (driver) {
						const caps = driver.capabilities(parsedRef.id)
						if (caps.contextWindow !== undefined) {
							const remainingTokens =
								caps.contextWindow -
								(conversation.usage.inputTokens + conversation.usage.outputTokens)
							if (remainingTokens < createOpts.compaction.reserveTokens) {
								// Trigger auto-compaction in background (don't await, so the turn continues)
								// Use compactAuto wrapper which handles default completeFn resolution
								const { compactAuto } = await import("./compaction.js")
								void compactAuto(conversation)
							}
						}
					}
				}
			}
		}

		// TASK_0030: Resolve pending steer entries with this turn's assistant message.
		// Per the design doc, "processed" means "the iteration that included it in context
		// produced its assistant response", which is right here after message(sent).
		for (const entry of pendingSteerResolutions) {
			entry.resolve(assistantMessage)
		}
		pendingSteerResolutions = []

		// Execute tool batch (if any) and collect results.
		let toolResults: CallToolResult[] = []
		if (stopReason === "tool-calls") {
			toolResults = await executeToolBatch(
				conversation,
				bh,
				toolCallBuffer,
				advertisedTools,
				iteration,
			)
		}

		// Termination condition (b): check if all tool results carry the terminate hint.
		const allTerminate =
			toolResults.length > 0 && toolResults.every((r) => r._meta?.["BHZAI/terminate"] === true)

		// Fire turn(end) event for this iteration (TASK_0027).
		// This fires regardless of naturalStop/allTerminate, giving plugins a chance to veto.
		const turnEndResult = await conversation._dispatchConversationEvent("turn", {
			state: "end" as const,
			turn: iteration,
			messages: [assistantMessage],
			toolResults,
			conversation,
		} as unknown)

		// Update lastAssistantMessage for future truncation flagging.
		lastAssistantMessage = assistantMessage

		// TASK_0027: Handle turn(end) veto via continueWith.
		const continueWith = (turnEndResult.patch as Record<string, unknown> | undefined)
			?.continueWith as string | undefined
		if (continueWith) {
			// Veto: inject a synthetic follow-up and continue looping.
			// This iteration STILL counts toward maxIterations.
			const syntheticMessage = constructMessage(continueWith, "user", conversation)
			syntheticMessage.meta.synthetic = "turn-veto-continuation"
			syntheticMessage.meta.contextIncluded = true
			conversation._pushMessage(syntheticMessage)

			// Increment and loop back.
			iteration++
			continue
		}

		// Check termination conditions.
		if (naturalStop || allTerminate) {
			// Natural termination: no tool calls or all results carry terminate hint.
			break
		}

		// If we reach here: tool calls were made, no terminate hint, no veto.
		// Increment and loop back to context (iteration boundary).
		iteration++
	}

	// Loop has exited (via termination condition or abort).
	// If aborted, return the last message with aborted flag.
	// The abort event is already fired by conversation.abort() itself (TASK_0027).
	if (conversation._getAbortSignal().aborted) {
		// Return with aborted flag (or a synthetic empty message if none exists yet).
		const resultMsg = lastAssistantMessage ?? constructMessage("", "assistant", conversation)
		resultMsg.meta.aborted = true
		return resultMsg
	}

	// Normal exit (via termination condition): fire loop(end) and handle followUp/idle.
	// Per TASK_0030 design:
	// 1. Fire loop(end) unconditionally — a run always concludes its own loop.
	await conversation._dispatchConversationEvent("loop", {
		state: "end" as const,
		messages: conversation.messages,
		usage: conversation.usage,
	})

	// 2. Check for queued followUp messages before transitioning to idle.
	const nextFollowUp = conversation._dequeueOneFollowUp()
	if (nextFollowUp || conversation._getSteerQueueLength() > 0) {
		// Do NOT fire idle for this transition — a new run is starting.
		// Set status to idle BEFORE calling sendMessage, so the recursive call sees idle status.
		conversation._setStatus("idle")
		if (nextFollowUp) {
			// Kick off the followUp's own run in the background.
			// It starts a brand-new loop(start)/message(before)/etc. cycle exactly as if
			// the caller had called sendMessage() directly. The returned promise
			// is resolved/rejected by the recursive call independently.
			void sendMessage(conversation, nextFollowUp.content, { deliverAs: "immediate" })
				.then((msg) => nextFollowUp.resolve(msg))
				.catch((err) => nextFollowUp.reject(err))
		}
	} else {
		// Both queues empty: transition to idle and fire idle event.
		conversation._setStatus("idle")
		// Fire the idle event (notification-only).
		await conversation._dispatchConversationEvent("idle", { conversation })
	}

	return lastAssistantMessage ?? constructMessage("", "assistant", conversation)
}

/**
 * Execute a batch of tool calls from one turn (TASK_0026, TASK_0027).
 *
 * Implements per-call beforeCall→call→complete|error sequence, concurrency
 * handling (concurrent by default, serial-tagged tools wait), validation-and-repair,
 * and original-call-order result reordering. Appends tool-result messages to
 * conversation.messages once all calls settle.
 *
 * @param conversation The active conversation.
 * @param bh The BHZAI kernel instance.
 * @param toolCallBuffer The buffered tool-call events from the driver.
 * @param advertisedTools The tools that were actually offered to the model.
 * @param turn The current turn number (for logging/debugging).
 * @returns Array of settled CallToolResult objects in original call order (TASK_0027).
 * @internal
 */
async function executeToolBatch(
	conversation: BHZAIConversationImpl,
	bh: BHZAI,
	toolCallBuffer: DriverEvent[],
	advertisedTools: BHZAIToolDefinition[],
	turn: number,
): Promise<CallToolResult[]> {
	// Filter to tool-call events only, in emission order.
	const toolCalls = toolCallBuffer.filter((e) => e.type === "tool-call") as Array<{
		type: "tool-call"
		toolCallId: string
		name: string
		input: unknown
	}>

	if (toolCalls.length === 0) {
		return []
	}

	const createOptions = conversation._getCreateOptions()
	const serialTools = createOptions.serialTools ?? false
	const maxToolRepairs = createOptions.maxToolRepairs ?? 2
	let repairCount = 0

	// Validator for JSON Schema validation (instantiate fresh per task).
	const ajv = new Ajv()

	// Results array pre-sized to batch length, indexed by original position.
	const results: (CallToolResult | undefined)[] = new Array(toolCalls.length)

	// Map of advertised tool names for quick lookup.
	const advertisedToolNames = new Set(advertisedTools.map((t) => t.name))

	// Partition tools into serial and concurrent.
	const serialToolCalls: typeof toolCalls = []
	const concurrentToolCalls: typeof toolCalls = []

	for (const call of toolCalls) {
		const toolDef = bh._getTool(call.name)
		if (serialTools || (toolDef?.serial ?? false)) {
			serialToolCalls.push(call)
		} else {
			concurrentToolCalls.push(call)
		}
	}

	// Helper: execute a single tool call with full event sequence.
	async function executeSingleCall(
		callIndex: number,
		call: (typeof toolCalls)[number],
	): Promise<void> {
		const toolDef = bh._getTool(call.name)

		// Step 1: Validation (before any event fires).
		if (!toolDef || !advertisedToolNames.has(call.name)) {
			// Unregistered or not-offered tool — validate-and-repair.
			const reason = !toolDef ? `Unknown tool "${call.name}"` : `Tool "${call.name}" not offered`
			const repairMsg =
				repairCount < maxToolRepairs
					? `${reason}. Please correct and retry.`
					: `Tool call repair limit (${maxToolRepairs}) exceeded for this turn; this call will not be retried further.`
			repairCount++
			results[callIndex] = {
				content: [{ type: "text", text: repairMsg }],
				isError: true,
			}
			return
		}

		// Validate input against inputSchema.
		const schema = toolDef.inputSchema
		const validate = ajv.compile(schema)
		if (!validate(call.input)) {
			// Schema validation failed — validate-and-repair.
			const schemaErrors = validate.errors
				?.map((e) => `${e.instancePath || "root"} ${e.message}`)
				.join("; ")
			const reason = `Argument validation failed: ${schemaErrors || "unknown error"}`
			const repairMsg =
				repairCount < maxToolRepairs
					? `${reason}. Please correct and retry.`
					: `Tool call repair limit (${maxToolRepairs}) exceeded for this turn; this call will not be retried further.`
			repairCount++
			results[callIndex] = {
				content: [{ type: "text", text: repairMsg }],
				isError: true,
			}
			return
		}

		// Step 2: beforeCall event (blockable) — closing TASK_0013's seam.
		const beforeCallResult = await conversation._dispatchConversationEvent(
			"tool",
			{
				conversationId: conversation.id,
				tool: toolDef,
				toolCallId: call.toolCallId,
				input: call.input,
				time: Date.now(),
				state: "beforeCall" as const,
				conversation,
			} as unknown,
			{ blockable: true },
		)

		if (beforeCallResult.blocked) {
			// Tool call blocked by policy.
			results[callIndex] = {
				content: [
					{
						type: "text",
						text: beforeCallResult.reason ?? "blocked by policy",
					},
				],
				isError: true,
			}
			// Fire tool(error) immediately (skip call/processing).
			await conversation._dispatchConversationEvent("tool", {
				conversationId: conversation.id,
				tool: toolDef,
				toolCallId: call.toolCallId,
				input: call.input,
				time: Date.now(),
				state: "error" as const,
				response: results[callIndex],
				conversation,
			} as unknown)
			return
		}

		// Step 3: call event and execute.
		await conversation._dispatchConversationEvent("tool", {
			conversationId: conversation.id,
			tool: toolDef,
			toolCallId: call.toolCallId,
			input: call.input,
			time: Date.now(),
			state: "call" as const,
			conversation,
		} as unknown)

		let executeResult: CallToolResult
		try {
			// TASK_0027: Race execute() against abort signal to force error on abort.
			// This is a defensive safeguard for tools that don't properly cooperate
			// with AbortSignal. We race the execute promise against an abort promise.
			const abortSignal = conversation._getAbortSignal()
			const executePromise = toolDef.execute({
				conversation,
				params: call.input,
				toolCallId: call.toolCallId,
				signal: abortSignal,
				progress: async (update) => {
					// Fire processing event.
					void conversation._dispatchConversationEvent("tool", {
						conversationId: conversation.id,
						tool: toolDef,
						toolCallId: call.toolCallId,
						input: call.input,
						time: Date.now(),
						state: "processing" as const,
						response: update,
						conversation,
					} as unknown)
				},
			})

			// Create a promise that rejects when abort fires.
			const abortPromise = new Promise<never>((_, reject) => {
				if (abortSignal.aborted) {
					reject(new Error("Tool execution aborted"))
				} else {
					const abortListener = () => {
						reject(new Error("Tool execution aborted"))
					}
					abortSignal.addEventListener("abort", abortListener)
					// Note: we don't clean up the listener here as the promise will settle
					// in the race, and the signal is conversation-scoped anyway.
				}
			})

			// Race the execute promise against abort.
			const rawResult = await Promise.race([executePromise, abortPromise])

			// Normalize the result.
			executeResult = normalizeToolResult(rawResult)
		} catch (err) {
			// Execute threw — synthesize error result.
			executeResult = {
				content: [
					{
						type: "text",
						text: `Tool execution error: ${err instanceof Error ? err.message : String(err)}`,
					},
				],
				isError: true,
			}
		}

		// Step 4: complete | error event (with rewrite-patch opportunity).
		const completeEvent = await conversation._dispatchConversationEvent("tool", {
			conversationId: conversation.id,
			tool: toolDef,
			toolCallId: call.toolCallId,
			input: call.input,
			time: Date.now(),
			state: executeResult.isError ? ("error" as const) : ("complete" as const),
			response: executeResult,
			conversation,
		} as unknown)

		// Apply any rewrite patches and store final result.
		const patch = completeEvent.patch as Record<string, unknown> | undefined
		if (patch?.response) {
			results[callIndex] = patch.response as CallToolResult
		} else if (patch?.isError !== undefined) {
			results[callIndex] = { ...executeResult, isError: patch.isError as boolean }
		} else {
			results[callIndex] = executeResult
		}
	}

	// Execute concurrently by default.
	if (!serialTools) {
		// Run all concurrent-portion calls in parallel.
		await Promise.all(
			concurrentToolCalls.map((call, idx) => {
				// Find the original index of this call.
				const originalIdx = toolCalls.indexOf(call)
				return executeSingleCall(originalIdx, call)
			}),
		)

		// Then run serial-tagged calls one-at-a-time.
		for (const call of serialToolCalls) {
			const originalIdx = toolCalls.indexOf(call)
			await executeSingleCall(originalIdx, call)
		}
	} else {
		// Force strict serialization — every call one-at-a-time in emitted order.
		for (const call of toolCalls) {
			const originalIdx = toolCalls.indexOf(call)
			await executeSingleCall(originalIdx, call)
		}
	}

	// Append tool-result messages in original call order, once all settle.
	// This is the "batch settles" integration point (exposed here for TASK_0030).
	const settledResults: CallToolResult[] = []
	for (let i = 0; i < toolCalls.length; i++) {
		const result = results[i]
		if (result !== undefined) {
			const call = toolCalls[i]

			// Construct tool-result message.
			const toolResultMsg = constructMessage(result.content ?? [], "tool", conversation)
			toolResultMsg.meta = {
				toolCallId: call.toolCallId,
				toolName: call.name,
				isError: result.isError ?? false,
				contextIncluded: true,
			}

			conversation._pushMessage(toolResultMsg)
			settledResults.push(result)
		}
	}

	// Return the settled results in original call order for TASK_0027's turn(end) payload.
	return settledResults
}

/**
 * Add a message without driving the agent loop.
 *
 * Per § 11.1, this is the "inject a message WITHOUT triggering the loop" primitive.
 * Does not call ensureStarted, fire loop events, call the driver, or otherwise
 * touch the agent loop — just constructs and appends the message, then fires
 * message(sent) immediately since it's already finalized.
 *
 * @param conversation The conversation to add to.
 * @param content Message content — plain string or ContentBlock array.
 * @param role Message role: 'user', 'assistant', or 'system'.
 * @param options Options including contextIncluded flag and metadata.
 * @returns Promise resolving with the added message.
 */
export async function addMessage(
	conversation: BHZAIConversationImpl,
	content: string | ContentBlock[],
	role: "user" | "assistant" | "system",
	options?: AddOptions,
): Promise<BHZAIMessage> {
	const message = constructMessage(content, role, conversation)

	// Merge metadata with contextIncluded convention.
	message.meta = {
		...options?.meta,
		contextIncluded: options?.contextIncluded ?? true,
	}

	// Append directly.
	conversation._pushMessage(message)

	// Fire message(sent) immediately since it's already finalized.
	await conversation._dispatchConversationEvent("message", {
		conversationId: conversation.id,
		messageId: message.id,
		role,
		message,
		time: Date.now(),
		state: "sent" as const,
		conversation,
	})

	return message
}
