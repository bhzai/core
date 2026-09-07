import type { ToolWireDefinition } from "../../types/driver"
import type { BHZAIMessage } from "../../types/message"
import type {
	AssistantMessageEvent,
	CompactionBoundaryEvent,
	SessionEvent,
	ToolCallEvent,
	ToolResultEvent,
	UserMessageEvent,
} from "../sessions/types"
import type { Tokenizer, TokenizerService } from "./types"

const CHARS_PER_TOKEN = 4
const TOOL_OVERHEAD_TOKENS = 10
const MESSAGE_FRAMING_TOKENS = 3

/**
 * Built-in heuristic tokenizer backend based on character count estimation.
 */
export const heuristicTokenizer: Tokenizer = {
	name: "heuristic",
	countTokens(text: string): number {
		if (!text) return 0
		return Math.max(1, Math.ceil(text.length / CHARS_PER_TOKEN))
	},
}

/**
 * Estimates token count for a UserMessageEvent.
 * @param event User message event.
 * @param tokenizer Tokenizer backend to use.
 */
async function estimateUserEvent(event: UserMessageEvent, tokenizer: Tokenizer): Promise<number> {
	if (typeof event.content === "string") {
		const textTokens = await tokenizer.countTokens(event.content)
		return textTokens + MESSAGE_FRAMING_TOKENS
	}
	let chars = 0
	for (const block of event.content) {
		if (block.type === "text") {
			chars += block.text.length
		} else {
			chars += JSON.stringify(block).length
		}
	}
	const contentTokens = Math.max(1, Math.ceil(chars / CHARS_PER_TOKEN))
	return contentTokens + MESSAGE_FRAMING_TOKENS
}

/**
 * Estimates token count for an AssistantMessageEvent.
 * @param event Assistant message event.
 * @param tokenizer Tokenizer backend to use.
 */
async function estimateAssistantEvent(
	event: AssistantMessageEvent,
	tokenizer: Tokenizer,
): Promise<number> {
	if (typeof event.usage?.completionTokens === "number") {
		return event.usage.completionTokens
	}
	let text = event.content || ""
	if (event.reasoning) {
		text += `\n${event.reasoning}`
	}
	if (event.toolCalls && event.toolCalls.length > 0) {
		text += `\n${JSON.stringify(event.toolCalls)}`
	}
	const base = await tokenizer.countTokens(text)
	return base + MESSAGE_FRAMING_TOKENS
}

/**
 * Estimates token count for a ToolCallEvent.
 * @param event Tool call event.
 * @param tokenizer Tokenizer backend to use.
 */
async function estimateToolCallEvent(event: ToolCallEvent, tokenizer: Tokenizer): Promise<number> {
	const argsStr =
		typeof event.arguments === "string" ? event.arguments : JSON.stringify(event.arguments)
	const text = `${event.toolName}(${argsStr})`
	const base = await tokenizer.countTokens(text)
	return base + MESSAGE_FRAMING_TOKENS
}

/**
 * Estimates token count for a ToolResultEvent.
 * @param event Tool result event.
 * @param tokenizer Tokenizer backend to use.
 */
async function estimateToolResultEvent(
	event: ToolResultEvent,
	tokenizer: Tokenizer,
): Promise<number> {
	const resultStr = typeof event.result === "string" ? event.result : JSON.stringify(event.result)
	const base = await tokenizer.countTokens(resultStr)
	return base + MESSAGE_FRAMING_TOKENS
}

/**
 * Estimates token count for a CompactionBoundaryEvent.
 * @param event Compaction boundary event.
 * @param tokenizer Tokenizer backend to use.
 */
async function estimateBoundaryEvent(
	event: CompactionBoundaryEvent,
	tokenizer: Tokenizer,
): Promise<number> {
	const base = await tokenizer.countTokens(event.summary)
	return base + MESSAGE_FRAMING_TOKENS
}

/**
 * Implementation of TokenizerService managing pluggable tokenizer backends.
 */
export class TokenizerServiceImpl implements TokenizerService {
	private readonly backends = new Map<string, Tokenizer>()
	private activeBackendName = "heuristic"

	constructor() {
		this.backends.set("heuristic", heuristicTokenizer)
	}

	registerBackend(name: string, backend: Tokenizer): () => void {
		this.backends.set(name, backend)
		this.activeBackendName = name
		return () => {
			if (this.backends.get(name) === backend) {
				this.backends.delete(name)
				if (this.activeBackendName === name) {
					const remaining = Array.from(this.backends.keys())
					this.activeBackendName = remaining[remaining.length - 1] ?? "heuristic"
				}
			}
		}
	}

	getBackend(name?: string): Tokenizer | undefined {
		if (name) {
			return this.backends.get(name)
		}
		return this.backends.get(this.activeBackendName) ?? heuristicTokenizer
	}

	async countTokens(text: string, backendName?: string): Promise<number> {
		const backend = this.getBackend(backendName) ?? heuristicTokenizer
		return await backend.countTokens(text)
	}

	async estimateMessage(message: BHZAIMessage, backendName?: string): Promise<number> {
		const backend = this.getBackend(backendName) ?? heuristicTokenizer
		let chars = message.content.length

		for (const block of message.blocks) {
			if (block.type === "text") {
				if (message.blocks.length > 1) {
					chars += block.text.length
				}
			} else {
				chars += JSON.stringify(block).length
			}
		}

		if (message.meta.reasoning && typeof message.meta.reasoning === "string") {
			chars += message.meta.reasoning.length
		}
		if (message.meta.toolCalls && Array.isArray(message.meta.toolCalls)) {
			chars += JSON.stringify(message.meta.toolCalls).length
		}

		const count = await backend.countTokens("x".repeat(chars))
		return Math.max(1, count) + MESSAGE_FRAMING_TOKENS
	}

	async estimateTools(tools: ToolWireDefinition[], backendName?: string): Promise<number> {
		if (!tools || tools.length === 0) return 0
		const backend = this.getBackend(backendName) ?? heuristicTokenizer

		let total = 0
		for (const tool of tools) {
			const text = `${tool.name} ${tool.description} ${JSON.stringify(tool.inputSchema)}`
			const count = await backend.countTokens(text)
			total += count + TOOL_OVERHEAD_TOKENS
		}
		return total
	}

	async estimateEvent(event: SessionEvent, backendName?: string): Promise<number> {
		const backend = this.getBackend(backendName) ?? heuristicTokenizer
		switch (event.type) {
			case "user_message":
				return await estimateUserEvent(event, backend)
			case "assistant_message":
				return await estimateAssistantEvent(event, backend)
			case "tool_call":
				return await estimateToolCallEvent(event, backend)
			case "tool_result":
				return await estimateToolResultEvent(event, backend)
			case "compaction_boundary":
				return await estimateBoundaryEvent(event, backend)
			default:
				return 1
		}
	}
}
