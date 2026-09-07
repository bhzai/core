import { describe, expect, it, vi } from "vitest"
import type { BHZAIDriver, ChatRequest, DriverEvent } from "../../types/driver"
import { createHarness } from "../kernel/kernel"
import { llmPlugin } from "../llm/plugin"
import type { LlmService } from "../llm/types"
import { sessionPlugin } from "../sessions/plugin"
import type { SessionService } from "../sessions/types"
import { toolsPlugin } from "../tools/plugin"
import type { ToolService } from "../tools/types"
import { agentLoopPlugin } from "./plugin"
import { executeStepToolCalls, recordStepAssistantMessage, streamModelStep } from "./step"
import { executeTurn, resolveWireTools } from "./turn"
import {
	type AgentLoopService,
	type PreStepContext,
	type PreStepPayload,
	TurnBusyError,
	type TurnEndPayload,
	type TurnEndResult,
	type TurnStartPayload,
} from "./types"

function createMockDriver(responses: Array<DriverEvent[]>): BHZAIDriver {
	let callIndex = 0
	return {
		id: "mock",
		async listModels() {
			return [
				{
					id: "mock-model",
					driver: "mock",
					ref: "mock/mock-model",
					capabilities: { streaming: true, toolCalls: true, reasoning: true },
					availability: "ready",
				},
			]
		},
		capabilities() {
			return { streaming: true, toolCalls: true, reasoning: true }
		},
		async *chat(_req: ChatRequest): AsyncIterable<DriverEvent> {
			const events = responses[callIndex] || [
				{ type: "delta", text: "default response" },
				{ type: "done", stopReason: "stop" },
			]
			callIndex++
			for (const ev of events) {
				yield ev
			}
		},
	}
}

describe("resolveWireTools", () => {
	it("returns explicit wire definitions when array is provided", () => {
		const wire = [{ name: "t1", description: "d1", inputSchema: {} }]
		expect(resolveWireTools({} as never, wire)).toBe(wire)
	})

	it("projects wire tools from tools service if available", async () => {
		const harness = await createHarness({ plugins: [toolsPlugin] })
		const tools = harness.ctx.tools as ToolService
		tools.register({
			name: "calc",
			description: "Calculate",
			inputSchema: { type: "object" },
			execute: vi.fn(),
		})

		const projected = resolveWireTools(harness.ctx)
		expect(projected).toEqual([
			{ name: "calc", description: "Calculate", inputSchema: { type: "object" } },
		])
	})

	it("returns undefined if tools service is not registered and no array provided", () => {
		expect(resolveWireTools({} as never, undefined)).toBeUndefined()
	})
})

describe("streamModelStep", () => {
	it("throws if LLM service is not available on context", async () => {
		const harness = await createHarness()
		await expect(
			streamModelStep({
				ctx: harness.ctx,
				sessionId: "s1",
				turnId: "t1",
				stepIndex: 0,
				messages: [],
			}),
		).rejects.toThrow("LLM service is not claimed or available on context.")
	})

	it("streams delta, reasoning, tool-call, and usage events", async () => {
		const harness = await createHarness({ plugins: [llmPlugin] })
		const llm = harness.ctx.llm as LlmService
		const driver = createMockDriver([
			[
				{ type: "reasoning-delta", text: "Thinking deeply..." },
				{ type: "delta", text: "Hello " },
				{ type: "delta", text: "world!" },
				{
					type: "tool-call",
					toolCallId: "call_1",
					name: "ping",
					input: { foo: "bar" },
				},
				{ type: "usage", inputTokens: 10, outputTokens: 5, totalTokens: 15 },
				{ type: "done", stopReason: "tool-calls" },
			],
		])
		llm.addDriver(driver)
		llm.setDefaultModel("mock/mock-model")

		const deltas: string[] = []
		const reasonings: string[] = []
		const toolCalls: unknown[] = []

		harness.ctx.events.on("stream/delta", (payload: { text: string }) => {
			deltas.push(payload.text)
		})
		harness.ctx.events.on("stream/reasoning", (payload: { text: string }) => {
			reasonings.push(payload.text)
		})
		harness.ctx.events.on("stream/tool-call", (payload: { call: unknown }) => {
			toolCalls.push(payload.call)
		})

		const res = await streamModelStep({
			ctx: harness.ctx,
			sessionId: "s1",
			turnId: "t1",
			stepIndex: 0,
			messages: [],
		})

		expect(res.assistantText).toBe("Hello world!")
		expect(res.reasoning).toBe("Thinking deeply...")
		expect(res.toolCalls).toEqual([{ id: "call_1", name: "ping", arguments: '{"foo":"bar"}' }])
		expect(res.usage).toEqual({
			inputTokens: 10,
			outputTokens: 5,
		})

		expect(deltas).toEqual(["Hello ", "world!"])
		expect(reasonings).toEqual(["Thinking deeply..."])
		expect(toolCalls.length).toBe(1)
	})
})

describe("executeStepToolCalls & recordStepAssistantMessage", () => {
	it("records assistant message and executes tool calls into session log", async () => {
		const harness = await createHarness({
			plugins: [sessionPlugin, toolsPlugin],
		})
		const sessions = harness.ctx.sessions as SessionService
		const tools = harness.ctx.tools as ToolService

		const session = await sessions.create()
		tools.register({
			name: "square",
			description: "Squares a number",
			inputSchema: {
				type: "object",
				properties: { n: { type: "number" } },
			},
			execute: ({ params }) => String((params as { n: number }).n ** 2),
		})

		const streamRes = {
			assistantText: "Calculating square",
			reasoning: "Computing...",
			toolCalls: [{ id: "c1", name: "square", arguments: '{"n":7}' }],
			usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 },
		}

		const stepRecord = await recordStepAssistantMessage(session, 0, streamRes)
		expect(stepRecord.stepIndex).toBe(0)
		expect(stepRecord.assistantText).toBe("Calculating square")

		await executeStepToolCalls(harness.ctx, session, streamRes.toolCalls)

		expect(session.getEvents().length).toBe(3)
		expect(session.getEvents()[0].type).toBe("assistant_message")
		expect(session.getEvents()[1].type).toBe("tool_call")
		expect(session.getEvents()[2].type).toBe("tool_result")
		expect((session.getEvents()[2] as { result: unknown }).result).toEqual([
			{ type: "text", text: "49" },
		])
	})

	it("synthesizes error tool result when tools service is not claimed", async () => {
		const harness = await createHarness({ plugins: [sessionPlugin] })
		const sessions = harness.ctx.sessions as SessionService
		const session = await sessions.create()

		await executeStepToolCalls(harness.ctx, session, [
			{ id: "c2", name: "missing_tool", arguments: "{}" },
		])

		expect(session.getEvents().length).toBe(2)
		expect(session.getEvents()[1].type).toBe("tool_result")
		expect((session.getEvents()[1] as { isError: boolean }).isError).toBe(true)
	})
})

describe("executeTurn & runStepLoop", () => {
	it("executes a 1-step turn when model returns no tool calls", async () => {
		const harness = await createHarness({
			plugins: [llmPlugin, sessionPlugin, toolsPlugin],
		})
		const llm = harness.ctx.llm as LlmService
		const sessions = harness.ctx.sessions as SessionService

		const driver = createMockDriver([
			[
				{ type: "delta", text: "Paris is the capital of France." },
				{ type: "done", stopReason: "stop" },
			],
		])
		llm.addDriver(driver)
		llm.setDefaultModel("mock/mock-model")

		const session = await sessions.create()

		const turnStarts: TurnStartPayload[] = []
		harness.ctx.events.on("turn/start", (payload: TurnStartPayload) => {
			turnStarts.push(payload)
		})

		const result = await executeTurn(harness.ctx, session, "What is the capital of France?")

		expect(turnStarts.length).toBe(1)
		expect(turnStarts[0].input).toBe("What is the capital of France?")
		expect(result.text).toBe("Paris is the capital of France.")
		expect(result.steps.length).toBe(1)
		expect(result.maxStepsExceeded).toBeUndefined()
		expect(result.aborted).toBeUndefined()

		// Verify session events: user_message -> assistant_message
		expect(session.getEvents().length).toBe(2)
		expect(session.getEvents()[0].type).toBe("user_message")
		expect(session.getEvents()[1].type).toBe("assistant_message")
	})

	it("executes multi-step turn with tool calls and applies pre-step waterfall", async () => {
		const harness = await createHarness({
			plugins: [llmPlugin, sessionPlugin, toolsPlugin],
		})
		const llm = harness.ctx.llm as LlmService
		const sessions = harness.ctx.sessions as SessionService
		const tools = harness.ctx.tools as ToolService

		tools.register({
			name: "weather",
			description: "Get weather",
			inputSchema: { type: "object", properties: { city: { type: "string" } } },
			execute: () => "Sunny and 22C",
		})

		const driver = createMockDriver([
			// Step 0: Assistant invokes weather tool
			[
				{
					type: "tool-call",
					toolCallId: "call_weather",
					name: "weather",
					input: '{"city":"Paris"}',
				},
				{ type: "done", stopReason: "tool-calls" },
			],
			// Step 1: Assistant receives weather result and answers user
			[
				{ type: "delta", text: "The weather in Paris is sunny and 22C." },
				{ type: "done", stopReason: "stop" },
			],
		])
		llm.addDriver(driver)
		llm.setDefaultModel("mock/mock-model")

		const preStepCalls: number[] = []
		harness.ctx.events.waterfall<PreStepPayload, PreStepContext>(
			"pre-step",
			async (payload, ctx, next) => {
				preStepCalls.push(ctx.stepIndex)
				return await next(payload)
			},
		)

		const session = await sessions.create()
		const result = await executeTurn(harness.ctx, session, "How is the weather in Paris?")

		expect(result.text).toBe("The weather in Paris is sunny and 22C.")
		expect(result.steps.length).toBe(2)
		expect(preStepCalls).toEqual([0, 1])

		// Events: user_message -> assistant_message -> tool_call -> tool_result -> assistant_message
		expect(session.getEvents().length).toBe(5)
		expect(session.getEvents()[0].type).toBe("user_message")
		expect(session.getEvents()[1].type).toBe("assistant_message")
		expect(session.getEvents()[2].type).toBe("tool_call")
		expect(session.getEvents()[3].type).toBe("tool_result")
		expect(session.getEvents()[4].type).toBe("assistant_message")
	})

	it("supports turn/end bail continuation", async () => {
		const harness = await createHarness({
			plugins: [llmPlugin, sessionPlugin, toolsPlugin],
		})
		const llm = harness.ctx.llm as LlmService
		const sessions = harness.ctx.sessions as SessionService

		const driver = createMockDriver([
			[
				{ type: "delta", text: "Step 1 text" },
				{ type: "done", stopReason: "stop" },
			],
			[
				{ type: "delta", text: "Step 2 text" },
				{ type: "done", stopReason: "stop" },
			],
		])
		llm.addDriver(driver)
		llm.setDefaultModel("mock/mock-model")

		let continuationCount = 0
		harness.ctx.events.bail<TurnEndPayload, TurnEndResult>("turn/end", () => {
			if (continuationCount === 0) {
				continuationCount++
				return { followUp: "Can you elaborate further?" }
			}
			return undefined
		})

		const session = await sessions.create()
		const result = await executeTurn(harness.ctx, session, "Start task")

		expect(result.steps.length).toBe(2)
		expect(result.text).toBe("Step 2 text")
		expect(continuationCount).toBe(1)
	})

	it("stops when maxSteps limit is reached", async () => {
		const harness = await createHarness({
			plugins: [llmPlugin, sessionPlugin, toolsPlugin],
		})
		const llm = harness.ctx.llm as LlmService
		const sessions = harness.ctx.sessions as SessionService
		const tools = harness.ctx.tools as ToolService

		tools.register({
			name: "looping_tool",
			description: "Infinite loop",
			inputSchema: { type: "object" },
			execute: () => "again",
		})

		// 3 responses with tool calls
		const driver = createMockDriver([
			[
				{
					type: "tool-call",
					toolCallId: "1",
					name: "looping_tool",
					input: {},
				},
				{ type: "done", stopReason: "tool-calls" },
			],
			[
				{
					type: "tool-call",
					toolCallId: "2",
					name: "looping_tool",
					input: {},
				},
				{ type: "done", stopReason: "tool-calls" },
			],
			[
				{
					type: "tool-call",
					toolCallId: "3",
					name: "looping_tool",
					input: {},
				},
				{ type: "done", stopReason: "tool-calls" },
			],
		])
		llm.addDriver(driver)
		llm.setDefaultModel("mock/mock-model")

		const session = await sessions.create()
		const result = await executeTurn(harness.ctx, session, "Run infinite loop", {
			maxSteps: 2,
		})

		expect(result.maxStepsExceeded).toBe(true)
		expect(result.steps.length).toBe(2)
	})

	it("handles abort signal before and during turn", async () => {
		const harness = await createHarness({
			plugins: [llmPlugin, sessionPlugin, toolsPlugin],
		})
		const sessions = harness.ctx.sessions as SessionService
		const session = await sessions.create()

		const controller = new AbortController()
		controller.abort()

		const result = await executeTurn(harness.ctx, session, "Hello", {
			signal: controller.signal,
		})

		expect(result.aborted).toBe(true)
		expect(result.steps.length).toBe(0)
	})
})

describe("agentLoopPlugin & AgentLoopService", () => {
	it("claims ctx.agentLoop and reports busy status correctly", async () => {
		const harness = await createHarness({
			plugins: [llmPlugin, sessionPlugin, toolsPlugin, agentLoopPlugin],
		})
		const agentLoop = harness.ctx.agentLoop as AgentLoopService
		const sessions = harness.ctx.sessions as SessionService
		const llm = harness.ctx.llm as LlmService

		const driver = createMockDriver([
			[
				{ type: "delta", text: "Response" },
				{ type: "done", stopReason: "stop" },
			],
		])
		llm.addDriver(driver)
		llm.setDefaultModel("mock/mock-model")

		expect(agentLoop).toBeDefined()
		expect(agentLoop.isBusy()).toBe(false)

		const session = await sessions.create()
		expect(agentLoop.isBusy(session.id)).toBe(false)

		const turnPromise = agentLoop.runTurn(session.id, "Hi")
		expect(agentLoop.isBusy(session.id)).toBe(true)

		const result = await turnPromise
		expect(result.text).toBe("Response")
		expect(agentLoop.isBusy(session.id)).toBe(false)
	})

	it("throws TurnBusyError on concurrent turn execution for the same session", async () => {
		const harness = await createHarness({
			plugins: [llmPlugin, sessionPlugin, toolsPlugin, agentLoopPlugin],
		})
		const agentLoop = harness.ctx.agentLoop as AgentLoopService
		const sessions = harness.ctx.sessions as SessionService
		const llm = harness.ctx.llm as LlmService

		// Simulate slower turn
		const driver = {
			id: "slow",
			async listModels() {
				return [
					{
						id: "m",
						driver: "slow",
						ref: "slow/m",
						capabilities: { streaming: true, toolCalls: false, reasoning: false },
						availability: "ready" as const,
					},
				]
			},
			capabilities() {
				return { streaming: true, toolCalls: false, reasoning: false }
			},
			async *chat(): AsyncIterable<DriverEvent> {
				await new Promise((r) => setTimeout(r, 30))
				yield { type: "delta", text: "done" }
				yield { type: "done", stopReason: "stop" }
			},
		}
		llm.addDriver(driver)
		llm.setDefaultModel("slow/m")

		const session = await sessions.create()
		const turn1 = agentLoop.runTurn(session.id, "First")

		await expect(agentLoop.runTurn(session.id, "Second")).rejects.toThrow(TurnBusyError)

		await turn1
		expect(agentLoop.isBusy(session.id)).toBe(false)
	})
})
