import { describe, expect, it } from "vitest"
import { deriveMessages } from "./projection"
import type { SessionEvent } from "./types"

describe("deriveMessages projection", () => {
	it("projects user message with string content", () => {
		const events: SessionEvent[] = [
			{
				id: "u1",
				sessionId: "sess-1",
				timestamp: 1000,
				type: "user_message",
				content: "Hello world",
			},
		]

		const messages = deriveMessages(events)
		expect(messages).toHaveLength(1)
		expect(messages[0].id).toBe("u1")
		expect(messages[0].role).toBe("user")
		expect(messages[0].content).toBe("Hello world")
		expect(messages[0].blocks).toEqual([{ type: "text", text: "Hello world" }])
		expect(messages[0].time).toBe(1000)
		expect(messages[0].meta.eventId).toBe("u1")
	})

	it("projects user message with ContentBlock array", () => {
		const events: SessionEvent[] = [
			{
				id: "u2",
				sessionId: "sess-1",
				timestamp: 1050,
				type: "user_message",
				content: [
					{ type: "text", text: "Part 1 " },
					{ type: "text", text: "Part 2" },
				],
			},
		]

		const messages = deriveMessages(events)
		expect(messages).toHaveLength(1)
		expect(messages[0].role).toBe("user")
		expect(messages[0].content).toBe("Part 1 Part 2")
		expect(messages[0].blocks).toEqual([
			{ type: "text", text: "Part 1 " },
			{ type: "text", text: "Part 2" },
		])
	})

	it("projects assistant message with reasoning, tool calls, and usage", () => {
		const events: SessionEvent[] = [
			{
				id: "a1",
				sessionId: "sess-1",
				timestamp: 2000,
				type: "assistant_message",
				content: "I will check the weather.",
				reasoning: "Thinking about the city...",
				toolCalls: [
					{
						id: "call-1",
						name: "get_weather",
						arguments: '{"city":"Berlin"}',
					},
				],
				usage: {
					promptTokens: 10,
					completionTokens: 20,
					totalTokens: 30,
				},
			},
			{
				id: "r1",
				sessionId: "sess-1",
				timestamp: 2500,
				type: "tool_result",
				callId: "call-1",
				toolName: "get_weather",
				result: { temp: 22, unit: "celsius" },
				isError: false,
			},
		]

		const messages = deriveMessages(events)
		expect(messages).toHaveLength(2)

		const assistantMsg = messages[0]
		expect(assistantMsg.role).toBe("assistant")
		expect(assistantMsg.content).toBe("I will check the weather.")
		expect(assistantMsg.think).toBe("Thinking about the city...")
		expect(assistantMsg.meta.think).toBe("Thinking about the city...")
		expect(assistantMsg.meta.toolCalls).toEqual([
			{
				id: "call-1",
				name: "get_weather",
				arguments: '{"city":"Berlin"}',
			},
		])
		expect(assistantMsg.meta.usage).toEqual({
			promptTokens: 10,
			completionTokens: 20,
			totalTokens: 30,
		})

		const toolMsg = messages[1]
		expect(toolMsg.role).toBe("tool")
		expect(toolMsg.content).toBe('{"temp":22,"unit":"celsius"}')
		expect(toolMsg.meta.toolCallId).toBe("call-1")
		expect(toolMsg.meta.toolName).toBe("get_weather")
		expect(toolMsg.meta.isError).toBe(false)
	})

	it("projects string tool results directly without JSON double-encoding", () => {
		const events: SessionEvent[] = [
			{
				id: "r2",
				sessionId: "sess-1",
				timestamp: 3000,
				type: "tool_result",
				callId: "call-2",
				toolName: "read_file",
				result: "file content lines",
				isError: false,
			},
		]

		const messages = deriveMessages(events)
		expect(messages).toHaveLength(1)
		expect(messages[0].content).toBe("file content lines")
	})

	it("attaches standalone tool_call events to preceding assistant message", () => {
		const events: SessionEvent[] = [
			{
				id: "a2",
				sessionId: "sess-1",
				timestamp: 4000,
				type: "assistant_message",
				content: "Calling tool now.",
			},
			{
				id: "tc1",
				sessionId: "sess-1",
				timestamp: 4050,
				type: "tool_call",
				callId: "call-3",
				toolName: "calc",
				arguments: { expr: "2+2" },
			},
			{
				id: "r3",
				sessionId: "sess-1",
				timestamp: 4100,
				type: "tool_result",
				callId: "call-3",
				toolName: "calc",
				result: 4,
				isError: false,
			},
		]

		const messages = deriveMessages(events)
		expect(messages).toHaveLength(2)
		expect(messages[0].meta.toolCalls).toEqual([
			{
				id: "call-3",
				name: "calc",
				arguments: '{"expr":"2+2"}',
			},
		])
	})

	it("handles standalone tool_call with string arguments and prevents duplicates", () => {
		const events: SessionEvent[] = [
			{
				id: "a3",
				sessionId: "sess-1",
				timestamp: 4500,
				type: "assistant_message",
				content: "Calling tool.",
				toolCalls: [{ id: "call-existing", name: "test", arguments: "{}" }],
			},
			{
				id: "tc-dup",
				sessionId: "sess-1",
				timestamp: 4550,
				type: "tool_call",
				callId: "call-existing",
				toolName: "test",
				arguments: "{}",
			},
			{
				id: "r-existing",
				sessionId: "sess-1",
				timestamp: 4600,
				type: "tool_result",
				callId: "call-existing",
				toolName: "test",
				result: "ok",
				isError: false,
			},
		]

		const messages = deriveMessages(events)
		expect(messages).toHaveLength(2)
		const calls = messages[0].meta.toolCalls as unknown[]
		expect(calls).toHaveLength(1)
	})

	it("synthesizes aborted error tool results for dangling tool calls", () => {
		const events: SessionEvent[] = [
			{
				id: "u1",
				sessionId: "sess-1",
				timestamp: 5000,
				type: "user_message",
				content: "Execute task",
			},
			{
				id: "a4",
				sessionId: "sess-1",
				timestamp: 5100,
				type: "assistant_message",
				content: "Starting execution...",
				toolCalls: [
					{ id: "call-completed", name: "step1", arguments: "{}" },
					{ id: "call-dangling", name: "step2", arguments: "{}" },
				],
			},
			{
				id: "r4",
				sessionId: "sess-1",
				timestamp: 5200,
				type: "tool_result",
				callId: "call-completed",
				toolName: "step1",
				result: "done",
				isError: false,
			},
		]

		const messages = deriveMessages(events)
		expect(messages).toHaveLength(4)

		expect(messages[0].role).toBe("user")
		expect(messages[1].role).toBe("assistant")
		expect(messages[2].role).toBe("tool")
		expect(messages[2].meta.toolCallId).toBe("call-completed")
		expect(messages[2].meta.isError).toBe(false)

		const repaired = messages[3]
		expect(repaired.role).toBe("tool")
		expect(repaired.meta.toolCallId).toBe("call-dangling")
		expect(repaired.meta.toolName).toBe("step2")
		expect(repaired.meta.isError).toBe(true)
		expect(repaired.meta.repaired).toBe(true)
		expect(repaired.content).toBe("[Aborted: tool execution was interrupted]")
	})

	it("slices history at compaction boundary and synthesizes summary system message", () => {
		const events: SessionEvent[] = [
			{
				id: "u-old-1",
				sessionId: "sess-1",
				timestamp: 1000,
				type: "user_message",
				content: "Old message 1",
			},
			{
				id: "a-old-1",
				sessionId: "sess-1",
				timestamp: 1100,
				type: "assistant_message",
				content: "Old response 1",
			},
			{
				id: "cb-1",
				sessionId: "sess-1",
				timestamp: 2000,
				type: "compaction_boundary",
				summary: "Summary of conversation up to a-old-1.",
				compactedThroughEventId: "a-old-1",
				tokensBefore: 500,
				tokensAfter: 50,
			},
			{
				id: "u-new-1",
				sessionId: "sess-1",
				timestamp: 2100,
				type: "user_message",
				content: "New question",
			},
			{
				id: "a-new-1",
				sessionId: "sess-1",
				timestamp: 2200,
				type: "assistant_message",
				content: "New answer",
			},
		]

		const messages = deriveMessages(events)
		expect(messages).toHaveLength(3)

		expect(messages[0].role).toBe("system")
		expect(messages[0].content).toBe("Summary of conversation up to a-old-1.")
		expect(messages[0].meta.isCompactionSummary).toBe(true)
		expect(messages[0].meta.compactedThroughEventId).toBe("a-old-1")

		expect(messages[1].role).toBe("user")
		expect(messages[1].content).toBe("New question")

		expect(messages[2].role).toBe("assistant")
		expect(messages[2].content).toBe("New answer")
	})

	it("falls back gracefully when compaction boundary event ID is not found", () => {
		const events: SessionEvent[] = [
			{
				id: "u1",
				sessionId: "sess-1",
				timestamp: 1000,
				type: "user_message",
				content: "Hello",
			},
			{
				id: "cb-unknown",
				sessionId: "sess-1",
				timestamp: 2000,
				type: "compaction_boundary",
				summary: "Summary with missing target id.",
				compactedThroughEventId: "does-not-exist",
			},
		]

		const messages = deriveMessages(events)
		expect(messages).toHaveLength(2)
		expect(messages[0].role).toBe("system")
		expect(messages[1].role).toBe("user")
	})

	it("uses latest compaction boundary when multiple boundaries exist", () => {
		const events: SessionEvent[] = [
			{
				id: "u1",
				sessionId: "sess-1",
				timestamp: 1000,
				type: "user_message",
				content: "First",
			},
			{
				id: "cb1",
				sessionId: "sess-1",
				timestamp: 2000,
				type: "compaction_boundary",
				summary: "First summary",
				compactedThroughEventId: "u1",
			},
			{
				id: "u2",
				sessionId: "sess-1",
				timestamp: 3000,
				type: "user_message",
				content: "Second",
			},
			{
				id: "cb2",
				sessionId: "sess-1",
				timestamp: 4000,
				type: "compaction_boundary",
				summary: "Second summary",
				compactedThroughEventId: "u2",
			},
			{
				id: "u3",
				sessionId: "sess-1",
				timestamp: 5000,
				type: "user_message",
				content: "Third",
			},
		]

		const messages = deriveMessages(events)
		expect(messages).toHaveLength(2)
		expect(messages[0].role).toBe("system")
		expect(messages[0].content).toBe("Second summary")
		expect(messages[1].role).toBe("user")
		expect(messages[1].content).toBe("Third")
	})

	it("omits non-visible telemetry and model change events from projection", () => {
		const events: SessionEvent[] = [
			{
				id: "mc1",
				sessionId: "sess-1",
				timestamp: 500,
				type: "model_change",
				modelRef: "openai/gpt-4o",
			},
			{
				id: "cust1",
				sessionId: "sess-1",
				timestamp: 600,
				type: "custom",
				source: "telemetry",
				name: "user_clicked",
				data: { btn: "submit" },
			},
			{
				id: "u1",
				sessionId: "sess-1",
				timestamp: 1000,
				type: "user_message",
				content: "Valid input",
			},
		]

		const messages = deriveMessages(events)
		expect(messages).toHaveLength(1)
		expect(messages[0].content).toBe("Valid input")
	})

	it("supports message helper methods append() and setContent()", () => {
		const events: SessionEvent[] = [
			{
				id: "u1",
				sessionId: "sess-1",
				timestamp: 1000,
				type: "user_message",
				content: "Initial",
			},
		]

		const messages = deriveMessages(events)
		const msg = messages[0]

		msg.append(" appended")
		expect(msg.content).toBe("Initial appended")
		expect(msg.blocks).toHaveLength(2)

		msg.setContent("Reset text")
		expect(msg.content).toBe("Reset text")
		expect(msg.blocks).toEqual([{ type: "text", text: "Reset text" }])

		msg.setContent([
			{ type: "text", text: "Block A " },
			{ type: "text", text: "Block B" },
		])
		expect(msg.content).toBe("Block A Block B")
		expect(msg.blocks).toHaveLength(2)

		msg.content = "Direct update"
		expect(msg.content).toBe("Direct update")

		msg.blocks = [{ type: "text", text: "Direct blocks" }]
		expect(msg.blocks).toEqual([{ type: "text", text: "Direct blocks" }])
	})
})
