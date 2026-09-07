import { describe, expect, it } from "vitest"
import { createHarness } from "../kernel/kernel"
import type { LlmService } from "../llm/types"
import { sessionPlugin } from "../sessions/plugin"
import { deriveMessages } from "../sessions/projection"
import type { SessionEvent } from "../sessions/types"
import {
	ContextOverflowError,
	ContextTracker,
	TokenizerServiceImpl,
	contextTrackingPlugin,
	tokenizerPlugin,
} from "./index"
import type { Tokenizer } from "./types"

const WHITESPACE_REGEX = /\s+/

describe("TokenizerService", () => {
	it("estimates text tokens using default heuristic tokenizer", async () => {
		const service = new TokenizerServiceImpl()
		const count = await service.countTokens("Hello world! This is a test.")
		expect(count).toBe(Math.ceil("Hello world! This is a test.".length / 4))
		expect(await service.countTokens("")).toBe(0)
	})

	it("supports pluggable custom tokenizer backends", async () => {
		const service = new TokenizerServiceImpl()
		const customTokenizer: Tokenizer = {
			name: "mock-bpe",
			countTokens: (text: string) => text.split(WHITESPACE_REGEX).filter(Boolean).length,
		}

		const unregister = service.registerBackend("mock-bpe", customTokenizer)
		expect(service.getBackend()?.name).toBe("mock-bpe")

		const count = await service.countTokens("one two three four")
		expect(count).toBe(4)

		unregister()
		expect(service.getBackend()?.name).toBe("heuristic")
	})

	it("estimates message, tool, and event token counts", async () => {
		const service = new TokenizerServiceImpl()

		const msgs = deriveMessages([
			{
				id: "m1",
				sessionId: "s1",
				timestamp: 1,
				type: "user_message",
				content: "Hello",
			},
		])
		msgs[0].meta.reasoning = "some reasoning text"
		msgs[0].meta.toolCalls = [{ id: "c1", name: "ping", arguments: "{}" }]
		const msgTokens = await service.estimateMessage(msgs[0])
		expect(msgTokens).toBeGreaterThan(0)

		const toolTokens = await service.estimateTools([
			{
				name: "testTool",
				description: "a tool description",
				inputSchema: { type: "object" },
			},
		])
		expect(toolTokens).toBeGreaterThan(10)

		const userEvtTokens = await service.estimateEvent({
			id: "e1",
			sessionId: "s1",
			timestamp: 100,
			type: "user_message",
			content: "User message text",
		})
		expect(userEvtTokens).toBeGreaterThan(0)

		const asstEvtWithUsage = await service.estimateEvent({
			id: "e2",
			sessionId: "s1",
			timestamp: 101,
			type: "assistant_message",
			content: "Assistant response",
			usage: { completionTokens: 42 },
		})
		expect(asstEvtWithUsage).toBe(42)

		const toolCallTokens = await service.estimateEvent({
			id: "e3",
			sessionId: "s1",
			timestamp: 102,
			type: "tool_call",
			callId: "c1",
			toolName: "calculator",
			arguments: { a: 1, b: 2 },
		})
		expect(toolCallTokens).toBeGreaterThan(0)

		const toolResultTokens = await service.estimateEvent({
			id: "e4",
			sessionId: "s1",
			timestamp: 103,
			type: "tool_result",
			callId: "c1",
			toolName: "calculator",
			result: { sum: 3 },
			isError: false,
		})
		expect(toolResultTokens).toBeGreaterThan(0)

		const boundaryTokens = await service.estimateEvent({
			id: "e5",
			sessionId: "s1",
			timestamp: 104,
			type: "compaction_boundary",
			summary: "Prior conversation summary",
			compactedThroughEventId: "e4",
		})
		expect(boundaryTokens).toBeGreaterThan(0)

		const blockUserTokens = await service.estimateEvent({
			id: "e-blocks",
			sessionId: "s1",
			timestamp: 105,
			type: "user_message",
			content: [
				{ type: "text", text: "Hello text block" },
				{ type: "image", mimeType: "image/png", data: "base64..." },
			],
		})
		expect(blockUserTokens).toBeGreaterThan(0)

		const asstWithoutUsage = await service.estimateEvent({
			id: "e-asst-no-usage",
			sessionId: "s1",
			timestamp: 106,
			type: "assistant_message",
			content: "I will calculate",
			reasoning: "Thinking steps",
			toolCalls: [{ id: "c1", name: "calc", arguments: "{}" }],
		})
		expect(asstWithoutUsage).toBeGreaterThan(0)

		expect(await service.estimateTools([])).toBe(0)

		const defaultTokens = await service.estimateEvent({
			id: "e6",
			sessionId: "s1",
			timestamp: 107,
			type: "model_change",
			modelRef: "test/m1",
		})
		expect(defaultTokens).toBe(1)
	})
})

describe("ContextTracker & Reconciliation", () => {
	it("records newly appended events and stores token estimates", async () => {
		const tokenizer = new TokenizerServiceImpl()
		const tracker = new ContextTracker(tokenizer)

		const events: SessionEvent[] = [
			{
				id: "u1",
				sessionId: "s1",
				timestamp: 100,
				type: "user_message",
				content: "Hello there",
			},
		]

		await tracker.recordEvents("s1", events)
		const state = tracker.getSessionState("s1")
		expect(state).toBeDefined()
		expect(state?.unreconciledEventIds).toEqual(["u1"])
		const tokens = tracker.getEventTokens("s1", "u1")
		expect(tokens).toBeDefined()
		expect(tokens ?? 0).toBeGreaterThan(0)
	})

	it("bounds estimation drift strictly to a single step during reconciliation", async () => {
		const tokenizer = new TokenizerServiceImpl()
		const tracker = new ContextTracker(tokenizer)

		await tracker.recordEvents("s1", [
			{
				id: "u1",
				sessionId: "s1",
				timestamp: 100,
				type: "user_message",
				content: "What is 2 + 2?",
			},
		])

		const initialEstimate = tracker.getEventTokens("s1", "u1")
		expect(initialEstimate).toBeDefined()
		expect(initialEstimate ?? 0).toBeGreaterThan(0)

		// Step 1: Model reports real promptTokens = 25
		tracker.reconcile("s1", 25, "u1")

		const stateAfterStep1 = tracker.getSessionState("s1")
		expect(stateAfterStep1).toBeDefined()
		expect(stateAfterStep1?.lastGroundTruthPromptTokens).toBe(25)
		expect(stateAfterStep1?.lastGroundTruthEventId).toBe("u1")
		expect(stateAfterStep1?.unreconciledEventIds.length).toBe(0)
		expect(tracker.getEventTokens("s1", "u1")).toBe(25)

		// Step 2: New tool call & result are appended
		await tracker.recordEvents("s1", [
			{
				id: "a1",
				sessionId: "s1",
				timestamp: 101,
				type: "assistant_message",
				content: "Calculating...",
				usage: { completionTokens: 10 },
			},
			{
				id: "tc1",
				sessionId: "s1",
				timestamp: 102,
				type: "tool_call",
				callId: "c1",
				toolName: "calc",
				arguments: { expr: "2+2" },
			},
			{
				id: "tr1",
				sessionId: "s1",
				timestamp: 103,
				type: "tool_result",
				callId: "c1",
				toolName: "calc",
				result: "4",
				isError: false,
			},
		])

		const budgetBeforeStep2 = await tracker.computeBudget("s1")
		expect(budgetBeforeStep2.groundTruthTokens).toBe(25)
		expect(budgetBeforeStep2.totalTokens).toBeGreaterThan(25)

		// Step 2 completes with driver promptTokens = 45
		tracker.reconcile("s1", 45, "tr1")

		const stateAfterStep2 = tracker.getSessionState("s1")
		expect(stateAfterStep2).toBeDefined()
		expect(stateAfterStep2?.lastGroundTruthPromptTokens).toBe(45)
		expect(stateAfterStep2?.lastGroundTruthEventId).toBe("tr1")
		expect(stateAfterStep2?.unreconciledEventIds.length).toBe(0)

		const budgetAfterStep2 = await tracker.computeBudget("s1")
		expect(budgetAfterStep2.totalTokens).toBe(45)
		expect(budgetAfterStep2.estimatedDeltaTokens).toBe(0)
	})

	it("automatically reconciles when assistant message carries usage.promptTokens", async () => {
		const tokenizer = new TokenizerServiceImpl()
		const tracker = new ContextTracker(tokenizer)
		await tracker.recordEvents("s2", [
			{ id: "u1", sessionId: "s2", timestamp: 1, type: "user_message", content: "Hi" },
			{
				id: "a1",
				sessionId: "s2",
				timestamp: 2,
				type: "assistant_message",
				content: "Hello",
				usage: { promptTokens: 30, completionTokens: 8 },
			},
		])
		expect(tracker.getSessionState("s2")?.lastGroundTruthPromptTokens).toBe(30)
		expect(tracker.getEventTokens("s2", "a1")).toBe(8)
	})

	it("computes budget with utilization, remaining tokens, and warning thresholds", async () => {
		const tokenizer = new TokenizerServiceImpl()
		const mockLlm = {
			resolveModel: async () => ({
				driver: {
					capabilities: () => ({
						streaming: true,
						toolCalls: true,
						reasoning: false,
						contextWindow: 100,
					}),
				},
				model: "m1",
				qualifiedRef: "test/m1",
			}),
		}

		const tracker = new ContextTracker(
			tokenizer,
			() => mockLlm as unknown as LlmService,
			() => undefined,
		)

		await tracker.recordEvents("s1", [
			{
				id: "u1",
				sessionId: "s1",
				timestamp: 100,
				type: "user_message",
				content: "x".repeat(120),
			},
		])

		const budget = await tracker.computeBudget("s1", {
			model: "test/m1",
			systemPrompt: "System instruction",
			warningThreshold: 0.5,
		})

		expect(budget.contextWindow).toBe(100)
		expect(budget.totalTokens).toBeGreaterThan(30)
		expect(budget.remainingTokens).toBe(100 - budget.totalTokens)
		expect(budget.utilization).toBe(budget.totalTokens / 100)
		expect(budget.isNearLimit).toBe(budget.utilization >= 0.5)
		expect(budget.isOverflow).toBe(false)
	})

	it("checkLimit throws ContextOverflowError when context window is exceeded", async () => {
		const tokenizer = new TokenizerServiceImpl()
		const mockLlm = {
			resolveModel: async () => ({
				driver: {
					capabilities: () => ({
						streaming: true,
						toolCalls: true,
						reasoning: false,
						contextWindow: 20,
					}),
				},
				model: "m1",
				qualifiedRef: "test/m1",
			}),
		}

		const tracker = new ContextTracker(
			tokenizer,
			() => mockLlm as unknown as LlmService,
			() => undefined,
		)

		await tracker.recordEvents("s1", [
			{
				id: "u1",
				sessionId: "s1",
				timestamp: 100,
				type: "user_message",
				content: "x".repeat(200),
			},
		])

		await expect(tracker.checkLimit("s1", { model: "test/m1" })).rejects.toThrow(
			ContextOverflowError,
		)
	})

	it("resets tracking state on reset()", async () => {
		const tokenizer = new TokenizerServiceImpl()
		const tracker = new ContextTracker(tokenizer)

		await tracker.recordEvents("s1", [
			{
				id: "u1",
				sessionId: "s1",
				timestamp: 100,
				type: "user_message",
				content: "hi",
			},
		])

		expect(tracker.getSessionState("s1")).toBeDefined()
		tracker.reset("s1")
		expect(tracker.getSessionState("s1")).toBeUndefined()
	})
})

describe("Context plugins & Kernel Integration", () => {
	it("registers tokenizer and contextTracking plugins in the kernel", async () => {
		const harness = await createHarness({
			plugins: [sessionPlugin, tokenizerPlugin, contextTrackingPlugin],
		})

		expect(harness.ctx.tokenizer).toBeDefined()
		expect(harness.ctx.contextTracking).toBeDefined()

		const sessions = harness.ctx.sessions
		const contextTracking = harness.ctx.contextTracking
		if (!sessions || !contextTracking) {
			throw new Error("Required services not registered.")
		}

		const updatedPromise = new Promise<void>((resolve) => {
			harness.ctx.events.on("context/updated", () => resolve())
		})

		const session = await sessions.create({ id: "test-sess" })
		await session.append([
			{
				id: "msg1",
				sessionId: session.id,
				timestamp: Date.now(),
				type: "user_message",
				content: "Hello context tracking!",
			},
		])
		await updatedPromise

		const state = contextTracking.getSessionState(session.id)
		expect(state).toBeDefined()
		expect(state?.eventTokens.get("msg1")).toBeGreaterThan(0)

		const budget = await contextTracking.computeBudget(session.id)
		expect(budget.totalTokens).toBeGreaterThan(0)

		await sessions.delete(session.id)
		expect(contextTracking.getSessionState(session.id)).toBeUndefined()

		await harness.dispose()
	})

	it("integrates with pre-step waterfall emitting context/budget", async () => {
		const harness = await createHarness({
			plugins: [sessionPlugin, tokenizerPlugin, contextTrackingPlugin],
		})

		const sessions = harness.ctx.sessions
		if (!sessions) {
			throw new Error("Missing sessions service.")
		}

		let budgetReceived = false
		harness.ctx.events.on("context/budget", () => {
			budgetReceived = true
		})

		const session = await sessions.create({ id: "wf-sess" })
		await session.append([
			{
				id: "m1",
				sessionId: session.id,
				timestamp: Date.now(),
				type: "user_message",
				content: "Ping",
			},
		])

		await harness.ctx.events.runWaterfall(
			"pre-step",
			{
				stepIndex: 0,
				messages: session.deriveMessages(),
				systemPrompt: "Base prompt",
			},
			{ sessionId: session.id, turnId: "t1", stepIndex: 0 },
		)

		expect(budgetReceived).toBe(true)
		await harness.dispose()
	})

	it("throws if tokenizer service is not claimed before contextTracking", async () => {
		await expect(
			createHarness({
				plugins: [sessionPlugin, { name: "tokenizer", setup: () => {} }, contextTrackingPlugin],
			}),
		).rejects.toThrow("Tokenizer service must be claimed prior to contextTracking.")
	})
})
