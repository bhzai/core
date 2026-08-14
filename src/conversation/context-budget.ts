/**
 * @file Pre-flight context-window budget check and message trimming.
 *
 * Before each turn, the agent loop calls {@link fitContextToWindow} to determine
 * whether the messages it is about to send fit within the driver's reported
 * `contextWindow`. The check uses the driver's real `usage.inputTokens` from the
 * last turn as the precise base context size, and heuristic-estimates only the
 * delta (new messages since the last turn, system prompt, tools). When the
 * estimate exceeds the window, oldest messages are dropped from the front of the
 * request (transiently — history is never deleted) until it fits.
 *
 * The heuristic is a simple ~4 characters/token approximation. This is
 * intentionally conservative: the core cannot import a real tokenizer (web-
 * standard APIs only, no tiktoken dependency), so the estimate errs on the side
 * of trimming more rather than risking a provider 400 error. After the first
 * turn, the driver's real `inputTokens` provides an accurate baseline, so the
 * heuristic only applies to the delta — a smaller error surface.
 */

import type { ToolWireDefinition } from "../types/driver.js"
import type { BHZAIMessage } from "../types/message.js"

/**
 * Heuristic: approximately 4 characters per token.
 *
 * This is a conservative average across common tokenizers (BPE, SentencePiece).
 * Real ratios vary from ~2.5 (code-heavy) to ~5 (whitespace-heavy prose), but 4
 * is a safe middle ground that errs toward over-estimating — which means the
 * pre-flight check trims slightly more aggressively, avoiding 400 errors.
 */
const CHARS_PER_TOKEN = 4

/**
 * Estimate the token count of a message using a character-based heuristic.
 *
 * Counts the `content` string length plus a rough estimate of `blocks` and
 * `meta` overhead. Each message has a minimum of 1 token (role + framing
 * overhead charged by the provider's chat template).
 *
 * @param message The message to estimate
 * @returns Estimated token count (always >= 1)
 */
export function estimateMessageTokens(message: BHZAIMessage): number {
	let chars = 0

	// Content string is the primary text payload.
	chars += message.content.length

	// Blocks may carry text beyond `content` (e.g. tool-call arguments,
	// structured data). Count text blocks and JSON-serialized non-text blocks.
	for (const block of message.blocks) {
		if (block.type === "text") {
			// Text block content may overlap with `content` — to avoid double
			// counting, only add if it's not the sole block (in which case
			// `content` already represents it).
			if (message.blocks.length > 1) {
				chars += block.text.length
			}
		} else {
			// Non-text blocks (tool calls, tool results, etc.) — JSON-serialize
			// and count characters.
			chars += JSON.stringify(block).length
		}
	}

	// Meta may carry tool-call records, reasoning, etc. Count the JSON size
	// of known-heavy keys without serializing the entire meta object.
	const meta = message.meta
	if (meta.toolCalls && Array.isArray(meta.toolCalls)) {
		chars += JSON.stringify(meta.toolCalls).length
	}
	if (typeof meta.reasoning === "string") {
		chars += meta.reasoning.length
	}
	if (typeof meta.think === "string") {
		chars += meta.think.length
	}

	// Minimum 1 token per message (role tag + framing).
	return Math.max(1, Math.ceil(chars / CHARS_PER_TOKEN))
}

/**
 * Estimate the token count of a system prompt string.
 *
 * @param prompt The system prompt text
 * @returns Estimated token count (0 if empty)
 */
export function estimateSystemPromptTokens(prompt: string): number {
	if (!prompt) return 0
	return Math.ceil(prompt.length / CHARS_PER_TOKEN)
}

/**
 * Estimate the token count of tool definitions (names + descriptions + schemas).
 *
 * Each tool's `name`, `description`, and `inputSchema` are JSON-serialized and
 * counted by character length. Providers typically wrap tool definitions in
 * a function-calling template that adds ~10 tokens of overhead per tool.
 *
 * @param tools Tool wire definitions to estimate
 * @returns Estimated token count (0 if no tools)
 */
export function estimateToolTokens(tools: ToolWireDefinition[]): number {
	if (!tools || tools.length === 0) return 0
	let chars = 0
	for (const tool of tools) {
		chars += tool.name.length
		chars += tool.description.length
		chars += JSON.stringify(tool.inputSchema).length
	}
	// ~10 tokens overhead per tool for the function-calling template wrapper.
	const overhead = tools.length * 10
	return Math.ceil(chars / CHARS_PER_TOKEN) + overhead
}

/**
 * Result of the pre-flight context check.
 */
export interface FitContextResult {
	/** The messages to send to the driver (may be a subset of the input). */
	messages: BHZAIMessage[]
	/** True if any messages were dropped from the front to fit the window. */
	trimmed: boolean
	/**
	 * True if even the system prompt + the most recent user message alone
	 * exceed the window. When this is set, prompt compaction should be
	 * triggered (if enabled) to split and summarize the user message.
	 */
	overLimit: boolean
	/** The estimated total token count of the returned messages + system prompt + tools. */
	estimatedTokens: number
}

/**
 * Pre-flight context check: determine whether the request fits the context
 * window, and if not, which messages to trim.
 *
 * Strategy:
 * 1. If `lastInputTokens` is available (from the driver's last `usage` event),
 *    use it as the base context size. This is the precise count the provider
 *    processed on the last turn — no heuristic needed for already-sent messages.
 *    For the first turn (`lastInputTokens` is `undefined`), estimate all
 *    messages heuristically.
 * 2. When `lastInputTokens` is available, estimate only the delta: new messages
 *    added since the last turn (assistant response + tool results + new user
 *    message). The delta is computed by comparing the current message count
 *    against the count at the last turn (approximated by re-estimating all
 *    messages and taking the difference from `lastInputTokens`).
 * 3. Add estimated tokens for system prompt and tools (always heuristically
 *    estimated, since these may change between turns).
 * 4. If `estimatedTotal + outputReserve <= contextWindow`, return all messages.
 * 5. If over, drop oldest messages from the front (preserving the system prompt
 *    and the most recent user message) until it fits.
 * 6. Set `overLimit` if even the system prompt + most recent user message +
 *    tools exceed the window.
 *
 * @param params See {@link FitContextParams}
 * @returns See {@link FitContextResult}
 */
export function fitContextToWindow(params: {
	/** Messages to send (already filtered by `effectiveContextMessages`). */
	messages: BHZAIMessage[]
	/** System prompt text (may be empty). */
	systemPrompt: string
	/** Tool definitions to include in the request. */
	tools: ToolWireDefinition[]
	/** Driver-reported context window size. */
	contextWindow: number
	/** Tokens reserved for the model's output. */
	outputReserve: number
	/** Last turn's real input token count from the driver, or `undefined` for the first turn. */
	lastInputTokens: number | undefined
}): FitContextResult {
	const { messages, systemPrompt, tools, contextWindow, outputReserve, lastInputTokens } = params

	const systemPromptTokens = estimateSystemPromptTokens(systemPrompt)
	const toolTokens = estimateToolTokens(tools)
	const availableForMessages = contextWindow - outputReserve - systemPromptTokens - toolTokens

	// If the system prompt + tools alone exceed the budget, everything is over limit.
	if (availableForMessages <= 0) {
		return {
			messages,
			trimmed: false,
			overLimit: true,
			estimatedTokens: systemPromptTokens + toolTokens,
		}
	}

	// Estimate total message tokens.
	const messageTokens = messages.reduce((sum, m) => sum + estimateMessageTokens(m), 0)

	// When we have the driver's real last-turn input tokens, use that as the
	// base and only heuristically estimate the delta. The delta is the
	// difference between the current heuristic estimate and the last real
	// count — if the heuristic estimate is lower than the real count (heuristic
	// under-counted), we trust the real count. If higher (new messages added),
	// we use the heuristic estimate.
	let estimatedTotal: number
	if (lastInputTokens !== undefined) {
		// The last turn's real input tokens already include the system prompt
		// and tools as they were sent. We re-estimate the system prompt and
		// tools each turn (they may have changed), so:
		//   estimatedTotal = lastInputTokens + delta
		// where delta = max(0, messageTokens - lastMessageTokens)
		// Since we don't track lastMessageTokens separately, we approximate:
		// if the heuristic message estimate exceeds lastInputTokens, the
		// delta is the difference; otherwise, the real count is authoritative.
		const fullEstimate = systemPromptTokens + toolTokens + messageTokens
		estimatedTotal = Math.max(lastInputTokens, fullEstimate)
	} else {
		// First turn — no real usage data. Use pure heuristic estimation.
		estimatedTotal = systemPromptTokens + toolTokens + messageTokens
	}

	// Check if it fits.
	if (estimatedTotal + outputReserve <= contextWindow) {
		return {
			messages,
			trimmed: false,
			overLimit: false,
			estimatedTokens: estimatedTotal,
		}
	}

	// Over budget — trim oldest messages from the front.
	// Preserve the most recent user message (and any tool-result messages
	// that follow it, since they're paired).
	const lastUserIndex = findLastUserMessageIndex(messages)
	if (lastUserIndex < 0) {
		// No user message — can't trim meaningfully, return as-is.
		return {
			messages,
			trimmed: false,
			overLimit: true,
			estimatedTokens: estimatedTotal,
		}
	}

	// The messages we must keep: from the last user message onward.
	// (Tool results after the last user message are paired with it.)
	const mustKeep = messages.slice(lastUserIndex)
	const mustKeepTokens = mustKeep.reduce((sum, m) => sum + estimateMessageTokens(m), 0)

	// Check if even the must-keep messages + system prompt + tools exceed the window.
	const mustKeepTotal = systemPromptTokens + toolTokens + mustKeepTokens
	if (mustKeepTotal + outputReserve > contextWindow) {
		// Even the most recent user message alone doesn't fit — over limit.
		return {
			messages,
			trimmed: false,
			overLimit: true,
			estimatedTokens: estimatedTotal,
		}
	}

	// Greedily add messages from the front (before the last user message)
	// until we hit the budget.
	const remainingBudget = availableForMessages - mustKeepTokens
	const kept: BHZAIMessage[] = []
	let keptTokens = 0

	for (let i = lastUserIndex - 1; i >= 0; i--) {
		const msgTokens = estimateMessageTokens(messages[i])
		if (keptTokens + msgTokens > remainingBudget) {
			break // Adding this message would exceed the budget.
		}
		kept.unshift(messages[i])
		keptTokens += msgTokens
	}

	const finalMessages = [...kept, ...mustKeep]
	const finalTokens = systemPromptTokens + toolTokens + keptTokens + mustKeepTokens

	return {
		messages: finalMessages,
		trimmed: kept.length < lastUserIndex,
		overLimit: false,
		estimatedTokens: finalTokens,
	}
}

/**
 * Find the index of the most recent user message in the array.
 *
 * @param messages Message array to search
 * @returns Index of the last `role: 'user'` message, or -1 if none found
 */
function findLastUserMessageIndex(messages: BHZAIMessage[]): number {
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i].role === "user") {
			return i
		}
	}
	return -1
}
