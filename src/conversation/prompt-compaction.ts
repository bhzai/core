/**
 * @file Prompt compaction — handles the edge case where a single user message
 * exceeds the context window.
 *
 * When the pre-flight context check ({@link fitContextToWindow}) reports
 * `overLimit: true` (even the system prompt + most recent user message don't
 * fit), the agent loop calls {@link compactPrompt} to split the user message
 * into chunks, summarize each via `bh.complete()`, and replace the message
 * with the concatenated summary. A `prompt_compactation` event is fired so
 * plugins can intercept and provide a custom strategy.
 *
 * Chunking strategy: split by paragraphs (double newlines), then by sentences
 * if a single paragraph is too large, then by fixed character count as a last
 * resort. Target ~50% of the available token budget per chunk so the
 * concatenated summaries fit.
 */

import type { BHZAIMessage } from "../types/message.js"
import type { BHZAIConversationImpl } from "./conversation.js"
import { createMessage } from "./message.js"

/**
 * Event payload for `prompt_compactation`.
 *
 * Fired when a single user message exceeds the context window. Plugins can
 * intercept by returning a patch with `{ summary: string, handled: true }` —
 * the core default is then skipped and the plugin's summary is used.
 */
export interface PromptCompactationPayload {
	conversation: BHZAIConversationImpl
	/** The original user message that is too large. */
	message: BHZAIMessage
	/** The estimated token count of the message. */
	estimatedTokens: number
	/** The available token budget (contextWindow - outputReserve - systemPromptTokens). */
	availableTokens: number
	/** The compacted/summarized content. Plugins can set this via patch. */
	summary?: string
	/** Whether a plugin handled the compaction. */
	handled?: boolean
}

/**
 * Default summarization prompt for prompt compaction.
 *
 * Instructs the model to produce a concise summary that preserves all
 * essential information while fitting within the available token budget.
 */
const PROMPT_COMPACTION_SYSTEM_PROMPT =
	"Summarize the following text concisely, preserving all essential information, " +
	"key facts, decisions, and context. The summary must be significantly shorter " +
	"than the original text while retaining its core meaning."

/**
 * Maximum recursion depth for prompt compaction.
 *
 * If the summarized result still exceeds the window, we recursively summarize
 * the summary. This guards against infinite loops.
 */
const MAX_RECURSION_DEPTH = 3

/**
 * Target ratio of chunk size to available budget.
 *
 * Each chunk is sized to ~50% of the available token budget, so the
 * concatenated summaries of all chunks fit within the budget.
 */
const CHUNK_BUDGET_RATIO = 0.5

/**
 * Orchestrate prompt compaction: fire the `prompt_compactation` event, use
 * the plugin result if handled, otherwise run the core default.
 *
 * @param conversation The conversation containing the message.
 * @param message The user message that is too large.
 * @param estimatedTokens Estimated token count of the full request.
 * @param availableTokens Available token budget for the message (contextWindow - outputReserve - systemPromptTokens).
 * @returns A new message with the compacted content, or `undefined` if compaction failed.
 *
 * @internal
 */
export async function compactPrompt(
	conversation: BHZAIConversationImpl,
	message: BHZAIMessage,
	estimatedTokens: number,
	availableTokens: number,
): Promise<BHZAIMessage | undefined> {
	// Fire the prompt_compactation event so plugins can intercept.
	const payload: PromptCompactationPayload = {
		conversation,
		message,
		estimatedTokens,
		availableTokens,
	}

	const result = await conversation._dispatchConversationEvent(
		"prompt_compactation",
		payload as unknown,
	)

	const patch = result.patch as Partial<PromptCompactationPayload> | undefined

	// If a plugin provided a summary, use it.
	if (patch?.summary && patch?.handled) {
		return createCompactedMessage(message, patch.summary)
	}

	// Run the core default prompt compaction.
	const summary = await runPromptCompaction(conversation, message, availableTokens)
	if (summary === undefined) {
		return undefined
	}
	return createCompactedMessage(message, summary)
}

/**
 * Core default prompt compaction: split the message into chunks, summarize
 * each via `bh.complete()`, concatenate, and recursively summarize if still
 * too large.
 *
 * Chunking strategy: split by paragraphs (double newlines), then by sentences
 * if a single paragraph is too large, then by fixed character count as a last
 * resort. Target ~50% of the available token budget per chunk so the
 * concatenated summaries fit.
 *
 * Uses `compaction?.model` if set (cheaper model for summarization),
 * otherwise falls back to the default `bh.complete()` resolution.
 *
 * @param conversation The conversation containing the message.
 * @param message The user message to compact.
 * @param availableTokens Available token budget for the message.
 * @param depth Current recursion depth (internal, defaults to 0).
 * @returns The summarized content string, or `undefined` if compaction failed.
 *
 * @internal
 */
export async function runPromptCompaction(
	conversation: BHZAIConversationImpl,
	message: BHZAIMessage,
	availableTokens: number,
	depth = 0,
): Promise<string | undefined> {
	if (depth >= MAX_RECURSION_DEPTH) {
		return undefined
	}

	const content = message.content
	if (!content) {
		return undefined
	}

	// Target chunk size in tokens: ~50% of available budget per chunk.
	const chunkTokenBudget = Math.max(1, Math.floor(availableTokens * CHUNK_BUDGET_RATIO))
	// Convert to character budget (~4 chars/token).
	const chunkCharBudget = chunkTokenBudget * 4

	// Split content into chunks.
	const chunks = splitIntoChunks(content, chunkCharBudget)
	if (chunks.length === 0) {
		return undefined
	}

	// If only one chunk and it fits, no compaction needed — but this shouldn't
	// happen since we only call this when the message is over limit.
	if (chunks.length === 1) {
		// The single chunk is still too large — recursively summarize it.
		const summary = await summarizeChunk(conversation, chunks[0])
		if (summary === undefined) {
			return undefined
		}
		// Check if the summary fits.
		const summaryTokens = Math.ceil(summary.length / 4)
		if (summaryTokens <= availableTokens) {
			return summary
		}
		// Still too large — recurse with the summary.
		const summaryMessage = createMessage(
			{
				id: `prompt-compaction-${crypto.randomUUID()}`,
				role: "user",
				content: summary,
				blocks: [{ type: "text", text: summary }],
				time: Date.now(),
				meta: {},
			},
			undefined,
			{ mutable: false },
		)
		return runPromptCompaction(conversation, summaryMessage, availableTokens, depth + 1)
	}

	// Summarize each chunk.
	const summaries: string[] = []
	for (const chunk of chunks) {
		const summary = await summarizeChunk(conversation, chunk)
		if (summary === undefined) {
			return undefined
		}
		summaries.push(summary)
	}

	// Concatenate summaries.
	const concatenated = summaries.join("\n\n")

	// Check if the concatenated summary fits.
	const concatTokens = Math.ceil(concatenated.length / 4)
	if (concatTokens <= availableTokens) {
		return concatenated
	}

	// Still too large — recursively summarize the concatenated summary.
	const concatMessage = createMessage(
		{
			id: `prompt-compaction-${crypto.randomUUID()}`,
			role: "user",
			content: concatenated,
			blocks: [{ type: "text", text: concatenated }],
			time: Date.now(),
			meta: {},
		},
		undefined,
		{ mutable: false },
	)
	return runPromptCompaction(conversation, concatMessage, availableTokens, depth + 1)
}

/**
 * Summarize a single chunk of text via `bh.complete()`.
 *
 * Uses `compaction?.model` if set, otherwise falls back to the default
 * model resolution path.
 *
 * @param conversation The conversation (provides access to `bh.complete()`).
 * @param chunk The text chunk to summarize.
 * @returns The summary, or `undefined` if the call failed.
 */
async function summarizeChunk(
	conversation: BHZAIConversationImpl,
	chunk: string,
): Promise<string | undefined> {
	const bh = conversation._getBh()
	const compactionModel = conversation._getCreateOptions().compaction?.model

	try {
		// biome-ignore lint/suspicious/noExplicitAny: bh.complete() is typed loosely in the kernel
		const result = (await (bh.complete as any)({
			model: compactionModel,
			systemPrompt: PROMPT_COMPACTION_SYSTEM_PROMPT,
			messages: [
				{
					id: `chunk-${crypto.randomUUID()}`,
					role: "user" as const,
					content: chunk,
					blocks: [{ type: "text" as const, text: chunk }],
					time: Date.now(),
					meta: {},
					append: () => {
						throw new Error("append not supported")
					},
					setContent: () => {
						throw new Error("setContent not supported")
					},
				},
			],
		})) as { text: string }

		return result.text
	} catch {
		// If the summarization call fails, return undefined to signal failure.
		return undefined
	}
}

/**
 * Split text into chunks that fit within the character budget.
 *
 * Strategy (in order of preference):
 * 1. Split by paragraphs (double newlines).
 * 2. If a paragraph is too large, split by sentences.
 * 3. If a sentence is too large, split by fixed character count.
 *
 * @param text The text to split.
 * @param charBudget Maximum characters per chunk.
 * @returns Array of text chunks.
 */
function splitIntoChunks(text: string, charBudget: number): string[] {
	if (text.length <= charBudget) {
		return [text]
	}

	// Step 1: split by paragraphs (double newlines).
	const paragraphs = text.split(/\n\s*\n/)
	if (paragraphs.length > 1) {
		return groupIntoChunks(paragraphs, charBudget)
	}

	// Step 2: split by sentences.
	const sentences = text.match(/[^.!?]+[.!?]+\s*/g) ?? [text]
	if (sentences.length > 1) {
		return groupIntoChunks(sentences, charBudget)
	}

	// Step 3: split by fixed character count.
	const chunks: string[] = []
	for (let i = 0; i < text.length; i += charBudget) {
		chunks.push(text.slice(i, i + charBudget))
	}
	return chunks
}

/**
 * Group an array of text segments into chunks that fit within the character
 * budget, preserving segment boundaries.
 *
 * @param segments Text segments (paragraphs, sentences, etc.)
 * @param charBudget Maximum characters per chunk
 * @returns Array of grouped text chunks
 */
function groupIntoChunks(segments: string[], charBudget: number): string[] {
	const chunks: string[] = []
	let current = ""

	for (const segment of segments) {
		// If a single segment exceeds the budget, it needs further splitting.
		if (segment.length > charBudget) {
			// Flush current chunk first.
			if (current) {
				chunks.push(current)
				current = ""
			}
			// Recursively split the large segment.
			const subChunks = splitIntoChunks(segment, charBudget)
			chunks.push(...subChunks)
			continue
		}

		if (current.length + segment.length > charBudget) {
			// Start a new chunk.
			if (current) {
				chunks.push(current)
			}
			current = segment
		} else {
			current += (current ? "\n\n" : "") + segment
		}
	}

	if (current) {
		chunks.push(current)
	}

	return chunks
}

/**
 * Create a new user message with compacted content, preserving the original
 * message's id and meta (with a `promptCompactionSummary` flag).
 *
 * @param original The original user message.
 * @param summary The compacted summary content.
 * @returns A new message with the summary content.
 */
function createCompactedMessage(original: BHZAIMessage, summary: string): BHZAIMessage {
	return createMessage(
		{
			id: original.id,
			role: "user",
			content: summary,
			blocks: [{ type: "text", text: summary }],
			time: original.time,
			meta: {
				...original.meta,
				promptCompactionSummary: true,
				originalContent: original.content,
			},
		},
		undefined,
		{ mutable: false },
	)
}
