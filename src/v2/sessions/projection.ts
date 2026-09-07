import type { ContentBlock } from "../../types/content"
import type { BHZAIMessage, ToolCallRecord } from "../../types/message"
import type {
	AssistantMessageEvent,
	CompactionBoundaryEvent,
	SessionEvent,
	ToolCallEvent,
	ToolResultEvent,
	UserMessageEvent,
} from "./types"

interface CreateMessageParams {
	id: string
	role: "user" | "assistant" | "system" | "tool"
	content: string
	blocks?: ContentBlock[]
	time: number
	meta?: Record<string, unknown>
}

/**
 * Constructs a fully compliant BHZAIMessage instance.
 * @param params Construction parameters.
 * @returns An initialized BHZAIMessage.
 */
function createMessage(params: CreateMessageParams): BHZAIMessage {
	const meta = params.meta ?? {}
	let textContent = params.content
	let contentBlocks = params.blocks ?? [{ type: "text", text: textContent }]

	return {
		id: params.id,
		role: params.role,
		get content() {
			return textContent
		},
		set content(val: string) {
			textContent = val
		},
		get blocks() {
			return contentBlocks
		},
		set blocks(val: ContentBlock[]) {
			contentBlocks = val
		},
		time: params.time,
		meta,
		append(text: string): void {
			textContent += text
			contentBlocks.push({ type: "text", text })
		},
		setContent(newContent: string | ContentBlock[]): void {
			if (typeof newContent === "string") {
				textContent = newContent
				contentBlocks = [{ type: "text", text: newContent }]
			} else {
				contentBlocks = newContent
				textContent = newContent.map((b) => (b.type === "text" ? b.text : "")).join("")
			}
		},
	}
}

/**
 * Identifies the latest compaction boundary and slices the visible event window.
 * @param events Full session event log.
 * @returns Object containing the active events slice and optional boundary event.
 */
function resolveCompactedWindow(events: SessionEvent[]): {
	visibleEvents: SessionEvent[]
	boundary?: CompactionBoundaryEvent
} {
	let latestBoundary: CompactionBoundaryEvent | undefined
	for (let i = events.length - 1; i >= 0; i--) {
		if (events[i].type === "compaction_boundary") {
			latestBoundary = events[i] as CompactionBoundaryEvent
			break
		}
	}

	if (!latestBoundary) {
		return { visibleEvents: events }
	}

	const cutoffId = latestBoundary.compactedThroughEventId
	const cutoffIndex = events.findIndex((e) => e.id === cutoffId)
	if (cutoffIndex === -1) {
		return { visibleEvents: events, boundary: latestBoundary }
	}

	return {
		visibleEvents: events.slice(cutoffIndex + 1),
		boundary: latestBoundary,
	}
}

/**
 * Projects a single user message event into a BHZAIMessage.
 */
function projectUserMessage(event: UserMessageEvent): BHZAIMessage {
	const text =
		typeof event.content === "string"
			? event.content
			: event.content.map((b) => (b.type === "text" ? b.text : "")).join("")
	const blocks =
		typeof event.content === "string"
			? [{ type: "text" as const, text: event.content }]
			: event.content

	return createMessage({
		id: event.id,
		role: "user",
		content: text,
		blocks,
		time: event.timestamp,
		meta: { eventId: event.id },
	})
}

/**
 * Projects an assistant message event into a BHZAIMessage.
 */
function projectAssistantMessage(event: AssistantMessageEvent): BHZAIMessage {
	const meta: Record<string, unknown> = { eventId: event.id }
	if (event.toolCalls && event.toolCalls.length > 0) {
		meta.toolCalls = event.toolCalls
	}
	if (event.usage) {
		meta.usage = event.usage
	}
	if (event.reasoning) {
		meta.think = event.reasoning
	}

	const msg = createMessage({
		id: event.id,
		role: "assistant",
		content: event.content,
		time: event.timestamp,
		meta,
	})

	if (event.reasoning) {
		msg.think = event.reasoning
	}

	return msg
}

/**
 * Projects a tool result event into a BHZAIMessage.
 */
function projectToolResult(event: ToolResultEvent): BHZAIMessage {
	const text = typeof event.result === "string" ? event.result : JSON.stringify(event.result)

	return createMessage({
		id: event.id,
		role: "tool",
		content: text,
		time: event.timestamp,
		meta: {
			toolCallId: event.callId,
			toolName: event.toolName,
			isError: event.isError,
			eventId: event.id,
		},
	})
}

/**
 * Pairs standalone tool calls to their preceding assistant message.
 */
function attachStandaloneToolCall(event: ToolCallEvent, messages: BHZAIMessage[]): void {
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i].role === "assistant") {
			const existingCalls = (messages[i].meta.toolCalls as ToolCallRecord[]) || []
			const rawArgs =
				typeof event.arguments === "string" ? event.arguments : JSON.stringify(event.arguments)
			const alreadyPresent = existingCalls.some((c) => c.id === event.callId)
			if (!alreadyPresent) {
				existingCalls.push({
					id: event.callId,
					name: event.toolName,
					arguments: rawArgs,
				})
				messages[i].meta.toolCalls = existingCalls
			}
			break
		}
	}
}

/**
 * Synthesizes an aborted error message for an unfulfilled tool call.
 */
function createAbortedToolResult(call: ToolCallRecord, time: number): BHZAIMessage {
	return createMessage({
		id: `repaired-${call.id}`,
		role: "tool",
		content: "[Aborted: tool execution was interrupted]",
		time,
		meta: {
			toolCallId: call.id,
			toolName: call.name,
			isError: true,
			repaired: true,
		},
	})
}

/**
 * Inspects all assistant tool calls and synthesizes aborted results for any dangling calls.
 */
function repairDanglingToolCalls(messages: BHZAIMessage[]): BHZAIMessage[] {
	const repaired: BHZAIMessage[] = []
	const resolvedToolCallIds = new Set<string>()

	for (const msg of messages) {
		if (msg.role === "tool" && typeof msg.meta.toolCallId === "string") {
			resolvedToolCallIds.add(msg.meta.toolCallId)
		}
	}

	for (let i = 0; i < messages.length; i++) {
		const current = messages[i]
		repaired.push(current)

		if (current.role !== "assistant" || !Array.isArray(current.meta.toolCalls)) {
			continue
		}

		const toolCalls = current.meta.toolCalls as ToolCallRecord[]
		const dangling = toolCalls.filter((c) => !resolvedToolCallIds.has(c.id))
		if (dangling.length === 0) continue

		while (i + 1 < messages.length && messages[i + 1].role === "tool") {
			i++
			repaired.push(messages[i])
		}

		for (const call of dangling) {
			repaired.push(createAbortedToolResult(call, current.time))
			resolvedToolCallIds.add(call.id)
		}
	}

	return repaired
}

/**
 * Pure projection from an append-only SessionEvent log to standard driver BHZAIMessage history.
 * @param events The session events log.
 * @returns Array of projected driver messages.
 */
export function deriveMessages(events: SessionEvent[]): BHZAIMessage[] {
	const { visibleEvents, boundary } = resolveCompactedWindow(events)
	const messages: BHZAIMessage[] = []

	if (boundary) {
		messages.push(
			createMessage({
				id: `summary-${boundary.id}`,
				role: "system",
				content: boundary.summary,
				time: boundary.timestamp,
				meta: {
					isCompactionSummary: true,
					compactedThroughEventId: boundary.compactedThroughEventId,
				},
			}),
		)
	}

	for (const event of visibleEvents) {
		switch (event.type) {
			case "user_message":
				messages.push(projectUserMessage(event))
				break
			case "assistant_message":
				messages.push(projectAssistantMessage(event))
				break
			case "tool_call":
				attachStandaloneToolCall(event, messages)
				break
			case "tool_result":
				messages.push(projectToolResult(event))
				break
			default:
				// Metadata events (model_change, custom, etc.) are excluded from model prompt projection
				break
		}
	}

	return repairDanglingToolCalls(messages)
}
