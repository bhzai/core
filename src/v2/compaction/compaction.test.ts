import { describe, expect, it } from "vitest"
import { contextTrackingPlugin, tokenizerPlugin } from "../context/plugin"
import { createHarness } from "../kernel/kernel"
import type { LlmService } from "../llm/types"
import { sessionPlugin } from "../sessions/plugin"
import type { SessionEvent } from "../sessions/types"
import {
	compactionPlugin,
	findCompactionCutoff,
	formatEventsForSummary,
	generateSummary,
	resolveVisibleWindow,
} from "./index"

describe("Summarization & Formatting", () => {
	it("formats various session events into dialogue lines", () => {
		const events: SessionEvent[] = [
			{
				id: "1",
				sessionId: "s",
				timestamp: 1,
				type: "user_message",
				content: "Hello",
			},
			{
				id: "2",
				sessionId: "s",
				timestamp: 2,
				type: "assistant_message",
				content: "Hi there",
			},
			{
				id: "3",
				sessionId: "s",
				timestamp: 3,
				type: "tool_call",
				callId: "c1",
				toolName: "calc",
				arguments: { x: 1 },
			},
			{
				id: "4",
				sessionId: "s",
				timestamp: 4,
				type: "tool_result",
				callId: "c1",
				toolName: "calc",
				result: { val: 2 },
				isError: false,
			},
		]

		const text = formatEventsForSummary(events)
		expect(text).toContain("User: Hello")
		expect(text).toContain("Assistant: Hi there")
		expect(text).toContain("Tool Call: calc")
		expect(text).toContain("Tool Result [calc]:")
	})

	it("uses customSummarizer when provided", async () => {
		const summary = await generateSummary({
			events: [],
			customSummarizer: async () => "Customized summary result",
		})
		expect(summary).toBe("Customized summary result")
	})

	it("calls llm.complete when llm is provided and returns trimmed text", async () => {
		const mockLlm = {
			complete: async () => ({ text: "  LLM generated summary  " }),
		}
		const summary = await generateSummary({
			events: [
				{
					id: "1",
					sessionId: "s",
					timestamp: 1,
					type: "user_message",
					content: "Hello",
				},
			],
			priorSummary: "Old summary",
			llm: mockLlm as unknown as LlmService,
		})
		expect(summary).toBe("LLM generated summary")
	})

	it("falls back to structured summary when no llm or when llm throws", async () => {
		const mockLlm = {
			complete: async () => {
				throw new Error("LLM failure")
			},
		}
		const summary = await generateSummary({
			events: [
				{
					id: "1",
					sessionId: "s",
					timestamp: 1,
					type: "user_message",
					content: "Hi",
				},
			],
			priorSummary: "Old summary",
			llm: mockLlm as unknown as LlmService,
		})
		expect(summary).toContain("Old summary")
		expect(summary).toContain("[Archived 1 conversation events]")
	})
})

describe("Cutoff & Window Resolution", () => {
	it("resolves visible window correctly with and without prior boundary", () => {
		const eventsWithoutBoundary: SessionEvent[] = [
			{ id: "1", sessionId: "s", timestamp: 1, type: "user_message", content: "1" },
			{ id: "2", sessionId: "s", timestamp: 2, type: "assistant_message", content: "2" },
		]
		const win1 = resolveVisibleWindow(eventsWithoutBoundary)
		expect(win1.visibleEvents.length).toBe(2)
		expect(win1.boundary).toBeUndefined()

		const eventsWithBoundary: SessionEvent[] = [
			{ id: "1", sessionId: "s", timestamp: 1, type: "user_message", content: "1" },
			{
				id: "b1",
				sessionId: "s",
				timestamp: 2,
				type: "compaction_boundary",
				summary: "Summ",
				compactedThroughEventId: "1",
			},
			{ id: "2", sessionId: "s", timestamp: 3, type: "user_message", content: "2" },
		]
		const win2 = resolveVisibleWindow(eventsWithBoundary)
		expect(win2.visibleEvents.length).toBe(1)
		expect(win2.visibleEvents[0].id).toBe("2")
		expect(win2.boundary?.id).toBe("b1")
	})

	it("preserves tool call and tool result pairs atomically across cutoffs", () => {
		const events: SessionEvent[] = [
			{ id: "1", sessionId: "s", timestamp: 1, type: "user_message", content: "calc" },
			{ id: "2", sessionId: "s", timestamp: 2, type: "assistant_message", content: "running" },
			{
				id: "3",
				sessionId: "s",
				timestamp: 3,
				type: "tool_call",
				callId: "c1",
				toolName: "calc",
				arguments: {},
			},
			{
				id: "4",
				sessionId: "s",
				timestamp: 4,
				type: "tool_result",
				callId: "c1",
				toolName: "calc",
				result: "42",
				isError: false,
			},
			{ id: "5", sessionId: "s", timestamp: 5, type: "assistant_message", content: "done" },
		]

		// If keepCount is 2 (candidate cutoff would land on index 2: tool_call)
		// findCompactionCutoff moves candidate back to 1 (assistant_message)
		const cutoff = findCompactionCutoff(events, 2)
		expect(cutoff).toBe(1)
		expect(events[cutoff].id).toBe("2")
	})

	it("returns -1 when visible events are fewer than or equal to keepCount", () => {
		const events: SessionEvent[] = [
			{ id: "1", sessionId: "s", timestamp: 1, type: "user_message", content: "hi" },
		]
		expect(findCompactionCutoff(events, 4)).toBe(-1)
	})
})

describe("Compaction Pipeline & Service", () => {
	it("executes compaction pass, appends boundary event, and emits lifecycle events", async () => {
		const harness = await createHarness({
			plugins: [sessionPlugin, tokenizerPlugin, contextTrackingPlugin, compactionPlugin],
		})

		const sessions = harness.ctx.sessions
		const compaction = harness.ctx.compaction
		if (!sessions || !compaction) {
			throw new Error("Missing required services.")
		}

		let startFired = false
		let completeFired = false
		harness.ctx.events.on("compaction/start", () => {
			startFired = true
		})
		harness.ctx.events.on("compaction/complete", () => {
			completeFired = true
		})

		const session = await sessions.create({ id: "comp-sess" })

		// Append 6 events
		for (let i = 1; i <= 6; i++) {
			await session.append([
				{
					id: `evt-${i}`,
					sessionId: session.id,
					timestamp: i * 1000,
					type: i % 2 === 1 ? "user_message" : "assistant_message",
					content: `Message ${i}`,
				},
			])
		}

		// Keep 2 events, so evt-1 through evt-4 should be compacted
		const res = await compaction.compact(session.id, {
			keepRecentEvents: 2,
			summarizer: async () => "Consolidated summary of 4 messages.",
		})

		expect(res.compacted).toBe(true)
		expect(res.summary).toBe("Consolidated summary of 4 messages.")
		expect(res.boundaryEvent?.compactedThroughEventId).toBe("evt-4")
		expect(res.compactedEventsCount).toBe(4)
		expect(startFired).toBe(true)
		expect(completeFired).toBe(true)

		// Check projected messages from reloaded session
		const openedSession = await sessions.open(session.id)
		const projected = openedSession.deriveMessages()
		// First message is synthetic summary system message
		expect(projected[0].role).toBe("system")
		expect(projected[0].content).toContain("Consolidated summary of 4 messages.")
		// Remaining visible messages should be evt-5 and evt-6
		expect(projected.length).toBe(3)

		await harness.dispose()
	})

	it("returns compacted: false if visible events do not exceed keepCount", async () => {
		const harness = await createHarness({
			plugins: [sessionPlugin, compactionPlugin],
		})

		const sessions = harness.ctx.sessions
		const compaction = harness.ctx.compaction
		if (!sessions || !compaction) throw new Error("Missing services")

		const session = await sessions.create({ id: "short-sess" })
		await session.append([
			{
				id: "u1",
				sessionId: session.id,
				timestamp: 100,
				type: "user_message",
				content: "Hello",
			},
		])

		const res = await compaction.compact(session.id, { keepRecentEvents: 4 })
		expect(res.compacted).toBe(false)

		await harness.dispose()
	})

	it("triggers proactive compaction during pre-step waterfall when threshold is exceeded", async () => {
		const harness = await createHarness({
			plugins: [sessionPlugin, tokenizerPlugin, contextTrackingPlugin, compactionPlugin],
			config: {
				compaction: {
					contextWindow: 50,
					threshold: 0.5,
				},
			},
		})

		const sessions = harness.ctx.sessions
		const tracking = harness.ctx.contextTracking
		if (!sessions || !tracking) throw new Error("Missing services")

		const session = await sessions.create({ id: "proactive-sess" })

		for (let i = 1; i <= 6; i++) {
			await session.append([
				{
					id: `m-${i}`,
					sessionId: session.id,
					timestamp: i * 100,
					type: i % 2 === 1 ? "user_message" : "assistant_message",
					content: "x".repeat(100),
				},
			])
		}

		// Initial messages count is 6
		const initialMessages = session.deriveMessages()
		expect(initialMessages.length).toBe(6)

		const prePayload = {
			stepIndex: 0,
			messages: [...initialMessages],
		}

		// Trigger pre-step waterfall
		const effective = await harness.ctx.events.runWaterfall("pre-step", prePayload, {
			sessionId: session.id,
			turnId: "t1",
			stepIndex: 0,
		})

		// After pre-step waterfall, compaction should have run!
		// effective.messages should now have the boundary system message + kept recent messages
		expect(effective.messages.length).toBeLessThan(initialMessages.length)
		expect(effective.messages[0].role).toBe("system")
		expect(effective.messages[0].content).toBeDefined()

		await harness.dispose()
	})
})
