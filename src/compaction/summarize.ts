import type { LlmService } from "../llm/types"
import type { SessionEvent } from "../sessions/types"

const DEFAULT_SUMMARIZER_PROMPT =
	"You are a concise conversation summarizer. Provide a compact summary preserving all essential facts, user requests, tool results, decisions, and context needed for subsequent conversation turns."

/**
 * Formats a list of session events into readable dialogue lines for summarization.
 * @param events List of events to format.
 */
export function formatEventsForSummary(events: SessionEvent[]): string {
	const lines: string[] = []
	for (const e of events) {
		if (e.type === "user_message") {
			const text =
				typeof e.content === "string"
					? e.content
					: e.content.map((b) => (b.type === "text" ? b.text : "")).join("")
			lines.push(`User: ${text}`)
		} else if (e.type === "assistant_message") {
			lines.push(`Assistant: ${e.content}`)
		} else if (e.type === "tool_call") {
			lines.push(`Tool Call: ${e.toolName}`)
		} else if (e.type === "tool_result") {
			const resStr = typeof e.result === "string" ? e.result : JSON.stringify(e.result)
			lines.push(`Tool Result [${e.toolName}]: ${resStr.slice(0, 150)}`)
		}
	}
	return lines.join("\n")
}

/**
 * Parameters for generating a conversation summary.
 */
export interface GenerateSummaryParams {
	events: SessionEvent[]
	priorSummary?: string
	llm?: LlmService
	model?: string
	systemPrompt?: string
	customSummarizer?: (events: SessionEvent[], priorSummary?: string) => Promise<string>
}

/**
 * Generates a summary for older session events using a custom summarizer, LLM, or structured fallback.
 * @param params Summary generation parameters.
 */
export async function generateSummary(params: GenerateSummaryParams): Promise<string> {
	if (params.customSummarizer) {
		return await params.customSummarizer(params.events, params.priorSummary)
	}

	const dialogue = formatEventsForSummary(params.events)

	if (params.llm) {
		try {
			const promptParts: string[] = []
			if (params.priorSummary) {
				promptParts.push(`Previous Summary:\n${params.priorSummary}`)
			}
			promptParts.push(`New Conversation Events:\n${dialogue}`)
			promptParts.push("Provide an updated, consolidated conversation summary.")

			const res = await params.llm.complete({
				model: params.model,
				systemPrompt: params.systemPrompt ?? DEFAULT_SUMMARIZER_PROMPT,
				messages: promptParts.join("\n\n"),
			})
			if (res.text.trim().length > 0) {
				return res.text.trim()
			}
		} catch {
			// Fall back to heuristic fallback if LLM completion encounters an error
		}
	}

	const fallbackLines: string[] = []
	if (params.priorSummary) {
		fallbackLines.push(params.priorSummary)
	}
	fallbackLines.push(`[Archived ${params.events.length} conversation events]`)
	if (dialogue.length > 0) {
		fallbackLines.push(dialogue.slice(0, 300))
	}
	return fallbackLines.join("\n")
}
