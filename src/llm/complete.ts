import type { DriverEvent } from "../types/driver"
import type { BHZAIMessage } from "../types/message"
import type { LlmCompleteRequest, LlmCompleteResult, LlmStreamRequest } from "./types"

function normalizeMessages(input: string | BHZAIMessage[]): BHZAIMessage[] {
	if (Array.isArray(input)) return input

	let textContent = input
	return [
		{
			id: crypto.randomUUID(),
			role: "user",
			get content() {
				return textContent
			},
			set content(v: string) {
				textContent = v
			},
			blocks: [{ type: "text", text: input }],
			time: Date.now(),
			meta: {},
			append(t: string) {
				textContent += t
			},
			setContent(c: string) {
				textContent = typeof c === "string" ? c : ""
			},
		},
	]
}

/**
 * Executes a one-shot non-streaming completion request.
 * @param streamFn Stream execution function provided by LlmService.
 * @param request Complete request options.
 * @returns Result with aggregated text, reasoning, and token usage.
 */
export async function executeComplete(
	streamFn: (req: LlmStreamRequest) => AsyncIterable<DriverEvent>,
	request: LlmCompleteRequest,
): Promise<LlmCompleteResult> {
	if (request.signal?.aborted) {
		const err = new Error("Aborted")
		err.name = "AbortError"
		throw err
	}

	const messages = normalizeMessages(request.messages)
	const stream = streamFn({
		model: request.model,
		messages,
		systemPrompt: request.systemPrompt,
		params: request.params,
		signal: request.signal,
		retry: request.retry,
	})

	let text = ""
	let reasoning = ""
	let usage: LlmCompleteResult["usage"]

	for await (const event of stream) {
		if (event.type === "delta") {
			text += event.text
		} else if (event.type === "reasoning-delta") {
			reasoning += event.text
		} else if (event.type === "usage") {
			usage = {
				inputTokens: event.inputTokens ?? 0,
				outputTokens: event.outputTokens ?? 0,
			}
		}
	}

	return {
		text,
		reasoning: reasoning.length > 0 ? reasoning : undefined,
		usage,
	}
}
