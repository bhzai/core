/** @file Compaction pipeline — context-window summarization and folding (TASK_0031) */

import type { EmitResult } from "../types/events.js"
import type { BHZAIMessage } from "../types/message.js"
import { effectiveContextMessages } from "./agent-loop.js"
import type { BHZAIConversationImpl } from "./conversation.js"
import { createMessage } from "./message.js"

/**
 * Options for conversation compaction (manual or via emit).
 *
 * Reserved for future extensibility. Currently empty but maintained as a
 * distinct type for forward compatibility with hosts that may extend it later.
 * @todo Extend with future options as needed.
 */
export type CompactOptions = Record<string, never>

/**
 * Default out-of-band compaction prompt.
 *
 * This is the baseline summarization instruction used when no handler
 * provides a custom prompt via the `compact(before)` event. Hosts and plugins
 * can override/extend it via `{ prompt }` or `{ prependPrompt }`/`{ appendPrompt }`
 * patches during the `compact(before)` dispatch.
 */
const OOB_COMPACTION_PROMPT =
	"Summarize the conversation so far, preserving all facts, decisions, and context needed for future messages."

/**
 * Default fold-selection policy.
 *
 * Keep the most recent N messages unfolded; fold everything older.
 * This is a tunable constant chosen as a reasonable default per ARCHITECTURE.md § 11.5's
 * invitation to "choose a small constant". Hosts can override by returning
 * `{ keepFrom: <index> }` or `{ summary, keepFrom }` from a `compact(before)` handler.
 */
const DEFAULT_KEEP_COUNT = 4

/**
 * Signature for the injected complete() function.
 *
 * Matches the interface documented for `bh.complete()` (TASK_0032).
 * This is injectable so tests can mock it, and so the real implementation
 * (once TASK_0032 lands) drops in with zero changes to this file.
 *
 * The optional `model` field lets compaction use a cheaper/faster model
 * for summarization when `compaction.model` is set on the conversation.
 */
export type CompleteFn = (req: {
	model?: string
	systemPrompt?: string
	messages: BHZAIMessage[]
}) => Promise<{ text: string; usage?: { inputTokens: number; outputTokens: number } }>

/**
 * Payload for compact event at each state.
 *
 * Per ARCHITECTURE.md § 8.1 (compact row) and § 11.5 (compaction subsections).
 * Extends with optional patch fields that handlers may return during `before` state.
 */
export interface CompactEventPayload {
	conversation: BHZAIConversationImpl
	prompt: string
	foldedMessages: BHZAIMessage[]
	summary: string | undefined
	keepFrom: number
	source: "manual" | "auto" | "emit"
	state: "before" | "compacting" | "complete"
	// Optional patch fields handlers may return during before state:
	block?: boolean
	prependPrompt?: string
	appendPrompt?: string
}

/**
 * Internal: run the full compaction pipeline.
 *
 * All three triggers (manual `conversation.compact()`, auto-compaction check,
 * and `conversation.emit('compact', ...)` interception) converge on this single
 * implementation. It is the ONLY place in the codebase that inserts a summary
 * message and marks messages `contextIncluded: false`.
 *
 * @param conversation The conversation to compact.
 * @param source Which trigger initiated this pipeline: 'manual', 'auto', or 'emit'.
 * @param options Options passed by the trigger (only used for manual/emit; auto passes undefined).
 * @param completeFn Injected summary function (defaults to a stub; tests override with a mock).
 *
 * Behavior:
 * 1. Compute default fold point: keep the most recent DEFAULT_KEEP_COUNT messages unfolded.
 * 2. Fire `compact(before)` with mutable payload — handlers can return patches to:
 *    - Replace the prompt: `{ prompt: string }`
 *    - Append to the prompt: `{ appendPrompt: string }` or `{ prependPrompt: string }`
 *    - Pre-supply the summary: `{ summary: string, keepFrom: number }`
 *    - Block the entire pipeline: `{ block: true }` (no state change, no summary inserted)
 * 3. If blocked, return immediately.
 * 4. If no pre-supplied summary, set status='compacting', call completeFn, fire `compact(compacting)`.
 * 5. Insert a new `role: 'system'` message at the fold point with the summary text.
 * 6. Mark all messages before the fold point with `contextIncluded: false`.
 * 7. Revert status to its pre-compaction value, fire `compact(complete)`.
 *
 * The never-delete-history invariant: every pre-compaction message remains in the array,
 * only marked with `contextIncluded: false`. Message count increases by exactly 1.
 *
 * @internal
 */
export async function runCompactionPipeline(
	conversation: BHZAIConversationImpl,
	source: "manual" | "auto" | "emit",
	options: CompactOptions | undefined,
	completeFn?: CompleteFn,
): Promise<void> {
	const originalMessages = conversation.messages
	const effectiveMessages = effectiveContextMessages(conversation)

	// Compute default fold point: keep the most recent DEFAULT_KEEP_COUNT messages unfolded.
	// keepFrom is the index into conversation.messages at/after which messages are retained un-folded.
	const keepFromIndex = Math.max(0, originalMessages.length - DEFAULT_KEEP_COUNT)
	const foldedMessages = originalMessages.slice(0, keepFromIndex)
	const retainedMessages = originalMessages.slice(keepFromIndex)

	// Build the before-event payload with defaults.
	let prompt = OOB_COMPACTION_PROMPT
	let keepFrom = keepFromIndex
	let preSuppledSummary: string | undefined = undefined

	// Fire compact(before) and collect patches.
	const beforeResult = await conversation._dispatchConversationEvent("compact", {
		conversation,
		prompt,
		foldedMessages,
		summary: undefined,
		keepFrom,
		source,
		state: "before",
	} as CompactEventPayload)

	// Check for block signal — if present, abort the entire pipeline with no state change.
	if (beforeResult.patch?.block === true) {
		return
	}

	// Apply patches: prompt replacement/concatenation and pre-supplied summary.
	// To support chaining of appendPrompt/prependPrompt across multiple handlers,
	// we check both the direct patch fields and accumulate them.
	const patch = beforeResult.patch as
		| (Partial<CompactEventPayload> & { block?: boolean })
		| undefined
	if (patch) {
		if (patch.prompt !== undefined) {
			// Explicit prompt replacement — discards any prior modifications
			prompt = patch.prompt
		} else {
			// Concatenation-style prompt modification
			// Note: due to EventBus's shallow-merge behavior, if multiple handlers return
			// { appendPrompt }, only the last one will be in the accumulated patch.
			// This is a limitation of the current patch-accumulation design.
			// For true chaining support, handlers should coordinate through other means.
			if (patch.prependPrompt !== undefined) {
				prompt = `${patch.prependPrompt}\n\n${prompt}`
			}
			if (patch.appendPrompt !== undefined) {
				prompt = `${prompt}\n\n${patch.appendPrompt}`
			}
		}

		// Check for pre-supplied summary — if present, skip the LLM call
		if (patch.summary !== undefined && patch.keepFrom !== undefined) {
			preSuppledSummary = patch.summary
			keepFrom = patch.keepFrom
		}
	}

	// If no pre-supplied summary, call completeFn to summarize the folded messages.
	let summary: string
	if (preSuppledSummary !== undefined) {
		summary = preSuppledSummary
		// Don't fire compacting state when summary was pre-supplied
	} else {
		// Set status to compacting for the duration of the summarization call
		const priorStatus = conversation.status
		conversation._setStatus("compacting")

		// Fire compact(compacting) to notify observers
		await conversation._dispatchConversationEvent("compact", {
			conversation,
			prompt,
			foldedMessages,
			summary: undefined,
			keepFrom,
			source,
			state: "compacting",
		} as CompactEventPayload)

		// Call the complete function (mocked in tests, real bh.complete() in production).
		// Pass `compaction.model` if set, so a cheaper/faster model can be used for summarization.
		const compactionModel = conversation._getCreateOptions().compaction?.model
		const defaultComplete = async (req: {
			model?: string
			systemPrompt?: string
			messages: BHZAIMessage[]
		}) => {
			// Stub: if no real complete() is injected, throw
			// In real usage, this is replaced by the genuine bh.complete()
			throw new Error(
				"compaction: complete function not provided (TASK_0032 not yet implemented) — provide via completeFn parameter in tests",
			)
		}
		const realComplete = completeFn || defaultComplete
		const result = await realComplete({
			model: compactionModel,
			systemPrompt: prompt,
			messages: foldedMessages,
		})
		summary = result.text

		// Revert status to its prior value
		conversation._setStatus(priorStatus)
	}

	// Insert the summary message at the fold point (immediately before the first retained message).
	const summaryMessage: BHZAIMessage = createMessage(
		{
			role: "system",
			content: summary,
			meta: { contextIncluded: true, compactionSummary: true },
		},
		conversation._getBh()._getMessageFields(),
		{
			mutable: false,
			frozenReason: "{method}() is not supported on compaction summary messages",
		},
	)

	// Insert at keepFrom index (before any retained messages shift indices)
	conversation._insertMessageAt(keepFrom, summaryMessage)

	// Mark all messages before the fold point as no longer included in context
	for (const msg of foldedMessages) {
		conversation._setMessageContextIncluded(msg.id, false)
	}

	// Fire compact(complete) to signal that folding is complete
	await conversation._dispatchConversationEvent("compact", {
		conversation,
		prompt,
		foldedMessages,
		summary,
		keepFrom,
		source,
		state: "complete",
	} as CompactEventPayload)
}

/**
 * Manual compaction trigger.
 *
 * Invoked by `conversation.compact(options)` to start the compaction pipeline
 * with `source: 'manual'`. This is the public API for hosts to trigger compaction
 * on demand (e.g., via a `/compact` slash command).
 *
 * @param conversation The conversation to compact.
 * @param options Options (reserved for future use; currently unused).
 * @param completeFn Injected complete function (for testing; defaults to bh.complete() in production).
 *
 * @internal
 */
export async function compact(
	conversation: BHZAIConversationImpl,
	options?: CompactOptions,
	completeFn?: CompleteFn,
): Promise<void> {
	// If no completeFn is provided, use bh.complete() as the default.
	// This allows the production code to call bh.complete() when the real TASK_0032 lands.
	// Tests can still override by passing completeFn explicitly.
	const resolvedComplete =
		completeFn ||
		(async (req) => {
			const bh = conversation._getBh()
			// biome-ignore lint/suspicious/noExplicitAny: bh.complete() is typed as Promise<never> in TASK_0031 stub; will be fixed in TASK_0032
			return (bh.complete as any)(req)
		})
	await runCompactionPipeline(conversation, "manual", options, resolvedComplete)
}

/**
 * Emit-triggered compaction (via conversation.emit('compact', ...)).
 *
 * Invoked by `conversation.emit()` interception logic to route the 'compact'
 * event into the pipeline with `source: 'emit'`. Same as `compact()` but with
 * the emit trigger semantics.
 *
 * @param conversation The conversation to compact.
 * @param options Compaction options passed by the emit caller.
 * @param completeFn Injected complete function (for testing; defaults to bh.complete() in production).
 *
 * @internal
 */
export async function compactViaEmit(
	conversation: BHZAIConversationImpl,
	options?: CompactOptions,
	completeFn?: CompleteFn,
): Promise<void> {
	// Same logic as compact() — resolve completeFn to bh.complete() if not provided.
	const resolvedComplete =
		completeFn ||
		(async (req) => {
			const bh = conversation._getBh()
			// biome-ignore lint/suspicious/noExplicitAny: bh.complete() is typed as Promise<never> in TASK_0031 stub; will be fixed in TASK_0032
			return (bh.complete as any)(req)
		})
	await runCompactionPipeline(conversation, "emit", options, resolvedComplete)
}

/**
 * Auto-triggered compaction (via the agent loop's auto-compaction check).
 *
 * Invoked by the agent loop when accumulated token usage crosses the
 * auto-compaction threshold. This is the internal wrapper that handles
 * the default completeFn resolution (to bh.complete()).
 *
 * @param conversation The conversation to compact.
 * @param completeFn Injected complete function (for testing; defaults to bh.complete() in production).
 *
 * @internal
 */
export async function compactAuto(
	conversation: BHZAIConversationImpl,
	completeFn?: CompleteFn,
): Promise<void> {
	// Same logic as compact() — resolve completeFn to bh.complete() if not provided.
	const resolvedComplete =
		completeFn ||
		(async (req) => {
			const bh = conversation._getBh()
			// biome-ignore lint/suspicious/noExplicitAny: bh.complete() is typed as Promise<never> in TASK_0031 stub; will be fixed in TASK_0032
			return (bh.complete as any)(req)
		})
	await runCompactionPipeline(conversation, "auto", undefined, resolvedComplete)
}
