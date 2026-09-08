import type { HarnessContext } from "../kernel/types"
import type { LlmService } from "../llm/types"
import type { AssistantMessageEvent, Session } from "../sessions/types"
import type { ToolService } from "../tools/types"
import type { CallToolResult } from "../types/content"
import type { ToolWireDefinition } from "../types/driver"
import type { BHZAIMessage, ToolCallRecord } from "../types/message"
import type { Usage } from "../types/model"
import type { TurnStep } from "./types"

/**
 * Parameters for executing the model streaming phase of a step.
 */
export interface StreamStepParams {
	ctx: HarnessContext
	sessionId: string
	turnId: string
	stepIndex: number
	model?: string
	systemPrompt?: string
	messages: BHZAIMessage[]
	tools?: ToolWireDefinition[]
	signal?: AbortSignal
}

/**
 * Result of the model streaming phase within a step.
 */
export interface StreamStepResult {
	assistantText: string
	reasoning: string
	toolCalls: ToolCallRecord[]
	usage?: Usage
}

/**
 * Streams events from the model driver for a single step and broadcasts streaming events.
 * @param params Step streaming parameters.
 */
export async function streamModelStep(params: StreamStepParams): Promise<StreamStepResult> {
	const llm = params.ctx.llm as LlmService | undefined
	if (!llm) {
		throw new Error("LLM service is not claimed or available on context.")
	}

	let assistantText = ""
	let reasoning = ""
	const rawCalls: Array<{ id: string; name: string; arguments: unknown }> = []
	let usage: Usage | undefined

	const stream = llm.stream({
		model: params.model,
		messages: params.messages,
		systemPrompt: params.systemPrompt,
		tools: params.tools,
		signal: params.signal,
	})

	for await (const event of stream) {
		if (event.type === "delta") {
			assistantText += event.text
			params.ctx.events.emit("stream/delta", {
				sessionId: params.sessionId,
				turnId: params.turnId,
				stepIndex: params.stepIndex,
				text: event.text,
			})
		} else if (event.type === "reasoning-delta") {
			reasoning += event.text
			params.ctx.events.emit("stream/reasoning", {
				sessionId: params.sessionId,
				turnId: params.turnId,
				stepIndex: params.stepIndex,
				text: event.text,
			})
		} else if (event.type === "tool-call") {
			rawCalls.push({
				id: event.toolCallId,
				name: event.name,
				arguments: event.input,
			})
			params.ctx.events.emit("stream/tool-call", {
				sessionId: params.sessionId,
				turnId: params.turnId,
				stepIndex: params.stepIndex,
				call: { id: event.toolCallId, name: event.name, input: event.input },
			})
		} else if (event.type === "usage") {
			usage = {
				inputTokens: event.inputTokens ?? 0,
				outputTokens: event.outputTokens ?? 0,
			}
		}
	}

	const toolCalls: ToolCallRecord[] = rawCalls.map((c) => ({
		id: c.id,
		name: c.name,
		arguments: typeof c.arguments === "string" ? c.arguments : JSON.stringify(c.arguments),
	}))

	return { assistantText, reasoning, toolCalls, usage }
}

/**
 * Executes a list of tool calls requested by the model and records them to the session log.
 * @param ctx Runtime harness context.
 * @param session Active session instance.
 * @param toolCalls Tool calls to execute.
 * @param signal Optional abort signal.
 */
export async function executeStepToolCalls(
	ctx: HarnessContext,
	session: Session,
	toolCalls: ToolCallRecord[],
	signal?: AbortSignal,
): Promise<void> {
	const tools = ctx.tools as ToolService | undefined

	for (const tc of toolCalls) {
		let toolResult: CallToolResult
		if (tools) {
			toolResult = await tools.execute({
				callId: tc.id,
				toolName: tc.name,
				arguments: tc.arguments,
				sessionId: session.id,
				signal,
			})
		} else {
			toolResult = {
				content: [
					{
						type: "text",
						text: `Tool service is not available to execute "${tc.name}".`,
					},
				],
				isError: true,
			}
		}

		await session.append([
			{
				id: crypto.randomUUID(),
				sessionId: session.id,
				timestamp: Date.now(),
				type: "tool_call",
				callId: tc.id,
				toolName: tc.name,
				arguments: tc.arguments,
			},
			{
				id: crypto.randomUUID(),
				sessionId: session.id,
				timestamp: Date.now(),
				type: "tool_result",
				callId: tc.id,
				toolName: tc.name,
				result: toolResult.content,
				isError: Boolean(toolResult.isError),
			},
		])
	}
}

/**
 * Records an assistant message event to the session and builds the TurnStep summary.
 * @param session Active session.
 * @param stepIndex Current step index.
 * @param streamResult Stream output result.
 */
export async function recordStepAssistantMessage(
	session: Session,
	stepIndex: number,
	streamResult: StreamStepResult,
): Promise<TurnStep> {
	const assistantEvent: AssistantMessageEvent = {
		id: crypto.randomUUID(),
		sessionId: session.id,
		timestamp: Date.now(),
		type: "assistant_message",
		content: streamResult.assistantText,
		reasoning: streamResult.reasoning || undefined,
		toolCalls: streamResult.toolCalls.length > 0 ? streamResult.toolCalls : undefined,
		usage: streamResult.usage
			? {
					promptTokens: streamResult.usage.inputTokens,
					completionTokens: streamResult.usage.outputTokens,
					totalTokens: streamResult.usage.inputTokens + streamResult.usage.outputTokens,
				}
			: undefined,
	}

	await session.append([assistantEvent])

	return {
		stepIndex,
		assistantText: streamResult.assistantText,
		reasoning: streamResult.reasoning || undefined,
		toolCalls: streamResult.toolCalls.length > 0 ? streamResult.toolCalls : undefined,
		usage: streamResult.usage,
	}
}
