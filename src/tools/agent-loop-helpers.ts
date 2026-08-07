/**
 * @file Extracted helper functions from `sendMessage` (agent-loop.ts).
 *
 * Each function is a self-contained, unit-testable piece of the agent loop's
 * orchestration logic. `sendMessage` calls them in sequence; tests exercise
 * them in isolation without needing a full conversation + driver + event-bus
 * integration setup.
 *
 * Extraction boundaries were chosen to keep each helper's inputs/outputs
 * explicit (no hidden state mutations beyond the conversation itself), so
 * they can be reasoned about and tested independently.
 */

import type Ajv from "ajv"
import {
	applyContextSystemPromptPatch,
	effectiveContextMessages,
} from "../conversation/agent-loop.js"
import type { SendOptions } from "../conversation/agent-loop.js"
import { ConversationBusyError } from "../conversation/agent-loop.js"
import type {
	BHZAIConversationImpl,
	CreateConversationOptions,
} from "../conversation/conversation.js"
import { createMessage, withMessageFields } from "../conversation/message.js"
import { computePreContextSystemPrompt, ensureStarted } from "../conversation/system-prompt.js"
import { createThinkSplitter } from "../conversation/think-stream.js"
import type { BHZAI } from "../core/bhzai.js"
import { parseModelRef } from "../core/models.js"
import { DEFAULT_RETRY_POLICY, callDriverWithRetry } from "../core/retry.js"
import type { RequestDispatch, RequestEventPayload, RetryPolicy } from "../core/retry.js"
import type { CallToolResult, ContentBlock } from "../types/content.js"
import type { BHZAIDriver, ChatRequest, DriverEvent, ToolWireDefinition } from "../types/driver.js"
import type { BHZAIToolDefinition } from "../types/index.js"
import type { BHZAIMessage, ToolCallRecord } from "../types/message.js"
import type { DriverCapabilities } from "../types/model.js"
import { resolveAvailableTools } from "./availability.js"
import { normalizeToolResult } from "./registry.js"

// ---------------------------------------------------------------------------
// 0. Shared utilities
// ---------------------------------------------------------------------------

/**
 * Construct a `BHZAIMessage` from a string or ContentBlock array.
 *
 * Internal helper used by multiple agent-loop helpers — equivalent to the
 * `constructMessage` function in `agent-loop.ts`.
 *
 * @internal
 */
function constructMessage(
	content: string | ContentBlock[],
	role: "user" | "assistant" | "system" | "tool",
	conversation: BHZAIConversationImpl,
): BHZAIMessage {
	return createMessage({ role, content }, conversation._getBh()._getMessageFields())
}

// ---------------------------------------------------------------------------
// 1. Busy-check / queue routing
// ---------------------------------------------------------------------------

/**
 * Entry-point busy check for `sendMessage`.
 *
 * If the conversation is not idle:
 * - `deliverAs: "immediate"` (default) → throws `ConversationBusyError`.
 * - `deliverAs: "steer"` → queues onto the steer queue, returns a promise.
 * - `deliverAs: "followUp"` → queues onto the followUp queue, returns a promise.
 *
 * If the conversation IS idle, returns `undefined` to signal "proceed with the
 * loop".
 *
 * @param conversation The conversation being sent to.
 * @param content User message content.
 * @param options Delivery options (contains `deliverAs`).
 * @returns A promise that resolves with the assistant response (if queued),
 *          or `undefined` if the caller should proceed with the loop.
 *
 * @internal
 */
export function handleBusyEntry(
	conversation: BHZAIConversationImpl,
	content: string | ContentBlock[],
	options?: SendOptions,
): Promise<BHZAIMessage> | undefined {
	if (conversation.status === "idle") {
		return undefined
	}

	const deliverAs = options?.deliverAs ?? "immediate"
	if (deliverAs === "immediate") {
		throw new ConversationBusyError(
			`Conversation is busy (status: ${conversation.status}); use deliverAs: "steer" or "followUp", or wait for idle.`,
		)
	}

	return new Promise<BHZAIMessage>((resolve, reject) => {
		if (deliverAs === "steer") {
			conversation._pushSteerQueue({ content, resolve, reject })
		} else {
			conversation._pushFollowUpQueue({ content, resolve, reject })
		}
	})
}

// ---------------------------------------------------------------------------
// 2. Driver / model resolution
// ---------------------------------------------------------------------------

/**
 * Result of resolving the driver for a single turn.
 *
 * @internal
 */
export interface ResolvedDriver {
	driver: BHZAIDriver
	parsed: { driver: string; id: string }
	driverCapabilities: DriverCapabilities
}

/**
 * Resolve the model ref, parse it, look up the driver, and read capabilities
 * for the current turn.
 *
 * Throws if the conversation has no model, the ref is malformed, or the driver
 * is not found.
 *
 * @param conversation The active conversation.
 * @param bh The BHZAI kernel.
 * @returns Resolved driver, parsed ref, and capabilities.
 *
 * @internal
 */
export function resolveDriverForTurn(
	conversation: BHZAIConversationImpl,
	bh: BHZAI,
): ResolvedDriver {
	const modelRef = conversation._getModelRef()
	if (!modelRef) {
		throw new Error(
			"sendMessage(): conversation has no resolved model — did you forget to set a model?",
		)
	}

	const parsed = parseModelRef(modelRef)
	if (!parsed) {
		throw new Error(`sendMessage(): invalid model ref "${modelRef}" — not in 'driver/model' format`)
	}

	const driver = bh._getDriver(parsed.driver)
	if (!driver) {
		throw new Error(`sendMessage(): driver "${parsed.driver}" not found`)
	}

	// Use the BARE model id (not the qualified ref) for capabilities lookup —
	// driver caches are keyed by the bare id (`entry.id` from `listModels()`).
	const driverCapabilities = driver.capabilities(parsed.id)

	return { driver, parsed, driverCapabilities }
}

// ---------------------------------------------------------------------------
// 3. Tool-call recording on assistant message
// ---------------------------------------------------------------------------

/**
 * Extract `tool-call` events from the buffer and record them on the assistant
 * message's `meta.toolCalls` as plain-JSON `ToolCallRecord` objects.
 *
 * This is done so the message list (which the driver sees on the next turn)
 * carries the tool-call records — providers like OpenAI validate that a
 * `role: 'tool'` message is preceded by an assistant message advertising the
 * matching `tool_call_id`.
 *
 * If no tool-call events are in the buffer, `meta.toolCalls` is left unset.
 *
 * @param assistantMessage The assistant message to record onto.
 * @param toolCallBuffer The buffered DriverEvents from this turn.
 *
 * @internal
 */
export function recordToolCallsOnMessage(
	assistantMessage: BHZAIMessage,
	toolCallBuffer: DriverEvent[],
): void {
	const producedToolCalls = toolCallBuffer.filter((e) => e.type === "tool-call") as Array<{
		type: "tool-call"
		toolCallId: string
		name: string
		input: unknown
	}>

	if (producedToolCalls.length === 0) {
		return
	}

	assistantMessage.meta.toolCalls = producedToolCalls.map(
		(call): ToolCallRecord => ({
			id: call.toolCallId,
			name: call.name,
			arguments: typeof call.input === "string" ? call.input : JSON.stringify(call.input),
		}),
	)
}

// ---------------------------------------------------------------------------
// 4. Driver event stream consumption
// ---------------------------------------------------------------------------

/**
 * Result of consuming a driver event stream for one turn.
 *
 * @internal
 */
export interface ConsumeStreamResult {
	/** The `stopReason` from the driver's `done` event, or `undefined` if none. */
	stopReason: string | undefined
	/** True if the driver stopped for a non-tool-calls reason (natural termination). */
	naturalStop: boolean
	/** Buffered tool-call events for later execution. */
	toolCallBuffer: DriverEvent[]
}

/**
 * Consume a driver's async iterable of `DriverEvent`s, dispatching deltas,
 * reasoning, and usage events onto the conversation bus, and buffering
 * tool-call events.
 *
 * Handles:
 * - `delta` → append to assistant message, dispatch `message.delta` (with
 *   think-splitting if `parseThink` is enabled).
 * - `reasoning-delta` → accumulate on `meta.reasoning`, dispatch `message.delta`.
 * - `usage` → call `conversation._recordTurnUsage`.
 * - `tool-call-delta` / `tool-call` → buffer for later execution.
 * - `done` → record `stopReason`, set `naturalStop` if not tool-calls, break.
 *
 * If `turnTimeoutMs` is set, a timer is started; if it fires before the stream
 * ends, event consumption stops (the loop treats this as a natural stop).
 *
 * @param conversation The active conversation.
 * @param driverIter The driver's async iterable of events.
 * @param assistantMessage The assistant message being built this turn.
 * @param parseThink Whether to split `<dim_tokens>` tags from deltas.
 * @param turnTimeoutMs Optional per-turn timeout in milliseconds.
 * @returns See {@link ConsumeStreamResult}.
 *
 * @internal
 */
export async function consumeDriverStream(
	conversation: BHZAIConversationImpl,
	driverIter: AsyncIterable<DriverEvent>,
	assistantMessage: BHZAIMessage,
	parseThink: boolean,
	turnTimeoutMs?: number,
): Promise<ConsumeStreamResult> {
	const toolCallBuffer: DriverEvent[] = []
	const thinkSplitter = parseThink ? createThinkSplitter() : undefined

	let timeoutHandle: ReturnType<typeof setTimeout> | undefined
	let timeoutFired = false
	if (turnTimeoutMs !== undefined) {
		timeoutHandle = setTimeout(() => {
			timeoutFired = true
		}, turnTimeoutMs)
	}

	let stopReason: string | undefined
	let naturalStop = false

	for await (const event of driverIter) {
		if (timeoutFired) {
			break
		}

		if (event.type === "delta") {
			if (thinkSplitter) {
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
			conversation._recordTurnUsage(event.inputTokens, event.outputTokens, event.totalTokens)
		} else if (event.type === "tool-call-delta" || event.type === "tool-call") {
			toolCallBuffer.push(event)
		} else if (event.type === "done") {
			stopReason = event.stopReason
			if (stopReason !== "tool-calls") {
				naturalStop = true
			}
			break
		}
	}

	if (timeoutHandle) {
		clearTimeout(timeoutHandle)
	}

	return { stopReason, naturalStop, toolCallBuffer }
}

// ---------------------------------------------------------------------------
// 5. Auto-compaction check
// ---------------------------------------------------------------------------

/**
 * Check whether auto-compaction should fire after a turn, and trigger it in
 * the background if so.
 *
 * Conditions (all must be true):
 * 1. `compaction.auto` is set in the conversation's create options.
 * 2. The conversation has a resolved model ref.
 * 3. The driver reports a `contextWindow`.
 * 4. The remaining tokens (`contextWindow - contextSize`) are less than
 *    `compaction.reserveTokens`.
 *
 * `contextSize` uses `contextUsage.lastInputTokens` (the real context size from
 * the last turn) with a fallback to cumulative `usage.inputTokens` for drivers
 * that don't report per-turn usage.
 *
 * Compaction runs via `void compactAuto(conversation)` — fire-and-forget, does
 * not block the turn.
 *
 * @param conversation The active conversation.
 *
 * @internal
 */
export async function maybeAutoCompact(conversation: BHZAIConversationImpl): Promise<void> {
	const createOpts = conversation._getCreateOptions()
	if (!createOpts.compaction?.auto) {
		return
	}

	const modelRef = conversation._getModelRef()
	if (!modelRef) {
		return
	}

	const bh = conversation._getBh()
	const parsedRef = parseModelRef(modelRef)
	if (!parsedRef) {
		return
	}

	const driver = bh._getDriver(parsedRef.driver)
	if (!driver) {
		return
	}

	const caps = driver.capabilities(parsedRef.id)
	if (caps.contextWindow === undefined) {
		return
	}

	const contextSize = conversation.contextUsage.lastInputTokens ?? conversation.usage.inputTokens
	const remainingTokens = caps.contextWindow - contextSize

	if (remainingTokens < createOpts.compaction.reserveTokens) {
		const { compactAuto } = await import("../conversation/compaction.js")
		void compactAuto(conversation)
	}
}

// ---------------------------------------------------------------------------
// 6. Turn termination check
// ---------------------------------------------------------------------------

/**
 * Result of checking turn termination.
 *
 * @internal
 */
export interface TerminationCheckResult {
	/** True if the loop should break (stop iterating). */
	shouldBreak: boolean
	/** If set, a `turn(end)` veto injected a continuation message; loop back. */
	continueWith: string | undefined
}

/**
 * Fire `turn(end)` and check termination conditions for this iteration.
 *
 * Termination logic:
 * 1. Fire `turn(end)` with the assistant message and tool results.
 * 2. Check for a `continueWith` patch (veto) — if present, return
 *    `{ shouldBreak: false, continueWith }` so the caller injects a synthetic
 *    message and loops back.
 * 3. If `naturalStop` is true or all tool results carry
 *    `BHZAI/terminate: true`, return `{ shouldBreak: true, continueWith: undefined }`.
 * 4. Otherwise, return `{ shouldBreak: false, continueWith: undefined }` (tool
 *    calls were made, no terminate hint — loop back).
 *
 * @param conversation The active conversation.
 * @param iteration The current iteration number (0-based).
 * @param naturalStop True if the driver stopped for a non-tool-calls reason.
 * @param toolResults The tool results from this turn (may be empty).
 * @param assistantMessage The assistant message produced this turn.
 * @returns See {@link TerminationCheckResult}.
 *
 * @internal
 */
export async function checkTurnTermination(
	conversation: BHZAIConversationImpl,
	iteration: number,
	naturalStop: boolean,
	toolResults: CallToolResult[],
	assistantMessage: BHZAIMessage,
): Promise<TerminationCheckResult> {
	// Fire turn(end) event for this iteration.
	const turnEndResult = await conversation._dispatchConversationEvent("turn", {
		state: "end" as const,
		turn: iteration,
		messages: [assistantMessage],
		toolResults,
		conversation,
	} as unknown)

	// Check for turn(end) veto via continueWith.
	const continueWith = (turnEndResult.patch as Record<string, unknown> | undefined)?.continueWith as
		| string
		| undefined
	if (continueWith) {
		return { shouldBreak: false, continueWith }
	}

	// Check if all tool results carry the terminate hint.
	const allTerminate =
		toolResults.length > 0 && toolResults.every((r) => r._meta?.["BHZAI/terminate"] === true)

	if (naturalStop || allTerminate) {
		return { shouldBreak: true, continueWith: undefined }
	}

	return { shouldBreak: false, continueWith: undefined }
}

// ---------------------------------------------------------------------------
// 7. Post-loop exit handling
// ---------------------------------------------------------------------------

/**
 * Handle the post-loop exit sequence: abort check, `loop(end)`, followUp/idle
 * transition.
 *
 * 1. If the conversation was aborted, return the last assistant message (or a
 *    synthetic empty one) with `meta.aborted = true`.
 * 2. Fire `loop(end)` unconditionally.
 * 3. Check for queued followUp messages:
 *    - If a followUp (or steer entries) exist, set status to idle and kick off
 *      the followUp's own run in the background (fire-and-forget). Do NOT fire
 *      `idle` — a new run is starting.
 *    - If both queues are empty, set status to idle and fire the `idle` event.
 * 4. Return the last assistant message (or a synthetic empty one).
 *
 * @param conversation The active conversation.
 * @param lastAssistantMessage The last assistant message from the loop, or undefined.
 * @param constructSynthetic Helper to construct a fallback empty assistant message.
 * @returns The final message to return to the caller.
 *
 * @internal
 */
export async function handleLoopExit(
	conversation: BHZAIConversationImpl,
	lastAssistantMessage: BHZAIMessage | undefined,
	constructSynthetic: () => BHZAIMessage,
): Promise<BHZAIMessage> {
	// If aborted, return with aborted flag.
	if (conversation._getAbortSignal().aborted) {
		const resultMsg = lastAssistantMessage ?? constructSynthetic()
		resultMsg.meta.aborted = true
		return resultMsg
	}

	// Fire loop(end) unconditionally.
	await conversation._dispatchConversationEvent("loop", {
		state: "end" as const,
		messages: conversation.messages,
		usage: conversation.usage,
	})

	// Check for queued followUp messages before transitioning to idle.
	const nextFollowUp = conversation._dequeueOneFollowUp()
	if (nextFollowUp || conversation._getSteerQueueLength() > 0) {
		// Do NOT fire idle — a new run is starting.
		conversation._setStatus("idle")
		if (nextFollowUp) {
			// Kick off the followUp's own run in the background.
			// Lazy-import sendMessage to avoid a circular dependency at module load.
			const { sendMessage } = await import("../conversation/agent-loop.js")
			void sendMessage(conversation, nextFollowUp.content, { deliverAs: "immediate" })
				.then((msg) => nextFollowUp.resolve(msg))
				.catch((err) => nextFollowUp.reject(err))
		}
	} else {
		// Both queues empty: transition to idle and fire idle event.
		conversation._setStatus("idle")
		await conversation._dispatchConversationEvent("idle", { conversation })
	}

	return lastAssistantMessage ?? constructSynthetic()
}

// ---------------------------------------------------------------------------
// 8. Termination condition helpers (pure logic)
// ---------------------------------------------------------------------------

/**
 * Check if the loop should break due to the `maxIterations` bound.
 *
 * If the bound is reached and a `lastAssistantMessage` exists, it is flagged
 * with `meta.truncatedBy = "max-iterations"` (the mutation carve-out from
 * TASK_0027).
 *
 * @param iteration The current iteration (0-based).
 * @param maxIterations The maximum number of iterations.
 * @param lastAssistantMessage The last assistant message, or undefined.
 * @returns True if the loop should break.
 *
 * @internal
 */
export function checkMaxIterations(
	iteration: number,
	maxIterations: number,
	lastAssistantMessage: BHZAIMessage | undefined,
): boolean {
	if (iteration >= maxIterations) {
		if (lastAssistantMessage) {
			lastAssistantMessage.meta.truncatedBy = "max-iterations"
		}
		return true
	}
	return false
}

/**
 * Check if all tool results carry the `BHZAI/terminate: true` hint.
 *
 * A strict "every" check: returns `false` if the array is empty (no tool
 * results means no terminate signal).
 *
 * @param toolResults The tool results from this turn.
 * @returns True if every result has `_meta['BHZAI/terminate'] === true`.
 *
 * @internal
 */
export function isAllTerminate(toolResults: CallToolResult[]): boolean {
	return toolResults.length > 0 && toolResults.every((r) => r._meta?.["BHZAI/terminate"] === true)
}

// ---------------------------------------------------------------------------
// 9. User message preparation (sendMessage steps 2-5)
// ---------------------------------------------------------------------------

/**
 * Prepare the user message: ensureStarted, fire `loop(start)`, fire
 * `message(before)` (blockable), handle blocked result, apply patches, append
 * message, fire `message(waiting)`, set status to streaming.
 *
 * @param conversation The active conversation.
 * @param bh The BHZAI kernel.
 * @param createOptions The conversation's create options.
 * @param userMessage The constructed user message.
 * @returns A blocked `BHZAIMessage` if `message(before)` blocked, or
 *          `undefined` if the caller should proceed to the agent loop.
 *
 * @internal
 */
export async function prepareUserMessage(
	conversation: BHZAIConversationImpl,
	bh: BHZAI,
	createOptions: CreateConversationOptions,
	userMessage: BHZAIMessage,
): Promise<BHZAIMessage | undefined> {
	// Step 2: Ensure the conversation has been started.
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

	// Step 5: Apply patches, append message, fire message(waiting), set streaming.
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
	return undefined
}

// ---------------------------------------------------------------------------
// 10. Steer queue draining
// ---------------------------------------------------------------------------

/**
 * Steer queue entry type (matches the conversation's internal queue shape).
 *
 * @internal
 */
export interface SteerEntry {
	content: string | ContentBlock[]
	resolve: (msg: BHZAIMessage) => void
	reject: (err: unknown) => void
}

/**
 * Drain the steer queue at the top of a loop iteration.
 *
 * For each queued steer message:
 * - Fire `message(before)` (blockable).
 * - If blocked, settle the entry's promise with a blocked message.
 * - If not blocked, apply patches, append to history, and return the entry
 *   for later resolution (after this turn's assistant response).
 *
 * @param conversation The active conversation.
 * @returns Entries that were NOT blocked — to be resolved after the turn.
 *
 * @internal
 */
export async function drainSteerQueue(conversation: BHZAIConversationImpl): Promise<SteerEntry[]> {
	const steerEntries = conversation._drainSteerQueue()
	const pending: SteerEntry[] = []

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
			entry.resolve({
				...steerMessage,
				meta: {
					...steerMessage.meta,
					blocked: true,
					blockedReason: beforeResult.reason,
				},
			})
		} else {
			const patchedMessage = { ...steerMessage, ...beforeResult.patch }
			conversation._pushMessage(patchedMessage)
			pending.push(entry)
		}
	}

	return pending
}

// ---------------------------------------------------------------------------
// 11. Context building for a turn
// ---------------------------------------------------------------------------

/**
 * Result of building the context for a single turn.
 *
 * @internal
 */
export interface BuiltContext {
	effectiveMessages: BHZAIMessage[]
	effectiveSystemPrompt: string
	advertisedTools: BHZAIToolDefinition[]
	toolWireDefinitions: ToolWireDefinition[]
}

/**
 * Build the context for a single turn: construct the context payload, fire the
 * `context` event (non-blockable, observe-and-patch), apply patches, resolve
 * available tools with driver-capability gating, and project tools to wire
 * format.
 *
 * @param conversation The active conversation.
 * @param bh The BHZAI kernel.
 * @param driverCapabilities The resolved driver capabilities for this turn.
 * @returns The effective messages, system prompt, advertised tools, and wire definitions.
 *
 * @internal
 */
export async function buildContextForTurn(
	conversation: BHZAIConversationImpl,
	bh: BHZAI,
	driverCapabilities: DriverCapabilities,
): Promise<BuiltContext> {
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

	return { effectiveMessages, effectiveSystemPrompt, advertisedTools, toolWireDefinitions }
}

// ---------------------------------------------------------------------------
// 12. Context budget application (pre-flight check)
// ---------------------------------------------------------------------------

/**
 * Apply the pre-flight context-window check to the effective messages.
 *
 * If the driver reports a `contextWindow`:
 * 1. Run `fitContextToWindow` to check if the request fits.
 * 2. If trimming is needed and auto-compaction is enabled, trigger compaction
 *    first, then re-check.
 * 3. If still over limit, use the trimmed messages.
 * 4. If even a single user message doesn't fit, trigger prompt compaction.
 *
 * If the driver does NOT report a `contextWindow`, returns the messages
 * unchanged.
 *
 * @param conversation The active conversation.
 * @param driverCapabilities The resolved driver capabilities.
 * @param effectiveMessages The messages from `buildContextForTurn`.
 * @param effectiveSystemPrompt The system prompt from `buildContextForTurn`.
 * @param toolWireDefinitions The tool wire definitions from `buildContextForTurn`.
 * @returns The final messages to send to the driver.
 *
 * @internal
 */
export async function applyContextBudget(
	conversation: BHZAIConversationImpl,
	driverCapabilities: DriverCapabilities,
	effectiveMessages: BHZAIMessage[],
	effectiveSystemPrompt: string,
	toolWireDefinitions: ToolWireDefinition[],
): Promise<BHZAIMessage[]> {
	if (driverCapabilities.contextWindow === undefined) {
		return effectiveMessages
	}

	const createOpts = conversation._getCreateOptions()
	const outputReserve = createOpts.outputReserve ?? createOpts.compaction?.reserveTokens ?? 1024
	const { fitContextToWindow } = await import("../conversation/context-budget.js")

	let finalMessages = effectiveMessages
	let fitResult = fitContextToWindow({
		messages: finalMessages,
		systemPrompt: effectiveSystemPrompt,
		tools: toolWireDefinitions,
		contextWindow: driverCapabilities.contextWindow,
		outputReserve,
		lastInputTokens: conversation.contextUsage.lastInputTokens,
	})

	// If trimming is needed and compaction is available, trigger it first.
	if (fitResult.trimmed && createOpts.compaction?.auto) {
		const { compactAuto } = await import("../conversation/compaction.js")
		await compactAuto(conversation)
		finalMessages = effectiveContextMessages(conversation)
		fitResult = fitContextToWindow({
			messages: finalMessages,
			systemPrompt: effectiveSystemPrompt,
			tools: toolWireDefinitions,
			contextWindow: driverCapabilities.contextWindow,
			outputReserve,
			lastInputTokens: conversation.contextUsage.lastInputTokens,
		})
	}

	if (fitResult.trimmed) {
		finalMessages = fitResult.messages
	}

	// If even a single user message doesn't fit, trigger prompt compaction.
	if (fitResult.overLimit && createOpts.promptCompaction !== false) {
		const { compactPrompt } = await import("../conversation/prompt-compaction.js")
		const lastUserMsg = [...finalMessages].reverse().find((m) => m.role === "user")
		if (lastUserMsg) {
			const compacted = await compactPrompt(
				conversation,
				lastUserMsg,
				fitResult.estimatedTokens,
				driverCapabilities.contextWindow - outputReserve,
			)
			if (compacted) {
				finalMessages = finalMessages.map((m) => (m.id === lastUserMsg.id ? compacted : m))
				fitResult = fitContextToWindow({
					messages: finalMessages,
					systemPrompt: effectiveSystemPrompt,
					tools: toolWireDefinitions,
					contextWindow: driverCapabilities.contextWindow,
					outputReserve,
					lastInputTokens: conversation.contextUsage.lastInputTokens,
				})
				if (!fitResult.overLimit) {
					finalMessages = fitResult.messages
				}
			}
		}
	}

	return finalMessages
}

// ---------------------------------------------------------------------------
// 13. Execute one driver turn
// ---------------------------------------------------------------------------

/**
 * Result of executing one driver turn.
 *
 * @internal
 */
export interface DriverTurnResult {
	assistantMessage: BHZAIMessage
	stopReason: string | undefined
	naturalStop: boolean
	toolCallBuffer: DriverEvent[]
}

/**
 * Execute one driver turn: build the `ChatRequest`, create the assistant
 * message, call the driver via the retry wrapper, consume the event stream,
 * record tool calls on the message, push it to history, and fire
 * `message(sent)`.
 *
 * @param conversation The active conversation.
 * @param driver The resolved driver.
 * @param parsed The parsed model ref (`{ driver, id }`).
 * @param finalMessages The messages to send (after context budget).
 * @param effectiveSystemPrompt The system prompt for this turn.
 * @param toolWireDefinitions The tool wire definitions for this turn.
 * @param retryPolicy The retry policy.
 * @param parseThink Whether to split think tags.
 * @param turnTimeoutMs Optional per-turn timeout.
 * @returns See {@link DriverTurnResult}.
 *
 * @internal
 */
export async function executeDriverTurn(
	conversation: BHZAIConversationImpl,
	driver: BHZAIDriver,
	parsed: { driver: string; id: string },
	finalMessages: BHZAIMessage[],
	effectiveSystemPrompt: string,
	toolWireDefinitions: ToolWireDefinition[],
	retryPolicy: RetryPolicy,
	parseThink: boolean,
	turnTimeoutMs?: number,
): Promise<DriverTurnResult> {
	// Build ChatRequest — model is the BARE model id (not the qualified ref).
	const chatRequest: ChatRequest = {
		model: parsed.id,
		messages: finalMessages,
		systemPrompt: effectiveSystemPrompt,
		tools: toolWireDefinitions.length > 0 ? toolWireDefinitions : undefined,
		signal: conversation._getAbortSignal(),
	}

	// Create a new assistant message for this turn.
	const assistantMessage = constructMessage("", "assistant", conversation)

	// Fire request(before) via dispatch wrapper for retry logic.
	const requestDispatch: RequestDispatch = async (
		event: "request",
		payload: RequestEventPayload,
		options?: { blockable?: boolean },
	) => {
		return conversation._dispatchConversationEvent<RequestEventPayload>(event, payload, options)
	}

	// Call the driver via the retry wrapper.
	const driverCallPromise = callDriverWithRetry(driver, chatRequest, retryPolicy, requestDispatch)

	// Consume driver events.
	const { stopReason, naturalStop, toolCallBuffer } = await consumeDriverStream(
		conversation,
		driverCallPromise,
		assistantMessage,
		parseThink,
		turnTimeoutMs,
	)

	// Record tool calls on the assistant message.
	recordToolCallsOnMessage(assistantMessage, toolCallBuffer)

	// Finalize: push to history and fire message(sent).
	conversation._pushMessage(assistantMessage)

	await conversation._dispatchConversationEvent("message", {
		conversationId: conversation.id,
		messageId: assistantMessage.id,
		role: "assistant",
		message: assistantMessage,
		time: Date.now(),
		state: "sent" as const,
		conversation,
	})

	return { assistantMessage, stopReason, naturalStop, toolCallBuffer }
}

// ---------------------------------------------------------------------------
// 14. Turn veto handling
// ---------------------------------------------------------------------------

/**
 * Inject a synthetic follow-up message from a `turn(end)` veto
 * (`continueWith` patch). The message is marked `meta.synthetic` and
 * `meta.contextIncluded = true` so it enters the next iteration's context.
 *
 * @param conversation The active conversation.
 * @param continueWith The veto continuation text.
 *
 * @internal
 */
export function handleTurnVeto(conversation: BHZAIConversationImpl, continueWith: string): void {
	const syntheticMessage = constructMessage(continueWith, "user", conversation)
	syntheticMessage.meta.synthetic = "turn-veto-continuation"
	syntheticMessage.meta.contextIncluded = true
	conversation._pushMessage(syntheticMessage)
}

// ---------------------------------------------------------------------------
// 15. Resolve pending steer entries
// ---------------------------------------------------------------------------

/**
 * Resolve all pending steer entries with this turn's assistant message.
 *
 * Per the design doc, "processed" means "the iteration that included it in
 * context produced its assistant response" — which is right here after
 * `message(sent)`.
 *
 * @param pendingSteerResolutions The entries to resolve.
 * @param assistantMessage The assistant message to resolve them with.
 *
 * @internal
 */
export function resolvePendingSteers(
	pendingSteerResolutions: SteerEntry[],
	assistantMessage: BHZAIMessage,
): void {
	for (const entry of pendingSteerResolutions) {
		entry.resolve(assistantMessage)
	}
}

// ---------------------------------------------------------------------------
// 16. Fire turn(start) event
// ---------------------------------------------------------------------------

/**
 * Fire the `turn(start)` event for a given iteration.
 *
 * @param conversation The active conversation.
 * @param iteration The current iteration number (0-based).
 *
 * @internal
 */
export async function fireTurnStart(
	conversation: BHZAIConversationImpl,
	iteration: number,
): Promise<void> {
	await conversation._dispatchConversationEvent("turn", {
		state: "start" as const,
		turn: iteration,
		messages: undefined,
		toolResults: undefined,
		conversation,
	} as unknown)
}

// ---------------------------------------------------------------------------
// 18. Tool-call extraction (pure logic)
// ---------------------------------------------------------------------------

/** A filtered `tool-call` event from the driver stream. @internal */
export interface ToolCallEvent {
	toolCallId: string
	name: string
	input: unknown
}

/**
 * Filter `tool-call` events from a `DriverEvent` buffer, in emission order.
 *
 * @param toolCallBuffer The buffered DriverEvents from this turn.
 * @returns Filtered tool-call events (empty if none).
 *
 * @internal
 */
export function filterToolCalls(toolCallBuffer: DriverEvent[]): ToolCallEvent[] {
	return toolCallBuffer
		.filter((e) => e.type === "tool-call")
		.map((e) => {
			const tc = e as { type: "tool-call"; toolCallId: string; name: string; input: unknown }
			return { toolCallId: tc.toolCallId, name: tc.name, input: tc.input }
		})
}

// ---------------------------------------------------------------------------
// 19. Tool-call partitioning (pure logic)
// ---------------------------------------------------------------------------

/** Result of partitioning tool calls into serial and concurrent. @internal */
export interface PartitionedToolCalls {
	serial: ToolCallEvent[]
	concurrent: ToolCallEvent[]
}

/**
 * Partition tool calls into serial and concurrent batches.
 *
 * A call is serial if `serialTools` is globally enabled OR the tool definition
 * has `serial: true`. All others are concurrent.
 *
 * @param toolCalls The filtered tool-call events.
 * @param bh The BHZAI kernel (for tool definition lookups).
 * @param serialTools Whether all tools should run serially (global flag).
 * @returns Partitioned serial and concurrent arrays.
 *
 * @internal
 */
export function partitionToolCalls(
	toolCalls: ToolCallEvent[],
	bh: BHZAI,
	serialTools: boolean,
): PartitionedToolCalls {
	const serial: ToolCallEvent[] = []
	const concurrent: ToolCallEvent[] = []

	for (const call of toolCalls) {
		const toolDef = bh._getTool(call.name)
		if (serialTools || (toolDef?.serial ?? false)) {
			serial.push(call)
		} else {
			concurrent.push(call)
		}
	}

	return { serial, concurrent }
}

// ---------------------------------------------------------------------------
// 20. Tool-call validation + repair
// ---------------------------------------------------------------------------

/** Mutable repair counter shared across all calls in a batch. @internal */
export interface RepairCounter {
	count: number
}

/** Result of validating a single tool call. @internal */
export interface ValidationResult {
	/** `undefined` if the call passed validation; otherwise the repair error result. */
	result: CallToolResult | undefined
}

/**
 * Validate a tool call: check the tool exists, is advertised, and its input
 * matches the tool's `inputSchema`.
 *
 * If validation fails, returns a `CallToolResult` with `isError: true` and a
 * repair message (respecting the `maxToolRepairs` limit). If validation passes,
 * returns `{ result: undefined }`. The `repairCounter` is mutated in place to
 * reflect any repair issued — this preserves the shared-state semantics of the
 * original closure variable across concurrent calls.
 *
 * @param call The tool-call event to validate.
 * @param toolDef The tool definition (or undefined if not registered).
 * @param advertisedToolNames Set of tool names that were offered to the model.
 * @param ajv An Ajv instance for schema validation.
 * @param maxToolRepairs Maximum repair messages per turn.
 * @param repairCounter Mutable counter shared across the batch.
 * @returns See {@link ValidationResult}.
 *
 * @internal
 */
export function validateToolCall(
	call: ToolCallEvent,
	toolDef: BHZAIToolDefinition | undefined,
	advertisedToolNames: Set<string>,
	ajv: Ajv,
	maxToolRepairs: number,
	repairCounter: RepairCounter,
): ValidationResult {
	// Step 1: Check tool exists and was advertised.
	if (!toolDef || !advertisedToolNames.has(call.name)) {
		const reason = !toolDef ? `Unknown tool "${call.name}"` : `Tool "${call.name}" not offered`
		const repairMsg =
			repairCounter.count < maxToolRepairs
				? `${reason}. Please correct and retry.`
				: `Tool call repair limit (${maxToolRepairs}) exceeded for this turn; this call will not be retried further.`
		repairCounter.count++
		return { result: { content: [{ type: "text", text: repairMsg }], isError: true } }
	}

	// Step 2: Validate input against inputSchema.
	const validate = ajv.compile(toolDef.inputSchema)
	if (!validate(call.input)) {
		const schemaErrors = validate.errors
			?.map((e) => `${e.instancePath || "root"} ${e.message}`)
			.join("; ")
		const reason = `Argument validation failed: ${schemaErrors || "unknown error"}`
		const repairMsg =
			repairCounter.count < maxToolRepairs
				? `${reason}. Please correct and retry.`
				: `Tool call repair limit (${maxToolRepairs}) exceeded for this turn; this call will not be retried further.`
		repairCounter.count++
		return { result: { content: [{ type: "text", text: repairMsg }], isError: true } }
	}

	return { result: undefined }
}

// ---------------------------------------------------------------------------
// 21. Tool execution with abort race
// ---------------------------------------------------------------------------

/**
 * Execute a single tool call, racing `execute()` against the conversation's
 * abort signal. Returns a normalized `CallToolResult`.
 *
 * If the tool throws or the abort signal fires, a synthetic error result is
 * returned (never throws).
 *
 * @param toolDef The tool definition (with `execute` binding).
 * @param conversation The active conversation.
 * @param call The tool-call event.
 * @returns The normalized result of the tool execution.
 *
 * @internal
 */
export async function executeToolWithAbortRace(
	toolDef: BHZAIToolDefinition,
	conversation: BHZAIConversationImpl,
	call: ToolCallEvent,
): Promise<CallToolResult> {
	try {
		const abortSignal = conversation._getAbortSignal()
		const executePromise = toolDef.execute({
			conversation,
			params: call.input,
			toolCallId: call.toolCallId,
			signal: abortSignal,
			progress: async (update) => {
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
				const abortListener = () => reject(new Error("Tool execution aborted"))
				abortSignal.addEventListener("abort", abortListener)
			}
		})

		const rawResult = await Promise.race([executePromise, abortPromise])
		return normalizeToolResult(rawResult)
	} catch (err) {
		return {
			content: [
				{
					type: "text",
					text: `Tool execution error: ${err instanceof Error ? err.message : String(err)}`,
				},
			],
			isError: true,
		}
	}
}

// ---------------------------------------------------------------------------
// 22. Apply complete-event rewrite patches
// ---------------------------------------------------------------------------

/**
 * Apply rewrite patches from the `tool(complete|error)` event to the
 * execution result.
 *
 * Patch precedence:
 * 1. `patch.response` → replace the result outright.
 * 2. `patch.isError` → override the `isError` flag on the existing result.
 * 3. No patch → return the result unchanged.
 *
 * @param executeResult The raw execution result.
 * @param patch The patch object from the complete event (may be undefined).
 * @returns The final result after applying patches.
 *
 * @internal
 */
export function applyCompleteEventPatch(
	executeResult: CallToolResult,
	patch: Record<string, unknown> | undefined,
): CallToolResult {
	if (patch?.response) {
		return patch.response as CallToolResult
	}
	if (patch?.isError !== undefined) {
		return { ...executeResult, isError: patch.isError as boolean }
	}
	return executeResult
}

// ---------------------------------------------------------------------------
// 23. Execute a single tool call (full pipeline)
// ---------------------------------------------------------------------------

/** Result of executing a single tool call. @internal */
export interface SingleCallResult {
	/** The final result (after patches), or undefined if not set. */
	result: CallToolResult | undefined
}

/**
 * Execute a single tool call through the full event pipeline:
 * validate → beforeCall (blockable) → call → execute (with abort race) →
 * complete|error (with rewrite patches).
 *
 * The `repairCounter` is mutated in place — this preserves the shared-state
 * semantics of the original closure variable across concurrent calls in a
 * batch.
 *
 * @param conversation The active conversation.
 * @param bh The BHZAI kernel.
 * @param call The tool-call event.
 * @param toolDef The tool definition (or undefined if not registered).
 * @param advertisedToolNames Set of advertised tool names.
 * @param ajv An Ajv instance.
 * @param maxToolRepairs Maximum repairs per turn.
 * @param repairCounter Mutable counter shared across the batch.
 * @returns See {@link SingleCallResult}.
 *
 * @internal
 */
export async function executeSingleToolCall(
	conversation: BHZAIConversationImpl,
	bh: BHZAI,
	call: ToolCallEvent,
	toolDef: BHZAIToolDefinition | undefined,
	advertisedToolNames: Set<string>,
	ajv: Ajv,
	maxToolRepairs: number,
	repairCounter: RepairCounter,
): Promise<SingleCallResult> {
	// Step 1: Validation.
	const validation = validateToolCall(
		call,
		toolDef,
		advertisedToolNames,
		ajv,
		maxToolRepairs,
		repairCounter,
	)
	if (validation.result) {
		return { result: validation.result }
	}

	// toolDef is guaranteed to exist here (validation passed).
	const tool = toolDef as BHZAIToolDefinition

	// Step 2: beforeCall event (blockable).
	const beforeCallResult = await conversation._dispatchConversationEvent(
		"tool",
		{
			conversationId: conversation.id,
			tool,
			toolCallId: call.toolCallId,
			input: call.input,
			time: Date.now(),
			state: "beforeCall" as const,
			conversation,
		} as unknown,
		{ blockable: true },
	)

	if (beforeCallResult.blocked) {
		const blockedResult: CallToolResult = {
			content: [{ type: "text", text: beforeCallResult.reason ?? "blocked by policy" }],
			isError: true,
		}
		// Fire tool(error) immediately (skip call/processing).
		await conversation._dispatchConversationEvent("tool", {
			conversationId: conversation.id,
			tool,
			toolCallId: call.toolCallId,
			input: call.input,
			time: Date.now(),
			state: "error" as const,
			response: blockedResult,
			conversation,
		} as unknown)
		return { result: blockedResult }
	}

	// Step 3: call event.
	await conversation._dispatchConversationEvent("tool", {
		conversationId: conversation.id,
		tool,
		toolCallId: call.toolCallId,
		input: call.input,
		time: Date.now(),
		state: "call" as const,
		conversation,
	} as unknown)

	// Step 4: execute with abort race.
	const executeResult = await executeToolWithAbortRace(tool, conversation, call)

	// Step 5: complete | error event (with rewrite-patch opportunity).
	const completeEvent = await conversation._dispatchConversationEvent("tool", {
		conversationId: conversation.id,
		tool,
		toolCallId: call.toolCallId,
		input: call.input,
		time: Date.now(),
		state: executeResult.isError ? ("error" as const) : ("complete" as const),
		response: executeResult,
		conversation,
	} as unknown)

	const finalResult = applyCompleteEventPatch(
		executeResult,
		completeEvent.patch as Record<string, unknown> | undefined,
	)
	return { result: finalResult }
}

// ---------------------------------------------------------------------------
// 24. Run tool batch with concurrency control
// ---------------------------------------------------------------------------

/**
 * Run a batch of tool calls with concurrency control.
 *
 * If `serialTools` is true, all calls run one-at-a-time in emitted order.
 * Otherwise, concurrent calls run in parallel (via `Promise.all`), then serial
 * calls run one-at-a-time.
 *
 * The `executeFn` callback handles each individual call and writes its result
 * into the `results` array at the correct index.
 *
 * @param toolCalls All tool calls in original order.
 * @param partitioned The partitioned serial/concurrent arrays.
 * @param serialTools Whether all tools should run serially.
 * @param executeFn Callback to execute a single call at a given index.
 * @returns The results array (indexed by original position).
 *
 * @internal
 */
export async function runToolBatchExecution(
	toolCalls: ToolCallEvent[],
	partitioned: PartitionedToolCalls,
	serialTools: boolean,
	executeFn: (originalIndex: number, call: ToolCallEvent) => Promise<void>,
): Promise<void> {
	if (serialTools) {
		// Force strict serialization — every call one-at-a-time in emitted order.
		for (let i = 0; i < toolCalls.length; i++) {
			await executeFn(i, toolCalls[i])
		}
	} else {
		// Run all concurrent-portion calls in parallel.
		await Promise.all(
			partitioned.concurrent.map((call) => {
				const originalIdx = toolCalls.indexOf(call)
				return executeFn(originalIdx, call)
			}),
		)

		// Then run serial-tagged calls one-at-a-time.
		for (const call of partitioned.serial) {
			const originalIdx = toolCalls.indexOf(call)
			await executeFn(originalIdx, call)
		}
	}
}

// ---------------------------------------------------------------------------
// 25. Append tool-result messages to history
// ---------------------------------------------------------------------------

/**
 * Append tool-result messages to the conversation history in original call
 * order, and return the settled results array.
 *
 * Each result is wrapped in a `role: 'tool'` message with `meta.toolCallId`,
 * `meta.toolName`, `meta.isError`, and `meta.contextIncluded: true`.
 *
 * @param results The results array (indexed by original position, may have holes).
 * @param toolCalls The original tool calls in emission order.
 * @param conversation The active conversation.
 * @returns The settled results in original call order.
 *
 * @internal
 */
export function appendToolResultMessages(
	results: (CallToolResult | undefined)[],
	toolCalls: ToolCallEvent[],
	conversation: BHZAIConversationImpl,
): CallToolResult[] {
	const settledResults: CallToolResult[] = []
	for (let i = 0; i < toolCalls.length; i++) {
		const result = results[i]
		if (result !== undefined) {
			const call = toolCalls[i]
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
	return settledResults
}
