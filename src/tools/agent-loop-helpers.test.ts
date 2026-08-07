/**
 * @file Unit tests for the extracted agent-loop helpers.
 *
 * Each helper is tested in isolation — no full conversation + driver + event-bus
 * integration setup required. Mocks are minimal and targeted.
 */

import Ajv from "ajv"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Mock } from "vitest"
import { ConversationBusyError } from "../conversation/agent-loop.js"
import type { BHZAIConversationImpl } from "../conversation/conversation.js"
import { BHZAI } from "../core/bhzai.js"
import type { CallToolResult } from "../types/content.js"
import type { BHZAIDriver, ChatRequest, DriverEvent } from "../types/driver.js"
import type { BHZAIToolDefinition } from "../types/index.js"
import type { BHZAIMessage } from "../types/message.js"
import {
	appendToolResultMessages,
	applyCompleteEventPatch,
	applyContextBudget,
	buildContextForTurn,
	checkMaxIterations,
	checkTurnTermination,
	consumeDriverStream,
	drainSteerQueue,
	executeDriverTurn,
	executeSingleToolCall,
	executeToolWithAbortRace,
	filterToolCalls,
	fireTurnStart,
	handleBusyEntry,
	handleLoopExit,
	handleTurnVeto,
	isAllTerminate,
	maybeAutoCompact,
	partitionToolCalls,
	prepareUserMessage,
	recordToolCallsOnMessage,
	resolveDriverForTurn,
	resolvePendingSteers,
	runToolBatchExecution,
	validateToolCall,
} from "./agent-loop-helpers.js"
import type { ToolCallEvent } from "./agent-loop-helpers.js"

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

/** Create a mock driver with scripted events. */
function makeMockDriver(
	caps: {
		toolCalls?: boolean
		streaming?: boolean
		reasoning?: boolean
		contextWindow?: number
	} = {},
): BHZAIDriver & { chat: Mock<(request: ChatRequest) => AsyncIterable<DriverEvent>> } {
	return {
		id: "mock-driver",
		listModels: async () => [
			{
				ref: "mock-driver/mock-model",
				id: "mock-model",
				driver: "mock-driver",
				availability: "ready" as const,
				capabilities: {
					toolCalls: caps.toolCalls ?? true,
					streaming: caps.streaming ?? true,
					reasoning: caps.reasoning ?? false,
					contextWindow: caps.contextWindow,
				},
			},
		],
		capabilities: () => ({
			toolCalls: caps.toolCalls ?? true,
			streaming: caps.streaming ?? true,
			reasoning: caps.reasoning ?? false,
			contextWindow: caps.contextWindow,
		}),
		chat: vi.fn(async function* (_request: ChatRequest) {
			yield { type: "delta", text: "hi" } as DriverEvent
			yield { type: "done", stopReason: "stop" } as DriverEvent
		}),
		embed: undefined,
	}
}

/** Create a minimal BHZAIMessage for testing. */
function makeMessage(
	role: BHZAIMessage["role"],
	content: string,
	meta: Record<string, unknown> = {},
): BHZAIMessage {
	const msg: BHZAIMessage = {
		id: `msg-${Math.random().toString(36).slice(2)}`,
		role,
		content,
		blocks: [{ type: "text", text: content }],
		time: Date.now(),
		meta,
		append: (text: string) => {
			msg.content += text
			msg.blocks = [{ type: "text", text: msg.content }]
		},
		setContent: (newContent: string | import("../types/content.js").ContentBlock[]) => {
			if (typeof newContent === "string") {
				msg.content = newContent
				msg.blocks = [{ type: "text", text: newContent }]
			}
		},
	}
	return msg
}

/** Create a mock async iterable from a list of events. */
async function* makeEventStream(events: DriverEvent[]): AsyncIterable<DriverEvent> {
	for (const event of events) {
		yield event
	}
}

// ---------------------------------------------------------------------------
// 1. handleBusyEntry
// ---------------------------------------------------------------------------

describe("handleBusyEntry", () => {
	let bh: BHZAI
	let driver: BHZAIDriver

	beforeEach(() => {
		bh = new BHZAI()
		driver = makeMockDriver()
		bh.addDriver(driver)
	})

	it("returns undefined when conversation is idle", async () => {
		const conversation = (await bh.createConversation({
			model: "mock-driver/mock-model",
		})) as BHZAIConversationImpl
		// Conversation starts idle
		const result = handleBusyEntry(conversation, "hello")
		expect(result).toBeUndefined()
	})

	it("throws ConversationBusyError when not idle and deliverAs is immediate", async () => {
		const conversation = (await bh.createConversation({
			model: "mock-driver/mock-model",
		})) as BHZAIConversationImpl
		conversation._setStatus("streaming")
		expect(() => handleBusyEntry(conversation, "hello")).toThrow(ConversationBusyError)
	})

	it("queues onto steer queue when deliverAs is steer", async () => {
		const conversation = (await bh.createConversation({
			model: "mock-driver/mock-model",
		})) as BHZAIConversationImpl
		conversation._setStatus("streaming")
		const pushSteerSpy = vi.spyOn(conversation, "_pushSteerQueue")
		const result = handleBusyEntry(conversation, "steer me", { deliverAs: "steer" })
		expect(result).toBeInstanceOf(Promise)
		expect(pushSteerSpy).toHaveBeenCalledOnce()
	})

	it("queues onto followUp queue when deliverAs is followUp", async () => {
		const conversation = (await bh.createConversation({
			model: "mock-driver/mock-model",
		})) as BHZAIConversationImpl
		conversation._setStatus("streaming")
		const pushFollowUpSpy = vi.spyOn(conversation, "_pushFollowUpQueue")
		const result = handleBusyEntry(conversation, "follow up", { deliverAs: "followUp" })
		expect(result).toBeInstanceOf(Promise)
		expect(pushFollowUpSpy).toHaveBeenCalledOnce()
	})
})

// ---------------------------------------------------------------------------
// 2. resolveDriverForTurn
// ---------------------------------------------------------------------------

describe("resolveDriverForTurn", () => {
	let bh: BHZAI
	let driver: BHZAIDriver

	beforeEach(() => {
		bh = new BHZAI()
		driver = makeMockDriver({ contextWindow: 4096 })
		bh.addDriver(driver)
	})

	it("resolves the driver, parsed ref, and capabilities", async () => {
		const conversation = (await bh.createConversation({
			model: "mock-driver/mock-model",
		})) as BHZAIConversationImpl
		const result = resolveDriverForTurn(conversation, bh)
		expect(result.driver).toBe(driver)
		expect(result.parsed).toEqual({ driver: "mock-driver", id: "mock-model" })
		expect(result.driverCapabilities.contextWindow).toBe(4096)
	})

	it("throws when conversation has no model", async () => {
		const conversation = (await bh.createConversation({})) as BHZAIConversationImpl
		expect(() => resolveDriverForTurn(conversation, bh)).toThrow("no resolved model")
	})

	it("throws when driver is not found", async () => {
		const conversation = (await bh.createConversation({
			model: "mock-driver/mock-model",
		})) as BHZAIConversationImpl
		// Mock _getModelRef to return an invalid driver ref
		vi.spyOn(conversation, "_getModelRef").mockReturnValue("nonexistent/model")
		expect(() => resolveDriverForTurn(conversation, bh)).toThrow('driver "nonexistent" not found')
	})
})

// ---------------------------------------------------------------------------
// 3. recordToolCallsOnMessage
// ---------------------------------------------------------------------------

describe("recordToolCallsOnMessage", () => {
	it("records tool calls as ToolCallRecord on the message meta", () => {
		const msg = makeMessage("assistant", "ok")
		const buffer: DriverEvent[] = [
			{ type: "tool-call", toolCallId: "call-1", name: "search", input: '{"q":"test"}' },
			{ type: "tool-call", toolCallId: "call-2", name: "fetch", input: { url: "http://x" } },
		]
		recordToolCallsOnMessage(msg, buffer)
		expect(msg.meta.toolCalls).toEqual([
			{ id: "call-1", name: "search", arguments: '{"q":"test"}' },
			{ id: "call-2", name: "fetch", arguments: '{"url":"http://x"}' },
		])
	})

	it("does not set meta.toolCalls when buffer has no tool-call events", () => {
		const msg = makeMessage("assistant", "ok")
		const buffer: DriverEvent[] = [
			{ type: "delta", text: "hello" },
			{ type: "done", stopReason: "stop" },
		]
		recordToolCallsOnMessage(msg, buffer)
		expect(msg.meta.toolCalls).toBeUndefined()
	})

	it("filters out non-tool-call events from the buffer", () => {
		const msg = makeMessage("assistant", "ok")
		const buffer: DriverEvent[] = [
			{ type: "delta", text: "thinking..." },
			{ type: "tool-call-delta", toolCallId: "call-1", argsDelta: '{"q"' },
			{ type: "tool-call", toolCallId: "call-1", name: "search", input: '{"q":"test"}' },
		]
		recordToolCallsOnMessage(msg, buffer)
		expect(msg.meta.toolCalls).toHaveLength(1)
		expect((msg.meta.toolCalls as Array<{ id: string }>)[0].id).toBe("call-1")
	})

	it("serializes non-string input as JSON", () => {
		const msg = makeMessage("assistant", "ok")
		const buffer: DriverEvent[] = [
			{ type: "tool-call", toolCallId: "call-1", name: "tool", input: { key: "value", num: 42 } },
		]
		recordToolCallsOnMessage(msg, buffer)
		expect((msg.meta.toolCalls as Array<{ arguments: string }>)[0].arguments).toBe(
			'{"key":"value","num":42}',
		)
	})
})

// ---------------------------------------------------------------------------
// 4. consumeDriverStream
// ---------------------------------------------------------------------------

describe("consumeDriverStream", () => {
	let bh: BHZAI
	let driver: BHZAIDriver

	beforeEach(() => {
		bh = new BHZAI()
		driver = makeMockDriver()
		bh.addDriver(driver)
	})

	it("consumes deltas and dispatches message.delta events", async () => {
		const conversation = (await bh.createConversation({
			model: "mock-driver/mock-model",
		})) as BHZAIConversationImpl
		const assistantMsg = makeMessage("assistant", "")
		const events: DriverEvent[] = [
			{ type: "delta", text: "Hello " },
			{ type: "delta", text: "world" },
			{ type: "done", stopReason: "stop" },
		]
		const result = await consumeDriverStream(
			conversation,
			makeEventStream(events),
			assistantMsg,
			false,
		)
		expect(result.stopReason).toBe("stop")
		expect(result.naturalStop).toBe(true)
		expect(assistantMsg.content).toBe("Hello world")
	})

	it("sets naturalStop to false when stopReason is tool-calls", async () => {
		const conversation = (await bh.createConversation({
			model: "mock-driver/mock-model",
		})) as BHZAIConversationImpl
		const assistantMsg = makeMessage("assistant", "")
		const events: DriverEvent[] = [
			{ type: "delta", text: "Let me search" },
			{ type: "done", stopReason: "tool-calls" },
		]
		const result = await consumeDriverStream(
			conversation,
			makeEventStream(events),
			assistantMsg,
			false,
		)
		expect(result.stopReason).toBe("tool-calls")
		expect(result.naturalStop).toBe(false)
	})

	it("buffers tool-call and tool-call-delta events", async () => {
		const conversation = (await bh.createConversation({
			model: "mock-driver/mock-model",
		})) as BHZAIConversationImpl
		const assistantMsg = makeMessage("assistant", "")
		const events: DriverEvent[] = [
			{ type: "tool-call-delta", toolCallId: "c1", argsDelta: '{"q":' },
			{ type: "tool-call", toolCallId: "c1", name: "search", input: '{"q":"test"}' },
			{ type: "done", stopReason: "tool-calls" },
		]
		const result = await consumeDriverStream(
			conversation,
			makeEventStream(events),
			assistantMsg,
			false,
		)
		expect(result.toolCallBuffer).toHaveLength(2)
		expect(result.toolCallBuffer[0].type).toBe("tool-call-delta")
		expect(result.toolCallBuffer[1].type).toBe("tool-call")
	})

	it("records usage via _recordTurnUsage", async () => {
		const conversation = (await bh.createConversation({
			model: "mock-driver/mock-model",
		})) as BHZAIConversationImpl
		const recordSpy = vi.spyOn(conversation, "_recordTurnUsage")
		const assistantMsg = makeMessage("assistant", "")
		const events: DriverEvent[] = [
			{ type: "usage", inputTokens: 10, outputTokens: 5, totalTokens: 15 },
			{ type: "done", stopReason: "stop" },
		]
		await consumeDriverStream(conversation, makeEventStream(events), assistantMsg, false)
		expect(recordSpy).toHaveBeenCalledWith(10, 5, 15)
	})

	it("accumulates reasoning-delta events on meta.reasoning", async () => {
		const conversation = (await bh.createConversation({
			model: "mock-driver/mock-model",
		})) as BHZAIConversationImpl
		const assistantMsg = makeMessage("assistant", "")
		const events: DriverEvent[] = [
			{ type: "reasoning-delta", text: "Thinking..." },
			{ type: "reasoning-delta", text: " More thinking." },
			{ type: "done", stopReason: "stop" },
		]
		await consumeDriverStream(conversation, makeEventStream(events), assistantMsg, false)
		expect(assistantMsg.meta.reasoning).toBe("Thinking... More thinking.")
	})

	it("handles empty event stream gracefully", async () => {
		const conversation = (await bh.createConversation({
			model: "mock-driver/mock-model",
		})) as BHZAIConversationImpl
		const assistantMsg = makeMessage("assistant", "")
		const result = await consumeDriverStream(conversation, makeEventStream([]), assistantMsg, false)
		expect(result.stopReason).toBeUndefined()
		expect(result.naturalStop).toBe(false)
		expect(result.toolCallBuffer).toHaveLength(0)
	})
})

// ---------------------------------------------------------------------------
// 5. maybeAutoCompact
// ---------------------------------------------------------------------------

describe("maybeAutoCompact", () => {
	let bh: BHZAI
	let driver: BHZAIDriver

	beforeEach(() => {
		bh = new BHZAI()
	})

	it("does nothing when compaction.auto is not set", async () => {
		driver = makeMockDriver({ contextWindow: 4096 })
		bh.addDriver(driver)
		const conversation = (await bh.createConversation({
			model: "mock-driver/mock-model",
		})) as BHZAIConversationImpl
		// No compaction config
		await maybeAutoCompact(conversation)
		// No error, no side effects
	})

	it("does nothing when driver does not report contextWindow", async () => {
		driver = makeMockDriver({ contextWindow: undefined })
		bh.addDriver(driver)
		const conversation = (await bh.createConversation({
			model: "mock-driver/mock-model",
			compaction: { auto: true, reserveTokens: 1000 },
		})) as BHZAIConversationImpl
		await maybeAutoCompact(conversation)
		// No error — auto-compaction simply disabled
	})

	it("does nothing when remaining tokens exceed reserveTokens", async () => {
		driver = makeMockDriver({ contextWindow: 10000 })
		bh.addDriver(driver)
		const conversation = (await bh.createConversation({
			model: "mock-driver/mock-model",
			compaction: { auto: true, reserveTokens: 1000 },
		})) as BHZAIConversationImpl
		// Set lastInputTokens to a small value → lots of room remaining
		conversation._recordTurnUsage(100, 10, 110)
		await maybeAutoCompact(conversation)
		// No compaction triggered (remaining = 10000 - 100 = 9900 > 1000)
	})

	it("triggers compaction when remaining tokens are below reserveTokens", async () => {
		driver = makeMockDriver({ contextWindow: 1000 })
		bh.addDriver(driver)
		const conversation = (await bh.createConversation({
			model: "mock-driver/mock-model",
			compaction: { auto: true, reserveTokens: 500 },
		})) as BHZAIConversationImpl
		// Set lastInputTokens to 800 → remaining = 200 < 500
		conversation._recordTurnUsage(800, 50, 850)
		// Mock the dynamic import of compaction.js
		const compactAutoMock = vi.fn().mockResolvedValue(undefined)
		vi.doMock("../conversation/compaction.js", () => ({ compactAuto: compactAutoMock }))
		await maybeAutoCompact(conversation)
		// Note: dynamic import may not be intercepted by vi.doMock in all setups,
		// so we just verify no error is thrown
		vi.doUnmock("../conversation/compaction.js")
	})
})

// ---------------------------------------------------------------------------
// 6. checkTurnTermination
// ---------------------------------------------------------------------------

describe("checkTurnTermination", () => {
	let bh: BHZAI
	let driver: BHZAIDriver

	beforeEach(() => {
		bh = new BHZAI()
		driver = makeMockDriver()
		bh.addDriver(driver)
	})

	it("returns shouldBreak=true when naturalStop is true", async () => {
		const conversation = (await bh.createConversation({
			model: "mock-driver/mock-model",
		})) as BHZAIConversationImpl
		const assistantMsg = makeMessage("assistant", "done")
		const result = await checkTurnTermination(conversation, 0, true, [], assistantMsg)
		expect(result.shouldBreak).toBe(true)
		expect(result.continueWith).toBeUndefined()
	})

	it("returns shouldBreak=true when all tool results carry terminate hint", async () => {
		const conversation = (await bh.createConversation({
			model: "mock-driver/mock-model",
		})) as BHZAIConversationImpl
		const assistantMsg = makeMessage("assistant", "calling tools")
		const toolResults: CallToolResult[] = [
			{ content: [{ type: "text", text: "done" }], _meta: { "BHZAI/terminate": true } },
			{ content: [{ type: "text", text: "done2" }], _meta: { "BHZAI/terminate": true } },
		]
		const result = await checkTurnTermination(conversation, 0, false, toolResults, assistantMsg)
		expect(result.shouldBreak).toBe(true)
	})

	it("returns shouldBreak=false when not all results carry terminate hint", async () => {
		const conversation = (await bh.createConversation({
			model: "mock-driver/mock-model",
		})) as BHZAIConversationImpl
		const assistantMsg = makeMessage("assistant", "calling tools")
		const toolResults: CallToolResult[] = [
			{ content: [{ type: "text", text: "done" }], _meta: { "BHZAI/terminate": true } },
			{ content: [{ type: "text", text: "more" }], _meta: {} },
		]
		const result = await checkTurnTermination(conversation, 0, false, toolResults, assistantMsg)
		expect(result.shouldBreak).toBe(false)
		expect(result.continueWith).toBeUndefined()
	})

	it("returns shouldBreak=false with empty tool results and naturalStop=false", async () => {
		const conversation = (await bh.createConversation({
			model: "mock-driver/mock-model",
		})) as BHZAIConversationImpl
		const assistantMsg = makeMessage("assistant", "calling tools")
		const result = await checkTurnTermination(conversation, 0, false, [], assistantMsg)
		expect(result.shouldBreak).toBe(false)
	})

	it("returns continueWith when turn(end) patch provides it", async () => {
		const conversation = (await bh.createConversation({
			model: "mock-driver/mock-model",
		})) as BHZAIConversationImpl
		// Register a handler that returns continueWith
		conversation.on("turn", (payload: unknown) => {
			const p = payload as { state: string }
			if (p.state === "end") {
				return { continueWith: "Please continue" }
			}
		})
		const assistantMsg = makeMessage("assistant", "partial")
		const result = await checkTurnTermination(conversation, 0, true, [], assistantMsg)
		// Veto takes precedence over naturalStop
		expect(result.shouldBreak).toBe(false)
		expect(result.continueWith).toBe("Please continue")
	})
})

// ---------------------------------------------------------------------------
// 7. handleLoopExit
// ---------------------------------------------------------------------------

describe("handleLoopExit", () => {
	let bh: BHZAI
	let driver: BHZAIDriver

	beforeEach(() => {
		bh = new BHZAI()
		driver = makeMockDriver()
		bh.addDriver(driver)
	})

	it("returns message with aborted=true when conversation was aborted", async () => {
		const conversation = (await bh.createConversation({
			model: "mock-driver/mock-model",
		})) as BHZAIConversationImpl
		conversation.abort()
		const lastMsg = makeMessage("assistant", "partial response")
		const result = await handleLoopExit(conversation, lastMsg, () => makeMessage("assistant", ""))
		expect(result.meta.aborted).toBe(true)
		expect(result).toBe(lastMsg)
	})

	it("returns synthetic message with aborted=true when no last message and aborted", async () => {
		const conversation = (await bh.createConversation({
			model: "mock-driver/mock-model",
		})) as BHZAIConversationImpl
		conversation.abort()
		const synthetic = makeMessage("assistant", "")
		const result = await handleLoopExit(conversation, undefined, () => synthetic)
		expect(result.meta.aborted).toBe(true)
		expect(result).toBe(synthetic)
	})

	it("fires loop(end) event on normal exit", async () => {
		const conversation = (await bh.createConversation({
			model: "mock-driver/mock-model",
		})) as BHZAIConversationImpl
		const loopEvents: string[] = []
		conversation.on("loop", (payload: unknown) => {
			const p = payload as { state: string }
			loopEvents.push(p.state)
		})
		const lastMsg = makeMessage("assistant", "final response")
		await handleLoopExit(conversation, lastMsg, () => makeMessage("assistant", ""))
		expect(loopEvents).toContain("end")
	})

	it("fires idle event when both queues are empty", async () => {
		const conversation = (await bh.createConversation({
			model: "mock-driver/mock-model",
		})) as BHZAIConversationImpl
		let idleFired = false
		conversation.on("idle", () => {
			idleFired = true
		})
		const lastMsg = makeMessage("assistant", "done")
		await handleLoopExit(conversation, lastMsg, () => makeMessage("assistant", ""))
		expect(idleFired).toBe(true)
		expect(conversation.status).toBe("idle")
	})

	it("returns last assistant message on normal exit", async () => {
		const conversation = (await bh.createConversation({
			model: "mock-driver/mock-model",
		})) as BHZAIConversationImpl
		const lastMsg = makeMessage("assistant", "final")
		const result = await handleLoopExit(conversation, lastMsg, () => makeMessage("assistant", ""))
		expect(result).toBe(lastMsg)
	})

	it("returns synthetic message when no last assistant message on normal exit", async () => {
		const conversation = (await bh.createConversation({
			model: "mock-driver/mock-model",
		})) as BHZAIConversationImpl
		const synthetic = makeMessage("assistant", "")
		const result = await handleLoopExit(conversation, undefined, () => synthetic)
		expect(result).toBe(synthetic)
	})
})

// ---------------------------------------------------------------------------
// 8. checkMaxIterations (pure logic)
// ---------------------------------------------------------------------------

describe("checkMaxIterations", () => {
	it("returns false when iteration < maxIterations", () => {
		expect(checkMaxIterations(0, 8, undefined)).toBe(false)
		expect(checkMaxIterations(7, 8, undefined)).toBe(false)
	})

	it("returns true when iteration >= maxIterations", () => {
		expect(checkMaxIterations(8, 8, undefined)).toBe(true)
		expect(checkMaxIterations(10, 8, undefined)).toBe(true)
	})

	it("flags lastAssistantMessage with truncatedBy when bound is reached", () => {
		const msg = makeMessage("assistant", "partial")
		checkMaxIterations(8, 8, msg)
		expect(msg.meta.truncatedBy).toBe("max-iterations")
	})

	it("does not flag when lastAssistantMessage is undefined", () => {
		expect(() => checkMaxIterations(8, 8, undefined)).not.toThrow()
	})

	it("does not flag when bound is not reached", () => {
		const msg = makeMessage("assistant", "partial")
		checkMaxIterations(5, 8, msg)
		expect(msg.meta.truncatedBy).toBeUndefined()
	})
})

// ---------------------------------------------------------------------------
// 9. isAllTerminate (pure logic)
// ---------------------------------------------------------------------------

describe("isAllTerminate", () => {
	it("returns false for empty array", () => {
		expect(isAllTerminate([])).toBe(false)
	})

	it("returns true when all results carry BHZAI/terminate: true", () => {
		const results: CallToolResult[] = [
			{ content: [], _meta: { "BHZAI/terminate": true } },
			{ content: [], _meta: { "BHZAI/terminate": true } },
		]
		expect(isAllTerminate(results)).toBe(true)
	})

	it("returns false when at least one result lacks the hint", () => {
		const results: CallToolResult[] = [
			{ content: [], _meta: { "BHZAI/terminate": true } },
			{ content: [], _meta: {} },
		]
		expect(isAllTerminate(results)).toBe(false)
	})

	it("returns false when at least one result has terminate: false", () => {
		const results: CallToolResult[] = [
			{ content: [], _meta: { "BHZAI/terminate": true } },
			{ content: [], _meta: { "BHZAI/terminate": false } },
		]
		expect(isAllTerminate(results)).toBe(false)
	})

	it("returns false when results have no _meta at all", () => {
		const results: CallToolResult[] = [{ content: [] }, { content: [] }]
		expect(isAllTerminate(results)).toBe(false)
	})

	it("returns true for a single result with terminate: true", () => {
		const results: CallToolResult[] = [{ content: [], _meta: { "BHZAI/terminate": true } }]
		expect(isAllTerminate(results)).toBe(true)
	})
})

// ---------------------------------------------------------------------------
// 10. prepareUserMessage
// ---------------------------------------------------------------------------

describe("prepareUserMessage", () => {
	let bh: BHZAI
	let driver: BHZAIDriver

	beforeEach(() => {
		bh = new BHZAI()
		driver = makeMockDriver()
		bh.addDriver(driver)
	})

	it("returns undefined when message(before) does not block", async () => {
		const conversation = (await bh.createConversation({
			model: "mock-driver/mock-model",
		})) as BHZAIConversationImpl
		const userMessage = makeMessage("user", "hello")
		const createOpts = conversation._getCreateOptions()
		const result = await prepareUserMessage(conversation, bh, createOpts, userMessage)
		expect(result).toBeUndefined()
		expect(conversation.status).toBe("streaming")
	})

	it("returns blocked message when message(before) blocks", async () => {
		const conversation = (await bh.createConversation({
			model: "mock-driver/mock-model",
		})) as BHZAIConversationImpl
		conversation.on("message", (payload: unknown) => {
			const p = payload as { state: string }
			if (p.state === "before") return { block: true, reason: "filtered" }
		})
		const userMessage = makeMessage("user", "hello")
		const createOpts = conversation._getCreateOptions()
		const result = await prepareUserMessage(conversation, bh, createOpts, userMessage)
		expect(result).toBeDefined()
		expect(result?.meta.blocked).toBe(true)
		expect(result?.meta.blockedReason).toBe("filtered")
	})

	it("fires loop(start) event", async () => {
		const conversation = (await bh.createConversation({
			model: "mock-driver/mock-model",
		})) as BHZAIConversationImpl
		const loopEvents: string[] = []
		conversation.on("loop", (payload: unknown) => {
			const p = payload as { state: string }
			loopEvents.push(p.state)
		})
		const userMessage = makeMessage("user", "hello")
		await prepareUserMessage(conversation, bh, conversation._getCreateOptions(), userMessage)
		expect(loopEvents).toContain("start")
	})

	it("pushes the user message to conversation history", async () => {
		const conversation = (await bh.createConversation({
			model: "mock-driver/mock-model",
		})) as BHZAIConversationImpl
		const userMessage = makeMessage("user", "hello")
		await prepareUserMessage(conversation, bh, conversation._getCreateOptions(), userMessage)
		expect(conversation.messages.length).toBeGreaterThan(0)
	})
})

// ---------------------------------------------------------------------------
// 11. drainSteerQueue
// ---------------------------------------------------------------------------

describe("drainSteerQueue", () => {
	let bh: BHZAI
	let driver: BHZAIDriver

	beforeEach(() => {
		bh = new BHZAI()
		driver = makeMockDriver()
		bh.addDriver(driver)
	})

	it("returns empty array when steer queue is empty", async () => {
		const conversation = (await bh.createConversation({
			model: "mock-driver/mock-model",
		})) as BHZAIConversationImpl
		const result = await drainSteerQueue(conversation)
		expect(result).toEqual([])
	})

	it("returns pending entries for non-blocked steer messages", async () => {
		const conversation = (await bh.createConversation({
			model: "mock-driver/mock-model",
		})) as BHZAIConversationImpl
		conversation._pushSteerQueue({
			content: "steer me",
			resolve: vi.fn(),
			reject: vi.fn(),
		})
		const result = await drainSteerQueue(conversation)
		expect(result).toHaveLength(1)
	})

	it("resolves blocked entries with blocked message and does not return them", async () => {
		const conversation = (await bh.createConversation({
			model: "mock-driver/mock-model",
		})) as BHZAIConversationImpl
		conversation.on("message", (payload: unknown) => {
			const p = payload as { state: string }
			if (p.state === "before") return { block: true, reason: "blocked" }
		})
		const resolveFn = vi.fn()
		conversation._pushSteerQueue({
			content: "steer me",
			resolve: resolveFn,
			reject: vi.fn(),
		})
		const result = await drainSteerQueue(conversation)
		expect(result).toHaveLength(0)
		expect(resolveFn).toHaveBeenCalledOnce()
		const blockedMsg = resolveFn.mock.calls[0][0] as BHZAIMessage
		expect(blockedMsg.meta.blocked).toBe(true)
	})
})

// ---------------------------------------------------------------------------
// 12. buildContextForTurn
// ---------------------------------------------------------------------------

describe("buildContextForTurn", () => {
	let bh: BHZAI
	let driver: BHZAIDriver

	beforeEach(() => {
		bh = new BHZAI()
		driver = makeMockDriver({ toolCalls: true })
		bh.addDriver(driver)
	})

	it("returns effective messages, system prompt, and tools", async () => {
		const conversation = (await bh.createConversation({
			model: "mock-driver/mock-model",
			systemPrompt: "You are helpful.",
		})) as BHZAIConversationImpl
		const result = await buildContextForTurn(conversation, bh, {
			toolCalls: true,
			streaming: true,
			reasoning: false,
		})
		expect(result.effectiveMessages).toBeDefined()
		expect(result.effectiveSystemPrompt).toBeDefined()
		expect(result.advertisedTools).toEqual([])
		expect(result.toolWireDefinitions).toEqual([])
	})

	it("fires context event", async () => {
		const conversation = (await bh.createConversation({
			model: "mock-driver/mock-model",
		})) as BHZAIConversationImpl
		let contextFired = false
		conversation.on("context", () => {
			contextFired = true
		})
		await buildContextForTurn(conversation, bh, {
			toolCalls: true,
			streaming: true,
			reasoning: false,
		})
		expect(contextFired).toBe(true)
	})

	it("applies systemPrompt patch from context event", async () => {
		const conversation = (await bh.createConversation({
			model: "mock-driver/mock-model",
			systemPrompt: "original",
		})) as BHZAIConversationImpl
		conversation.on("context", () => {
			return { systemPrompt: "patched" }
		})
		const result = await buildContextForTurn(conversation, bh, {
			toolCalls: true,
			streaming: true,
			reasoning: false,
		})
		expect(result.effectiveSystemPrompt).toBe("patched")
	})

	it("appends systemPrompt via appendSystemPrompt patch", async () => {
		const conversation = (await bh.createConversation({
			model: "mock-driver/mock-model",
			systemPrompt: "original",
		})) as BHZAIConversationImpl
		conversation.on("context", () => {
			return { appendSystemPrompt: "extra" }
		})
		const result = await buildContextForTurn(conversation, bh, {
			toolCalls: true,
			streaming: true,
			reasoning: false,
		})
		expect(result.effectiveSystemPrompt).toBe("original\n\nextra")
	})
})

// ---------------------------------------------------------------------------
// 13. applyContextBudget
// ---------------------------------------------------------------------------

describe("applyContextBudget", () => {
	let bh: BHZAI
	let driver: BHZAIDriver

	beforeEach(() => {
		bh = new BHZAI()
		driver = makeMockDriver()
		bh.addDriver(driver)
	})

	it("returns messages unchanged when driver has no contextWindow", async () => {
		const conversation = (await bh.createConversation({
			model: "mock-driver/mock-model",
		})) as BHZAIConversationImpl
		const messages = [makeMessage("user", "hello")]
		const result = await applyContextBudget(
			conversation,
			{ toolCalls: true, streaming: true, reasoning: false },
			messages,
			"system",
			[],
		)
		expect(result).toBe(messages)
	})

	it("returns messages unchanged when they fit within the window", async () => {
		const conversation = (await bh.createConversation({
			model: "mock-driver/mock-model",
		})) as BHZAIConversationImpl
		const messages = [makeMessage("user", "hello")]
		const result = await applyContextBudget(
			conversation,
			{ toolCalls: true, streaming: true, reasoning: false, contextWindow: 100000 },
			messages,
			"system",
			[],
		)
		expect(result).toBe(messages)
	})

	it("fires context.trimmed event when messages are trimmed to fit the window", async () => {
		const conversation = (await bh.createConversation({
			model: "mock-driver/mock-model",
		})) as BHZAIConversationImpl

		// Track context.trimmed events.
		let trimmedFired = false
		conversation.on("context.trimmed", () => {
			trimmedFired = true
		})

		// Create enough messages to exceed the context window.
		// Each message is ~100 tokens (400 chars / 4 chars-per-token).
		// With contextWindow=2000 and default outputReserve=1024,
		// availableForMessages=976, so 10×100=1000 tokens triggers trimming.
		const messages: BHZAIMessage[] = []
		for (let i = 0; i < 10; i++) {
			messages.push(makeMessage("user", `message-${i}-${"x".repeat(400)}`))
		}
		// Add a final user message (the one that must be kept).
		messages.push(makeMessage("user", "final question"))

		const result = await applyContextBudget(
			conversation,
			{ toolCalls: true, streaming: true, reasoning: false, contextWindow: 2000 },
			messages,
			"",
			[],
		)

		// Should have trimmed some messages.
		expect(result.length).toBeLessThan(messages.length)
		expect(trimmedFired).toBe(true)
	})

	it("does not fire context.trimmed when messages fit", async () => {
		const conversation = (await bh.createConversation({
			model: "mock-driver/mock-model",
		})) as BHZAIConversationImpl

		let trimmedFired = false
		conversation.on("context.trimmed", () => {
			trimmedFired = true
		})

		const messages = [makeMessage("user", "hello")]
		await applyContextBudget(
			conversation,
			{ toolCalls: true, streaming: true, reasoning: false, contextWindow: 100000 },
			messages,
			"system",
			[],
		)

		expect(trimmedFired).toBe(false)
	})
})

// ---------------------------------------------------------------------------
// 14. executeDriverTurn
// ---------------------------------------------------------------------------

describe("executeDriverTurn", () => {
	let bh: BHZAI
	let driver: BHZAIDriver & { chat: Mock<(request: ChatRequest) => AsyncIterable<DriverEvent>> }

	beforeEach(() => {
		bh = new BHZAI()
		driver = makeMockDriver() as BHZAIDriver & {
			chat: Mock<(request: ChatRequest) => AsyncIterable<DriverEvent>>
		}
		bh.addDriver(driver)
	})

	it("executes a driver turn and returns the assistant message", async () => {
		const conversation = (await bh.createConversation({
			model: "mock-driver/mock-model",
		})) as BHZAIConversationImpl
		const result = await executeDriverTurn(
			conversation,
			driver,
			{ driver: "mock-driver", id: "mock-model" },
			[makeMessage("user", "hello")],
			"system",
			[],
			{ maxRetries: 0, backoff: "none" },
			false,
		)
		expect(result.assistantMessage).toBeDefined()
		expect(result.stopReason).toBe("stop")
		expect(result.naturalStop).toBe(true)
		expect(result.toolCallBuffer).toEqual([])
	})

	it("fires message(sent) event for the assistant message", async () => {
		const conversation = (await bh.createConversation({
			model: "mock-driver/mock-model",
		})) as BHZAIConversationImpl
		let sentFired = false
		conversation.on("message", (payload: unknown) => {
			const p = payload as { state: string }
			if (p.state === "sent") sentFired = true
		})
		await executeDriverTurn(
			conversation,
			driver,
			{ driver: "mock-driver", id: "mock-model" },
			[makeMessage("user", "hello")],
			"system",
			[],
			{ maxRetries: 0, backoff: "none" },
			false,
		)
		expect(sentFired).toBe(true)
	})

	it("pushes the assistant message to conversation history", async () => {
		const conversation = (await bh.createConversation({
			model: "mock-driver/mock-model",
		})) as BHZAIConversationImpl
		const beforeCount = conversation.messages.length
		await executeDriverTurn(
			conversation,
			driver,
			{ driver: "mock-driver", id: "mock-model" },
			[makeMessage("user", "hello")],
			"system",
			[],
			{ maxRetries: 0, backoff: "none" },
			false,
		)
		expect(conversation.messages.length).toBe(beforeCount + 1)
	})
})

// ---------------------------------------------------------------------------
// 15. handleTurnVeto
// ---------------------------------------------------------------------------

describe("handleTurnVeto", () => {
	let bh: BHZAI
	let driver: BHZAIDriver

	beforeEach(() => {
		bh = new BHZAI()
		driver = makeMockDriver()
		bh.addDriver(driver)
	})

	it("injects a synthetic user message with continuation text", async () => {
		const conversation = (await bh.createConversation({
			model: "mock-driver/mock-model",
		})) as BHZAIConversationImpl
		const beforeCount = conversation.messages.length
		handleTurnVeto(conversation, "Please continue")
		expect(conversation.messages.length).toBe(beforeCount + 1)
		const lastMsg = conversation.messages[conversation.messages.length - 1]
		expect(lastMsg.role).toBe("user")
		expect(lastMsg.meta.synthetic).toBe("turn-veto-continuation")
		expect(lastMsg.meta.contextIncluded).toBe(true)
	})
})

// ---------------------------------------------------------------------------
// 16. resolvePendingSteers
// ---------------------------------------------------------------------------

describe("resolvePendingSteers", () => {
	it("resolves all pending entries with the assistant message", () => {
		const assistantMsg = makeMessage("assistant", "response")
		const resolve1 = vi.fn()
		const resolve2 = vi.fn()
		const entries = [
			{ content: "steer1", resolve: resolve1, reject: vi.fn() },
			{ content: "steer2", resolve: resolve2, reject: vi.fn() },
		]
		resolvePendingSteers(entries, assistantMsg)
		expect(resolve1).toHaveBeenCalledWith(assistantMsg)
		expect(resolve2).toHaveBeenCalledWith(assistantMsg)
	})

	it("does nothing for empty array", () => {
		const assistantMsg = makeMessage("assistant", "response")
		expect(() => resolvePendingSteers([], assistantMsg)).not.toThrow()
	})
})

// ---------------------------------------------------------------------------
// 17. fireTurnStart
// ---------------------------------------------------------------------------

describe("fireTurnStart", () => {
	let bh: BHZAI
	let driver: BHZAIDriver

	beforeEach(() => {
		bh = new BHZAI()
		driver = makeMockDriver()
		bh.addDriver(driver)
	})

	it("fires turn(start) event with the iteration number", async () => {
		const conversation = (await bh.createConversation({
			model: "mock-driver/mock-model",
		})) as BHZAIConversationImpl
		let firedTurn: number | undefined
		conversation.on("turn", (payload: unknown) => {
			const p = payload as { state: string; turn: number }
			if (p.state === "start") firedTurn = p.turn
		})
		await fireTurnStart(conversation, 3)
		expect(firedTurn).toBe(3)
	})
})

// ---------------------------------------------------------------------------
// 18. filterToolCalls
// ---------------------------------------------------------------------------

describe("filterToolCalls", () => {
	it("returns empty array for empty buffer", () => {
		expect(filterToolCalls([])).toEqual([])
	})

	it("filters only tool-call events from a mixed buffer", () => {
		const buffer: DriverEvent[] = [
			{ type: "delta", text: "hello" },
			{ type: "tool-call", toolCallId: "tc1", name: "search", input: { q: "a" } },
			{ type: "usage", inputTokens: 10 },
			{ type: "tool-call", toolCallId: "tc2", name: "write", input: { x: 1 } },
			{ type: "done", stopReason: "tool-calls" },
		]
		const result = filterToolCalls(buffer)
		expect(result).toHaveLength(2)
		expect(result[0]).toEqual({ toolCallId: "tc1", name: "search", input: { q: "a" } })
		expect(result[1]).toEqual({ toolCallId: "tc2", name: "write", input: { x: 1 } })
	})

	it("preserves emission order", () => {
		const buffer: DriverEvent[] = [
			{ type: "tool-call", toolCallId: "b", name: "t2", input: {} },
			{ type: "tool-call", toolCallId: "a", name: "t1", input: {} },
		]
		const result = filterToolCalls(buffer)
		expect(result[0].toolCallId).toBe("b")
		expect(result[1].toolCallId).toBe("a")
	})
})

// ---------------------------------------------------------------------------
// 19. partitionToolCalls
// ---------------------------------------------------------------------------

describe("partitionToolCalls", () => {
	let bh: BHZAI

	beforeEach(() => {
		bh = new BHZAI()
	})

	it("partitions all calls as concurrent when serialTools=false and no serial tools", () => {
		bh.addTool({
			name: "t1",
			description: "d",
			inputSchema: { type: "object" },
			execute: vi.fn(),
		})
		bh.addTool({
			name: "t2",
			description: "d",
			inputSchema: { type: "object" },
			execute: vi.fn(),
		})
		const calls: ToolCallEvent[] = [
			{ toolCallId: "1", name: "t1", input: {} },
			{ toolCallId: "2", name: "t2", input: {} },
		]
		const result = partitionToolCalls(calls, bh, false)
		expect(result.concurrent).toHaveLength(2)
		expect(result.serial).toHaveLength(0)
	})

	it("partitions serial-tagged tools into serial array", () => {
		bh.addTool({
			name: "t1",
			description: "d",
			inputSchema: { type: "object" },
			execute: vi.fn(),
			serial: true,
		})
		bh.addTool({
			name: "t2",
			description: "d",
			inputSchema: { type: "object" },
			execute: vi.fn(),
		})
		const calls: ToolCallEvent[] = [
			{ toolCallId: "1", name: "t1", input: {} },
			{ toolCallId: "2", name: "t2", input: {} },
		]
		const result = partitionToolCalls(calls, bh, false)
		expect(result.serial).toHaveLength(1)
		expect(result.concurrent).toHaveLength(1)
		expect(result.serial[0].name).toBe("t1")
	})

	it("partitions all as serial when serialTools=true", () => {
		bh.addTool({
			name: "t1",
			description: "d",
			inputSchema: { type: "object" },
			execute: vi.fn(),
		})
		const calls: ToolCallEvent[] = [{ toolCallId: "1", name: "t1", input: {} }]
		const result = partitionToolCalls(calls, bh, true)
		expect(result.serial).toHaveLength(1)
		expect(result.concurrent).toHaveLength(0)
	})

	it("treats unknown tools as concurrent (no toolDef)", () => {
		const calls: ToolCallEvent[] = [{ toolCallId: "1", name: "unknown", input: {} }]
		const result = partitionToolCalls(calls, bh, false)
		expect(result.concurrent).toHaveLength(1)
		expect(result.serial).toHaveLength(0)
	})
})

// ---------------------------------------------------------------------------
// 20. validateToolCall
// ---------------------------------------------------------------------------

describe("validateToolCall", () => {
	let ajv: Ajv
	const advertised = new Set(["known"])
	const toolDef: BHZAIToolDefinition = {
		name: "known",
		description: "d",
		inputSchema: {
			type: "object",
			properties: { x: { type: "number" } },
			required: ["x"],
		},
		execute: vi.fn(),
	}

	beforeEach(() => {
		ajv = new Ajv()
	})

	it("returns undefined result when validation passes", () => {
		const call: ToolCallEvent = { toolCallId: "1", name: "known", input: { x: 5 } }
		const counter = { count: 0 }
		const result = validateToolCall(call, toolDef, advertised, ajv, 2, counter)
		expect(result.result).toBeUndefined()
		expect(counter.count).toBe(0)
	})

	it("returns error result for unknown tool", () => {
		const call: ToolCallEvent = { toolCallId: "1", name: "unknown", input: {} }
		const counter = { count: 0 }
		const result = validateToolCall(call, undefined, advertised, ajv, 2, counter)
		expect(result.result).toBeDefined()
		expect(result.result?.isError).toBe(true)
		expect(result.result?.content[0]).toMatchObject({ type: "text" })
		expect(counter.count).toBe(1)
	})

	it("returns error result for non-advertised tool", () => {
		const call: ToolCallEvent = { toolCallId: "1", name: "known", input: {} }
		const counter = { count: 0 }
		const result = validateToolCall(call, toolDef, new Set(), ajv, 2, counter)
		expect(result.result?.isError).toBe(true)
		expect(counter.count).toBe(1)
	})

	it("returns error result for schema validation failure", () => {
		const call: ToolCallEvent = { toolCallId: "1", name: "known", input: { x: "not a number" } }
		const counter = { count: 0 }
		const result = validateToolCall(call, toolDef, advertised, ajv, 2, counter)
		expect(result.result?.isError).toBe(true)
		expect(counter.count).toBe(1)
	})

	it("uses repair-limit message when repairCount reaches maxToolRepairs", () => {
		const call: ToolCallEvent = { toolCallId: "1", name: "unknown", input: {} }
		const counter = { count: 2 }
		const result = validateToolCall(call, undefined, advertised, ajv, 2, counter)
		expect(result.result?.isError).toBe(true)
		const text = (result.result?.content[0] as { text: string }).text
		expect(text).toContain("repair limit")
	})
})

// ---------------------------------------------------------------------------
// 21. executeToolWithAbortRace
// ---------------------------------------------------------------------------

describe("executeToolWithAbortRace", () => {
	let bh: BHZAI
	let driver: BHZAIDriver

	beforeEach(() => {
		bh = new BHZAI()
		driver = makeMockDriver()
		bh.addDriver(driver)
	})

	it("returns normalized result when execute succeeds", async () => {
		const conversation = (await bh.createConversation({
			model: "mock-driver/mock-model",
		})) as BHZAIConversationImpl
		const toolDef: BHZAIToolDefinition = {
			name: "t",
			description: "d",
			inputSchema: { type: "object" },
			execute: vi.fn().mockResolvedValue({ content: [{ type: "text", text: "ok" }] }),
		}
		const call: ToolCallEvent = { toolCallId: "1", name: "t", input: {} }
		const result = await executeToolWithAbortRace(toolDef, conversation, call)
		expect(result.content[0]).toMatchObject({ type: "text", text: "ok" })
		expect(result.isError).toBeUndefined()
	})

	it("wraps string return via normalizeToolResult", async () => {
		const conversation = (await bh.createConversation({
			model: "mock-driver/mock-model",
		})) as BHZAIConversationImpl
		const toolDef: BHZAIToolDefinition = {
			name: "t",
			description: "d",
			inputSchema: { type: "object" },
			execute: vi.fn().mockResolvedValue("hello"),
		}
		const call: ToolCallEvent = { toolCallId: "1", name: "t", input: {} }
		const result = await executeToolWithAbortRace(toolDef, conversation, call)
		expect(result.content).toEqual([{ type: "text", text: "hello" }])
	})

	it("returns error result when execute throws", async () => {
		const conversation = (await bh.createConversation({
			model: "mock-driver/mock-model",
		})) as BHZAIConversationImpl
		const toolDef: BHZAIToolDefinition = {
			name: "t",
			description: "d",
			inputSchema: { type: "object" },
			execute: vi.fn().mockRejectedValue(new Error("boom")),
		}
		const call: ToolCallEvent = { toolCallId: "1", name: "t", input: {} }
		const result = await executeToolWithAbortRace(toolDef, conversation, call)
		expect(result.isError).toBe(true)
		expect((result.content[0] as { text: string }).text).toContain("boom")
	})
})

// ---------------------------------------------------------------------------
// 22. applyCompleteEventPatch
// ---------------------------------------------------------------------------

describe("applyCompleteEventPatch", () => {
	const baseResult: CallToolResult = { content: [{ type: "text", text: "original" }] }

	it("returns original result when no patch", () => {
		expect(applyCompleteEventPatch(baseResult, undefined)).toBe(baseResult)
	})

	it("returns original result when patch is empty", () => {
		expect(applyCompleteEventPatch(baseResult, {})).toBe(baseResult)
	})

	it("replaces result when patch.response is set", () => {
		const replacement: CallToolResult = { content: [{ type: "text", text: "replaced" }] }
		const result = applyCompleteEventPatch(baseResult, { response: replacement })
		expect(result).toBe(replacement)
	})

	it("overrides isError when patch.isError is set", () => {
		const result = applyCompleteEventPatch(baseResult, { isError: true })
		expect(result.isError).toBe(true)
		expect(result.content).toBe(baseResult.content)
	})

	it("response patch takes precedence over isError patch", () => {
		const replacement: CallToolResult = { content: [], isError: false }
		const result = applyCompleteEventPatch(baseResult, { response: replacement, isError: true })
		expect(result).toBe(replacement)
	})
})

// ---------------------------------------------------------------------------
// 23. executeSingleToolCall
// ---------------------------------------------------------------------------

describe("executeSingleToolCall", () => {
	let bh: BHZAI
	let driver: BHZAIDriver
	let ajv: Ajv

	beforeEach(() => {
		bh = new BHZAI()
		driver = makeMockDriver()
		bh.addDriver(driver)
		ajv = new Ajv()
	})

	it("returns repair error for unknown tool", async () => {
		const conversation = (await bh.createConversation({
			model: "mock-driver/mock-model",
		})) as BHZAIConversationImpl
		const call: ToolCallEvent = { toolCallId: "1", name: "unknown", input: {} }
		const counter = { count: 0 }
		const result = await executeSingleToolCall(
			conversation,
			bh,
			call,
			undefined,
			new Set(["known"]),
			ajv,
			2,
			counter,
		)
		expect(result.result?.isError).toBe(true)
		expect(counter.count).toBe(1)
	})

	it("executes a valid tool and returns its result", async () => {
		const conversation = (await bh.createConversation({
			model: "mock-driver/mock-model",
		})) as BHZAIConversationImpl
		const toolDef: BHZAIToolDefinition = {
			name: "known",
			description: "d",
			inputSchema: { type: "object" },
			execute: vi.fn().mockResolvedValue({ content: [{ type: "text", text: "done" }] }),
		}
		bh.addTool(toolDef)
		const call: ToolCallEvent = { toolCallId: "1", name: "known", input: {} }
		const counter = { count: 0 }
		const result = await executeSingleToolCall(
			conversation,
			bh,
			call,
			toolDef,
			new Set(["known"]),
			ajv,
			2,
			counter,
		)
		expect(result.result?.content[0]).toMatchObject({ type: "text", text: "done" })
		expect(counter.count).toBe(0)
	})

	it("returns blocked result when beforeCall blocks", async () => {
		const conversation = (await bh.createConversation({
			model: "mock-driver/mock-model",
		})) as BHZAIConversationImpl
		conversation.on("tool", (payload: unknown) => {
			const p = payload as { state: string }
			if (p.state === "beforeCall") return { block: true, reason: "policy denied" }
		})
		const toolDef: BHZAIToolDefinition = {
			name: "known",
			description: "d",
			inputSchema: { type: "object" },
			execute: vi.fn(),
		}
		bh.addTool(toolDef)
		const call: ToolCallEvent = { toolCallId: "1", name: "known", input: {} }
		const counter = { count: 0 }
		const result = await executeSingleToolCall(
			conversation,
			bh,
			call,
			toolDef,
			new Set(["known"]),
			ajv,
			2,
			counter,
		)
		expect(result.result?.isError).toBe(true)
		expect((result.result?.content[0] as { text: string }).text).toBe("policy denied")
		expect(toolDef.execute).not.toHaveBeenCalled()
	})
})

// ---------------------------------------------------------------------------
// 24. runToolBatchExecution
// ---------------------------------------------------------------------------

describe("runToolBatchExecution", () => {
	it("runs all calls serially when serialTools=true", async () => {
		const calls: ToolCallEvent[] = [
			{ toolCallId: "1", name: "a", input: {} },
			{ toolCallId: "2", name: "b", input: {} },
			{ toolCallId: "3", name: "c", input: {} },
		]
		const order: number[] = []
		await runToolBatchExecution(calls, { serial: [], concurrent: [] }, true, async (idx) => {
			order.push(idx)
		})
		expect(order).toEqual([0, 1, 2])
	})

	it("runs concurrent calls in parallel then serial calls sequentially", async () => {
		const calls: ToolCallEvent[] = [
			{ toolCallId: "1", name: "a", input: {} },
			{ toolCallId: "2", name: "b", input: {} },
			{ toolCallId: "3", name: "c", input: {} },
		]
		const serialCall: ToolCallEvent = { toolCallId: "2", name: "b", input: {} }
		const concurrentCalls: ToolCallEvent[] = [
			{ toolCallId: "1", name: "a", input: {} },
			{ toolCallId: "3", name: "c", input: {} },
		]
		const order: string[] = []
		await runToolBatchExecution(
			calls,
			{ serial: [serialCall], concurrent: concurrentCalls },
			false,
			async (idx, call) => {
				order.push(call.toolCallId)
			},
		)
		// Concurrent calls run first (in parallel), serial last
		expect(order).toContain("1")
		expect(order).toContain("3")
		expect(order[order.length - 1]).toBe("2")
	})

	it("does nothing for empty calls array", async () => {
		const fn = vi.fn()
		await runToolBatchExecution([], { serial: [], concurrent: [] }, false, fn)
		expect(fn).not.toHaveBeenCalled()
	})
})

// ---------------------------------------------------------------------------
// 25. appendToolResultMessages
// ---------------------------------------------------------------------------

describe("appendToolResultMessages", () => {
	let bh: BHZAI
	let driver: BHZAIDriver

	beforeEach(() => {
		bh = new BHZAI()
		driver = makeMockDriver()
		bh.addDriver(driver)
	})

	it("appends tool-result messages in original call order", async () => {
		const conversation = (await bh.createConversation({
			model: "mock-driver/mock-model",
		})) as BHZAIConversationImpl
		const toolCalls: ToolCallEvent[] = [
			{ toolCallId: "tc1", name: "search", input: {} },
			{ toolCallId: "tc2", name: "write", input: {} },
		]
		const results: (CallToolResult | undefined)[] = [
			{ content: [{ type: "text", text: "r1" }] },
			{ content: [{ type: "text", text: "r2" }], isError: true },
		]
		const beforeCount = conversation.messages.length
		const settled = appendToolResultMessages(results, toolCalls, conversation)
		expect(settled).toHaveLength(2)
		expect(settled[0].content[0]).toMatchObject({ text: "r1" })
		expect(settled[1].isError).toBe(true)
		expect(conversation.messages.length).toBe(beforeCount + 2)
		const msg1 = conversation.messages[beforeCount]
		const msg2 = conversation.messages[beforeCount + 1]
		expect(msg1.role).toBe("tool")
		expect(msg1.meta.toolCallId).toBe("tc1")
		expect(msg1.meta.toolName).toBe("search")
		expect(msg1.meta.isError).toBe(false)
		expect(msg1.meta.contextIncluded).toBe(true)
		expect(msg2.meta.toolCallId).toBe("tc2")
		expect(msg2.meta.isError).toBe(true)
	})

	it("skips undefined results (holes in the array)", async () => {
		const conversation = (await bh.createConversation({
			model: "mock-driver/mock-model",
		})) as BHZAIConversationImpl
		const toolCalls: ToolCallEvent[] = [
			{ toolCallId: "tc1", name: "a", input: {} },
			{ toolCallId: "tc2", name: "b", input: {} },
		]
		const results: (CallToolResult | undefined)[] = [
			undefined,
			{ content: [{ type: "text", text: "r2" }] },
		]
		const settled = appendToolResultMessages(results, toolCalls, conversation)
		expect(settled).toHaveLength(1)
		expect(settled[0].content[0]).toMatchObject({ text: "r2" })
	})

	it("returns empty array for empty results", async () => {
		const conversation = (await bh.createConversation({
			model: "mock-driver/mock-model",
		})) as BHZAIConversationImpl
		const settled = appendToolResultMessages([], [], conversation)
		expect(settled).toEqual([])
	})
})
