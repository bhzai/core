/** @file Agent loop core — sendMessage, context event, message states (TASK_0025, TASK_0026, TASK_0027, TASK_0030) */

import Ajv from "ajv"
import type { BHZAI } from "../core/bhzai.js"
import { DEFAULT_RETRY_POLICY } from "../core/retry.js"
import type { SteerEntry, ToolCallEvent } from "../tools/agent-loop-helpers.js"
import {
	appendToolResultMessages,
	applyContextBudget,
	buildContextForTurn,
	checkMaxIterations,
	checkTurnTermination,
	drainSteerQueue,
	executeDriverTurn,
	executeSingleToolCall,
	filterToolCalls,
	fireTurnStart,
	handleBusyEntry,
	handleLoopExit,
	handleTurnVeto,
	maybeAutoCompact,
	partitionToolCalls,
	prepareUserMessage,
	resolveDriverForTurn,
	resolvePendingSteers,
	runToolBatchExecution,
} from "../tools/agent-loop-helpers.js"
import type { CallToolResult, ContentBlock } from "../types/content.js"
import type { DriverEvent } from "../types/driver.js"
import type { BHZAIToolDefinition } from "../types/index.js"
import type { BHZAIMessage, ConversationStatus } from "../types/message.js"
import type { BHZAIConversationImpl, CreateConversationOptions } from "./conversation.js"
import { createMessage, withMessageFields } from "./message.js"

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
 * Per TASK_0025/TASK_0026/TASK_0027, this implements the full bounded pipeline.
 * The orchestration is delegated to extracted, unit-testable helpers in
 * `src/tools/agent-loop-helpers.ts` — this function is the thin entry point.
 *
 * **Bounded termination conditions (TASK_0027 § 11.2)**:
 * - **Natural stop**: stopReason !== 'tool-calls' (driver produced no tool calls)
 * - **Universal terminate hint**: every tool result carries _meta['BHZAI/terminate']: true
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

	// Busy-check: throw, queue (steer/followUp), or proceed.
	const queuedResult = handleBusyEntry(conversation, content, options)
	if (queuedResult !== undefined) return queuedResult

	// Prepare the user message (ensureStarted, loop(start), message(before), patches, waiting).
	const userMessage = constructMessage(content, "user", conversation)
	const createOptions = conversation._getCreateOptions()
	const blocked = await prepareUserMessage(conversation, bh, createOptions, userMessage)
	if (blocked) return blocked

	// Run the bounded agent loop.
	return runAgentLoop(conversation, bh, createOptions)
}

/**
 * Run the bounded agent loop (TASK_0027).
 *
 * Each iteration: drain steer queue → fire `turn(start)` → resolve driver →
 * build context → apply context budget → execute driver turn → auto-compact →
 * resolve steers → execute tools → check termination. Delegates to extracted
 * helpers for each step.
 *
 * @param conversation The active conversation.
 * @param bh The BHZAI kernel.
 * @param createOptions The conversation's create options.
 * @returns The final assistant message (or aborted/blocked message).
 *
 * @internal
 */
async function runAgentLoop(
	conversation: BHZAIConversationImpl,
	bh: BHZAI,
	createOptions: CreateConversationOptions,
): Promise<BHZAIMessage> {
	const maxIterations = createOptions.maxIterations ?? 8
	const turnTimeoutMs = createOptions.turnTimeoutMs
	const parseThink = createOptions.parseThink ?? false
	const retryPolicy = createOptions.retryPolicy ?? DEFAULT_RETRY_POLICY

	let iteration = 0
	let lastAssistantMessage: BHZAIMessage | undefined
	let pendingSteerResolutions: SteerEntry[] = []

	while (true) {
		if (conversation._getAbortSignal().aborted) break
		if (checkMaxIterations(iteration, maxIterations, lastAssistantMessage)) break

		pendingSteerResolutions = await drainSteerQueue(conversation)
		await fireTurnStart(conversation, iteration)

		const { driver, parsed, driverCapabilities } = resolveDriverForTurn(conversation, bh)
		const ctx = await buildContextForTurn(conversation, bh, driverCapabilities)
		const finalMessages = await applyContextBudget(
			conversation,
			driverCapabilities,
			ctx.effectiveMessages,
			ctx.effectiveSystemPrompt,
			ctx.toolWireDefinitions,
		)

		const turn = await executeDriverTurn(
			conversation,
			driver,
			parsed,
			finalMessages,
			ctx.effectiveSystemPrompt,
			ctx.toolWireDefinitions,
			retryPolicy,
			parseThink,
			turnTimeoutMs,
		)

		await maybeAutoCompact(conversation)
		resolvePendingSteers(pendingSteerResolutions, turn.assistantMessage)
		pendingSteerResolutions = []

		let toolResults: CallToolResult[] = []
		if (turn.stopReason === "tool-calls") {
			toolResults = await executeToolBatch(
				conversation,
				bh,
				turn.toolCallBuffer,
				ctx.advertisedTools,
				iteration,
			)
		}

		const termination = await checkTurnTermination(
			conversation,
			iteration,
			turn.naturalStop,
			toolResults,
			turn.assistantMessage,
		)

		lastAssistantMessage = turn.assistantMessage

		if (termination.continueWith) {
			handleTurnVeto(conversation, termination.continueWith)
			iteration++
			continue
		}

		if (termination.shouldBreak) break
		iteration++
	}

	return handleLoopExit(conversation, lastAssistantMessage, () =>
		constructMessage("", "assistant", conversation),
	)
}

/**
 * Execute a batch of tool calls from one turn	)
}

/**
 * Execute a batch of tool calls from one turn (TASK_0026, TASK_0027).
 *
 * Thin orchestrator that delegates to extracted helpers in
 * `src/tools/agent-loop-helpers.ts`: `filterToolCalls`, `partitionToolCalls`,
 * `executeSingleToolCall`, `runToolBatchExecution`, `appendToolResultMessages`.
 *
 * @param conversation The active conversation.
 * @param bh The BHZAI kernel instance.
 * @param toolCallBuffer The buffered tool-call events from the driver.
 * @param advertisedTools The tools that were actually offered to the model.
 * @param turn The current turn number (for logging/debugging).
 * @returns Array of settled CallToolResult objects in original call order.
 * @internal
 */
async function executeToolBatch(
	conversation: BHZAIConversationImpl,
	bh: BHZAI,
	toolCallBuffer: DriverEvent[],
	advertisedTools: BHZAIToolDefinition[],
	_turn: number,
): Promise<CallToolResult[]> {
	const toolCalls = filterToolCalls(toolCallBuffer)
	if (toolCalls.length === 0) return []

	const createOptions = conversation._getCreateOptions()
	const serialTools = createOptions.serialTools ?? false
	const maxToolRepairs = createOptions.maxToolRepairs ?? 2
	const ajv = new Ajv()
	const advertisedToolNames = new Set(advertisedTools.map((t) => t.name))
	const partitioned = partitionToolCalls(toolCalls, bh, serialTools)

	const results: (CallToolResult | undefined)[] = new Array(toolCalls.length)
	const repairCounter = { count: 0 }

	await runToolBatchExecution(toolCalls, partitioned, serialTools, async (idx, call) => {
		const toolDef = bh._getTool(call.name)
		const single = await executeSingleToolCall(
			conversation,
			bh,
			call,
			toolDef,
			advertisedToolNames,
			ajv,
			maxToolRepairs,
			repairCounter,
		)
		results[idx] = single.result
	})

	return appendToolResultMessages(results, toolCalls, conversation)
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
