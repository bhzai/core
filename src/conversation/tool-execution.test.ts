/** @file Tests for TASK_0026: Tool execution in the agent loop */

import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Mock } from "vitest"
import { BHZAI } from "../core/bhzai.js"
import type { CallToolResult, ContentBlock } from "../types/content.js"
import type { BHZAIDriver, ChatRequest, DriverEvent } from "../types/driver.js"
import { sendMessage } from "./agent-loop.js"
import type { BHZAIConversationImpl } from "./conversation.js"

/**
 * Helper: sleep for a given number of milliseconds.
 */
function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Mock driver that yields a scripted sequence of DriverEvents.
 */
function makeMockDriver(
	scriptedEvents: DriverEvent[],
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
					toolCalls: true,
					streaming: true,
					reasoning: false,
				},
			},
		],
		capabilities: () => ({
			toolCalls: true,
			streaming: true,
			reasoning: false,
		}),
		chat: vi.fn(async function* (_request: ChatRequest) {
			for (const event of scriptedEvents) {
				yield event
			}
		}),
		embed: undefined,
	}
}

describe("TASK_0026: Tool execution in the agent loop", () => {
	let bh: BHZAI
	let mockDriver: BHZAIDriver & { chat: Mock<(request: ChatRequest) => AsyncIterable<DriverEvent>> }

	beforeEach(() => {
		bh = new BHZAI()
		mockDriver = makeMockDriver([
			{ type: "delta", text: "Processing tools..." },
			{ type: "done", stopReason: "stop" },
		])
		bh.addDriver(mockDriver)
	})

	// =========================================================================
	// TEST 1: Original-call-order reordering under adversarial resolve order
	// (Most important test — airtight proof of original-order reordering)
	// =========================================================================
	it("original-call-order: 3 concurrent calls resolve out of order (call#2 before call#1), yet appended in original order", async () => {
		const conversation = (await bh.createConversation({
			model: "mock-driver/mock-model",
		})) as BHZAIConversationImpl

		const executionOrder: string[] = []
		const callDurations = { call1: 50, call2: 10, call3: 30 }

		// Register 3 mock tools with controlled delays.
		bh.addTool({
			name: "tool1",
			description: "First tool",
			inputSchema: { type: "object" },
			execute: async () => {
				executionOrder.push("call1-start")
				await delay(callDurations.call1)
				executionOrder.push("call1-end")
				return "result1"
			},
		})
		bh.addTool({
			name: "tool2",
			description: "Second tool",
			inputSchema: { type: "object" },
			execute: async () => {
				executionOrder.push("call2-start")
				await delay(callDurations.call2)
				executionOrder.push("call2-end")
				return "result2"
			},
		})
		bh.addTool({
			name: "tool3",
			description: "Third tool",
			inputSchema: { type: "object" },
			execute: async () => {
				executionOrder.push("call3-start")
				await delay(callDurations.call3)
				executionOrder.push("call3-end")
				return "result3"
			},
		})

		// Mock driver that handles stateful iteration
		// First call: emit tool calls; second call: emit stop
		let callCount = 0
		mockDriver = {
			id: "mock-driver",
			listModels: async () => [
				{
					ref: "mock-driver/mock-model",
					id: "mock-model",
					driver: "mock-driver",
					availability: "ready" as const,
					capabilities: {
						toolCalls: true,
						streaming: true,
						reasoning: false,
					},
				},
			],
			capabilities: () => ({
				toolCalls: true,
				streaming: true,
				reasoning: false,
			}),
			chat: vi.fn(async function* (_request: ChatRequest) {
				callCount++
				if (callCount === 1) {
					// First turn: emit tool calls
					yield { type: "tool-call", toolCallId: "tc1", name: "tool1", input: {} }
					yield { type: "tool-call", toolCallId: "tc2", name: "tool2", input: {} }
					yield { type: "tool-call", toolCallId: "tc3", name: "tool3", input: {} }
					yield { type: "done", stopReason: "tool-calls" }
				} else {
					// Second turn: emit stop
					yield { type: "delta", text: "Done" }
					yield { type: "done", stopReason: "stop" }
				}
			}),
			embed: undefined,
		} as BHZAIDriver & { chat: Mock<(request: ChatRequest) => AsyncIterable<DriverEvent>> }
		bh.addDriver(mockDriver)

		await sendMessage(conversation, "Call all three tools")

		// Verify execution was concurrent (call2-end before call1-end).
		const call1EndIdx = executionOrder.indexOf("call1-end")
		const call2EndIdx = executionOrder.indexOf("call2-end")
		expect(call2EndIdx).toBeLessThan(call1EndIdx) // call2 finishes before call1

		// Verify the tool-result messages are in ORIGINAL order (1, 2, 3), not completion order.
		const toolMessages = conversation.messages.filter((m) => m.role === "tool")
		expect(toolMessages.length).toBe(3)
		expect(toolMessages[0].meta.toolName).toBe("tool1")
		expect(toolMessages[1].meta.toolName).toBe("tool2")
		expect(toolMessages[2].meta.toolName).toBe("tool3")
	})

	// =========================================================================
	// TEST 2: Serial-tool waits for concurrent portion to complete
	// =========================================================================
	it("serial-tool waits for all concurrent tools to settle before executing", async () => {
		const conversation = (await bh.createConversation({
			model: "mock-driver/mock-model",
		})) as BHZAIConversationImpl

		const executionOrder: string[] = []

		// Register tools: tool1 and tool2 are concurrent, tool3 is serial.
		bh.addTool({
			name: "tool1",
			description: "Concurrent tool 1",
			inputSchema: { type: "object" },
			execute: async () => {
				executionOrder.push("tool1-start")
				await delay(20)
				executionOrder.push("tool1-end")
				return "result1"
			},
		})
		bh.addTool({
			name: "tool2",
			description: "Concurrent tool 2",
			inputSchema: { type: "object" },
			execute: async () => {
				executionOrder.push("tool2-start")
				await delay(10)
				executionOrder.push("tool2-end")
				return "result2"
			},
		})
		bh.addTool({
			name: "serial_tool",
			description: "Serial tool",
			inputSchema: { type: "object" },
			serial: true, // Mark as serial
			execute: async () => {
				executionOrder.push("serial-start")
				await delay(5)
				executionOrder.push("serial-end")
				return "serial-result"
			},
		})

		// Stateful mock driver
		let callCount = 0
		mockDriver = {
			id: "mock-driver",
			listModels: async () => [
				{
					ref: "mock-driver/mock-model",
					id: "mock-model",
					driver: "mock-driver",
					availability: "ready" as const,
					capabilities: {
						toolCalls: true,
						streaming: true,
						reasoning: false,
					},
				},
			],
			capabilities: () => ({
				toolCalls: true,
				streaming: true,
				reasoning: false,
			}),
			chat: vi.fn(async function* (_request: ChatRequest) {
				callCount++
				if (callCount === 1) {
					// First turn: emit tool calls
					yield { type: "tool-call", toolCallId: "tc1", name: "tool1", input: {} }
					yield { type: "tool-call", toolCallId: "tc2", name: "tool2", input: {} }
					yield { type: "tool-call", toolCallId: "tc3", name: "serial_tool", input: {} }
					yield { type: "done", stopReason: "tool-calls" }
				} else {
					// Second turn: emit stop
					yield { type: "delta", text: "Done" }
					yield { type: "done", stopReason: "stop" }
				}
			}),
			embed: undefined,
		} as BHZAIDriver & { chat: Mock<(request: ChatRequest) => AsyncIterable<DriverEvent>> }
		bh.addDriver(mockDriver)

		await sendMessage(conversation, "Call tools")

		// Verify serial tool starts AFTER both concurrent tools have ended.
		const tool1EndIdx = executionOrder.indexOf("tool1-end")
		const tool2EndIdx = executionOrder.indexOf("tool2-end")
		const serialStartIdx = executionOrder.indexOf("serial-start")
		expect(serialStartIdx).toBeGreaterThan(tool1EndIdx)
		expect(serialStartIdx).toBeGreaterThan(tool2EndIdx)
	})

	// =========================================================================
	// TEST 3: conversation.serialTools: true forces all calls to run one-at-a-time
	// =========================================================================
	it("conversation.serialTools: true forces strict one-at-a-time execution", async () => {
		const conversation = (await bh.createConversation({
			model: "mock-driver/mock-model",
			serialTools: true, // Force serialization
		})) as BHZAIConversationImpl

		let inFlightCount = 0
		let maxInFlight = 0

		// Register 3 regular (non-serial) tools.
		for (let i = 1; i <= 3; i++) {
			bh.addTool({
				name: `tool${i}`,
				description: `Tool ${i}`,
				inputSchema: { type: "object" },
				execute: async () => {
					inFlightCount++
					maxInFlight = Math.max(maxInFlight, inFlightCount)
					await delay(10)
					inFlightCount--
					return `result${i}`
				},
			})
		}

		// Stateful mock driver
		let callCount = 0
		mockDriver = {
			id: "mock-driver",
			listModels: async () => [
				{
					ref: "mock-driver/mock-model",
					id: "mock-model",
					driver: "mock-driver",
					availability: "ready" as const,
					capabilities: {
						toolCalls: true,
						streaming: true,
						reasoning: false,
					},
				},
			],
			capabilities: () => ({
				toolCalls: true,
				streaming: true,
				reasoning: false,
			}),
			chat: vi.fn(async function* (_request: ChatRequest) {
				callCount++
				if (callCount === 1) {
					yield { type: "tool-call", toolCallId: "tc1", name: "tool1", input: {} }
					yield { type: "tool-call", toolCallId: "tc2", name: "tool2", input: {} }
					yield { type: "tool-call", toolCallId: "tc3", name: "tool3", input: {} }
					yield { type: "done", stopReason: "tool-calls" }
				} else {
					yield { type: "delta", text: "Done" }
					yield { type: "done", stopReason: "stop" }
				}
			}),
			embed: undefined,
		} as BHZAIDriver & { chat: Mock<(request: ChatRequest) => AsyncIterable<DriverEvent>> }
		bh.addDriver(mockDriver)

		await sendMessage(conversation, "Call tools")

		// Verify the concurrency counter never exceeded 1 (strict serialization).
		expect(maxInFlight).toBe(1)
	})

	// =========================================================================
	// TEST 4: Unregistered tool name produces isError result, no crash
	// =========================================================================
	it("unregistered tool name produces isError result and conversation continues", async () => {
		const conversation = (await bh.createConversation({
			model: "mock-driver/mock-model",
		})) as BHZAIConversationImpl

		// Register one valid tool.
		bh.addTool({
			name: "valid_tool",
			description: "A valid tool",
			inputSchema: { type: "object" },
			execute: async () => "ok",
		})

		// Stateful mock driver
		let callCount = 0
		mockDriver = {
			id: "mock-driver",
			listModels: async () => [
				{
					ref: "mock-driver/mock-model",
					id: "mock-model",
					driver: "mock-driver",
					availability: "ready" as const,
					capabilities: {
						toolCalls: true,
						streaming: true,
						reasoning: false,
					},
				},
			],
			capabilities: () => ({
				toolCalls: true,
				streaming: true,
				reasoning: false,
			}),
			chat: vi.fn(async function* (_request: ChatRequest) {
				callCount++
				if (callCount === 1) {
					// Call a tool that doesn't exist.
					yield { type: "tool-call", toolCallId: "tc1", name: "nonexistent_tool", input: {} }
					// Also call a valid tool.
					yield { type: "tool-call", toolCallId: "tc2", name: "valid_tool", input: {} }
					yield { type: "done", stopReason: "tool-calls" }
				} else {
					yield { type: "delta", text: "Done" }
					yield { type: "done", stopReason: "stop" }
				}
			}),
			embed: undefined,
		} as BHZAIDriver & { chat: Mock<(request: ChatRequest) => AsyncIterable<DriverEvent>> }
		bh.addDriver(mockDriver)

		// Should not throw — sendMessage should complete.
		const result = await sendMessage(conversation, "Call unknown tool")
		expect(result).toBeDefined()

		// Verify tool-result messages were appended for both calls.
		const toolMessages = conversation.messages.filter((m) => m.role === "tool")
		expect(toolMessages.length).toBe(2)

		// Verify the first (failed) call is marked as isError.
		expect(toolMessages[0].meta.isError).toBe(true)
		expect(toolMessages[0].content).toContain("Unknown tool")

		// Verify the second (successful) call is not an error.
		expect(toolMessages[1].meta.isError).toBe(false)
	})

	// =========================================================================
	// TEST 5: maxToolRepairs boundary test (2 repairs "self-correcting", 3rd "terminal")
	// =========================================================================
	it("maxToolRepairs boundary: 2 repairs have self-correcting phrasing, 3rd has terminal phrasing", async () => {
		const conversation = (await bh.createConversation({
			model: "mock-driver/mock-model",
			maxToolRepairs: 2,
		})) as BHZAIConversationImpl

		// Stateful mock driver
		let callCount = 0
		mockDriver = {
			id: "mock-driver",
			listModels: async () => [
				{
					ref: "mock-driver/mock-model",
					id: "mock-model",
					driver: "mock-driver",
					availability: "ready" as const,
					capabilities: {
						toolCalls: true,
						streaming: true,
						reasoning: false,
					},
				},
			],
			capabilities: () => ({
				toolCalls: true,
				streaming: true,
				reasoning: false,
			}),
			chat: vi.fn(async function* (_request: ChatRequest) {
				callCount++
				if (callCount === 1) {
					// Three bad tool calls in the same turn.
					yield { type: "tool-call", toolCallId: "tc1", name: "bad_tool_1", input: {} }
					yield { type: "tool-call", toolCallId: "tc2", name: "bad_tool_2", input: {} }
					yield { type: "tool-call", toolCallId: "tc3", name: "bad_tool_3", input: {} }
					yield { type: "done", stopReason: "tool-calls" }
				} else {
					yield { type: "delta", text: "Done" }
					yield { type: "done", stopReason: "stop" }
				}
			}),
			embed: undefined,
		} as BHZAIDriver & { chat: Mock<(request: ChatRequest) => AsyncIterable<DriverEvent>> }
		bh.addDriver(mockDriver)

		await sendMessage(conversation, "Call bad tools")

		// Verify 3 tool-result messages (one for each bad call).
		const toolMessages = conversation.messages.filter((m) => m.role === "tool")
		expect(toolMessages.length).toBe(3)

		// Verify all are marked as errors.
		for (const msg of toolMessages) {
			expect(msg.meta.isError).toBe(true)
		}

		// Verify phrasing: first two should have "retry" language, third should have "repair limit".
		expect(toolMessages[0].content).toContain("retry")
		expect(toolMessages[1].content).toContain("retry")
		expect(toolMessages[2].content).toContain("repair limit")
		expect(toolMessages[2].content).toContain("exceeded")
	})

	// =========================================================================
	// TEST 6: beforeCall block prevents execute from being called
	// =========================================================================
	it("beforeCall handler returning { block: true } prevents execute from running", async () => {
		const conversation = (await bh.createConversation({
			model: "mock-driver/mock-model",
		})) as BHZAIConversationImpl

		const executeSpy = vi.fn(async () => "should-not-run")

		bh.addTool({
			name: "test_tool",
			description: "A tool",
			inputSchema: { type: "object" },
			execute: executeSpy,
		})

		// Register handler that blocks beforeCall.
		conversation.on("tool", (payload: unknown) => {
			const p = payload as { state: string }
			if (p.state === "beforeCall") {
				return { block: true, reason: "blocked" }
			}
		})

		// Stateful mock driver
		let callCount = 0
		mockDriver = {
			id: "mock-driver",
			listModels: async () => [
				{
					ref: "mock-driver/mock-model",
					id: "mock-model",
					driver: "mock-driver",
					availability: "ready" as const,
					capabilities: {
						toolCalls: true,
						streaming: true,
						reasoning: false,
					},
				},
			],
			capabilities: () => ({
				toolCalls: true,
				streaming: true,
				reasoning: false,
			}),
			chat: vi.fn(async function* (_request: ChatRequest) {
				callCount++
				if (callCount === 1) {
					yield { type: "tool-call", toolCallId: "tc1", name: "test_tool", input: {} }
					yield { type: "done", stopReason: "tool-calls" }
				} else {
					yield { type: "delta", text: "Done" }
					yield { type: "done", stopReason: "stop" }
				}
			}),
			embed: undefined,
		} as BHZAIDriver & { chat: Mock<(request: ChatRequest) => AsyncIterable<DriverEvent>> }
		bh.addDriver(mockDriver)

		await sendMessage(conversation, "Call tool")

		// Verify execute was never called.
		expect(executeSpy).not.toHaveBeenCalled()

		// Verify tool-result message reflects the block.
		const toolMessages = conversation.messages.filter((m) => m.role === "tool")
		expect(toolMessages.length).toBe(1)
		expect(toolMessages[0].meta.isError).toBe(true)
		expect(toolMessages[0].content).toContain("blocked")
	})

	// =========================================================================
	// TEST 7: beforeCall NOT blocked allows execute to run
	// =========================================================================
	it("beforeCall handler returning undefined lets execute run normally", async () => {
		const conversation = (await bh.createConversation({
			model: "mock-driver/mock-model",
		})) as BHZAIConversationImpl

		const executeSpy = vi.fn(async () => "executed-ok")

		bh.addTool({
			name: "test_tool",
			description: "A tool",
			inputSchema: { type: "object" },
			execute: executeSpy,
		})

		// Register handler that does NOT block.
		conversation.on("tool", (payload: unknown) => {
			const p = payload as { state: string }
			if (p.state === "beforeCall") {
				// Return undefined (no block).
				return undefined
			}
		})

		// Stateful mock driver
		let callCount = 0
		mockDriver = {
			id: "mock-driver",
			listModels: async () => [
				{
					ref: "mock-driver/mock-model",
					id: "mock-model",
					driver: "mock-driver",
					availability: "ready" as const,
					capabilities: {
						toolCalls: true,
						streaming: true,
						reasoning: false,
					},
				},
			],
			capabilities: () => ({
				toolCalls: true,
				streaming: true,
				reasoning: false,
			}),
			chat: vi.fn(async function* (_request: ChatRequest) {
				callCount++
				if (callCount === 1) {
					yield { type: "tool-call", toolCallId: "tc1", name: "test_tool", input: {} }
					yield { type: "done", stopReason: "tool-calls" }
				} else {
					yield { type: "delta", text: "Done" }
					yield { type: "done", stopReason: "stop" }
				}
			}),
			embed: undefined,
		} as BHZAIDriver & { chat: Mock<(request: ChatRequest) => AsyncIterable<DriverEvent>> }
		bh.addDriver(mockDriver)

		await sendMessage(conversation, "Call tool")

		// Verify execute WAS called.
		expect(executeSpy).toHaveBeenCalled()

		// Verify tool-result message reflects success.
		const toolMessages = conversation.messages.filter((m) => m.role === "tool")
		expect(toolMessages.length).toBe(1)
		expect(toolMessages[0].meta.isError).toBe(false)
		expect(toolMessages[0].content).toContain("executed-ok")
	})

	// =========================================================================
	// TEST 8: complete handler rewrites result
	// =========================================================================
	it("complete handler returning rewritten result affects what is appended to history", async () => {
		const conversation = (await bh.createConversation({
			model: "mock-driver/mock-model",
		})) as BHZAIConversationImpl

		bh.addTool({
			name: "test_tool",
			description: "A tool",
			inputSchema: { type: "object" },
			execute: async () => "original-result",
		})

		// Register handler that rewrites the result.
		conversation.on("tool", (payload: unknown) => {
			const p = payload as { state: string; response?: CallToolResult }
			if (p.state === "complete") {
				// Rewrite the result to something different.
				return {
					response: {
						content: [{ type: "text", text: "rewritten-result" }],
						isError: false,
					},
				}
			}
		})

		// Stateful mock driver
		let callCount = 0
		mockDriver = {
			id: "mock-driver",
			listModels: async () => [
				{
					ref: "mock-driver/mock-model",
					id: "mock-model",
					driver: "mock-driver",
					availability: "ready" as const,
					capabilities: {
						toolCalls: true,
						streaming: true,
						reasoning: false,
					},
				},
			],
			capabilities: () => ({
				toolCalls: true,
				streaming: true,
				reasoning: false,
			}),
			chat: vi.fn(async function* (_request: ChatRequest) {
				callCount++
				if (callCount === 1) {
					yield { type: "tool-call", toolCallId: "tc1", name: "test_tool", input: {} }
					yield { type: "done", stopReason: "tool-calls" }
				} else {
					yield { type: "delta", text: "Done" }
					yield { type: "done", stopReason: "stop" }
				}
			}),
			embed: undefined,
		} as BHZAIDriver & { chat: Mock<(request: ChatRequest) => AsyncIterable<DriverEvent>> }
		bh.addDriver(mockDriver)

		await sendMessage(conversation, "Call tool")

		// Verify the appended message contains the REWRITTEN result, not the original.
		const toolMessages = conversation.messages.filter((m) => m.role === "tool")
		expect(toolMessages.length).toBe(1)
		expect(toolMessages[0].content).toBe("rewritten-result")
		expect(toolMessages[0].content).not.toContain("original-result")
	})

	// =========================================================================
	// TEST 9: Tool input validation against JSON Schema fails gracefully
	// =========================================================================
	it("tool input validation failure produces isError result", async () => {
		const conversation = (await bh.createConversation({
			model: "mock-driver/mock-model",
		})) as BHZAIConversationImpl

		bh.addTool({
			name: "typed_tool",
			description: "A tool with strict schema",
			inputSchema: {
				type: "object",
				properties: {
					count: { type: "number" },
				},
				required: ["count"],
			},
			execute: async () => "ok",
		})

		// Stateful mock driver
		let callCount = 0
		mockDriver = {
			id: "mock-driver",
			listModels: async () => [
				{
					ref: "mock-driver/mock-model",
					id: "mock-model",
					driver: "mock-driver",
					availability: "ready" as const,
					capabilities: {
						toolCalls: true,
						streaming: true,
						reasoning: false,
					},
				},
			],
			capabilities: () => ({
				toolCalls: true,
				streaming: true,
				reasoning: false,
			}),
			chat: vi.fn(async function* (_request: ChatRequest) {
				callCount++
				if (callCount === 1) {
					// Pass invalid input (string instead of number for 'count').
					yield {
						type: "tool-call",
						toolCallId: "tc1",
						name: "typed_tool",
						input: { count: "not-a-number" },
					}
					yield { type: "done", stopReason: "tool-calls" }
				} else {
					yield { type: "delta", text: "Done" }
					yield { type: "done", stopReason: "stop" }
				}
			}),
			embed: undefined,
		} as BHZAIDriver & { chat: Mock<(request: ChatRequest) => AsyncIterable<DriverEvent>> }
		bh.addDriver(mockDriver)

		await sendMessage(conversation, "Call with bad input")

		// Verify tool-result is marked as error.
		const toolMessages = conversation.messages.filter((m) => m.role === "tool")
		expect(toolMessages.length).toBe(1)
		expect(toolMessages[0].meta.isError).toBe(true)
		expect(toolMessages[0].content).toContain("validation")
	})

	// The tool-call buffer is local to one iteration, so without this record the
	// calls a turn made are unrecoverable from history. Drivers whose provider
	// validates conversation structure (OpenAI rejects a `tool` message whose
	// preceding assistant message does not advertise the matching id) rebuild the
	// pairing from it, and it must survive a snapshot round-trip.
	it("records the tool calls a turn produced on the assistant message as meta.toolCalls", async () => {
		const conversation = (await bh.createConversation({
			model: "mock-driver/mock-model",
		})) as BHZAIConversationImpl

		bh.addTool({
			name: "get_weather",
			description: "Weather",
			inputSchema: { type: "object" },
			execute: async () => "sunny",
		})

		let callCount = 0
		const driver = makeMockDriver([])
		driver.chat = vi.fn(async function* (_request: ChatRequest) {
			callCount++
			if (callCount === 1) {
				yield {
					type: "tool-call" as const,
					toolCallId: "call_1",
					name: "get_weather",
					input: '{"city":"SF"}',
				}
				yield { type: "done" as const, stopReason: "tool-calls" as const }
			} else {
				yield { type: "delta" as const, text: "It is sunny." }
				yield { type: "done" as const, stopReason: "stop" as const }
			}
		}) as typeof driver.chat
		bh.addDriver(driver)

		await sendMessage(conversation, "weather?")

		const assistant = conversation.messages.filter((m) => m.role === "assistant")
		expect(assistant[0]?.meta.toolCalls).toEqual([
			{ id: "call_1", name: "get_weather", arguments: '{"city":"SF"}' },
		])
		// The tool-result message still carries the id it answers, so the two
		// halves of the pairing line up.
		const toolMsg = conversation.messages.find((m) => m.role === "tool")
		expect(toolMsg?.meta.toolCallId).toBe("call_1")
		// A turn that made no tool calls carries no record at all.
		expect(assistant[1]?.meta.toolCalls).toBeUndefined()
	})

	it("serializes a structured tool-call input into the recorded arguments string", async () => {
		const conversation = (await bh.createConversation({
			model: "mock-driver/mock-model",
		})) as BHZAIConversationImpl

		bh.addTool({
			name: "t",
			description: "t",
			inputSchema: { type: "object" },
			execute: async () => "ok",
		})

		let callCount = 0
		const driver = makeMockDriver([])
		driver.chat = vi.fn(async function* (_request: ChatRequest) {
			callCount++
			if (callCount === 1) {
				// A driver that yields a parsed object rather than raw JSON text.
				yield { type: "tool-call" as const, toolCallId: "c1", name: "t", input: { a: 1 } }
				yield { type: "done" as const, stopReason: "tool-calls" as const }
			} else {
				yield { type: "done" as const, stopReason: "stop" as const }
			}
		}) as typeof driver.chat
		bh.addDriver(driver)

		await sendMessage(conversation, "go")

		const assistant = conversation.messages.find((m) => m.role === "assistant")
		expect(assistant?.meta.toolCalls).toEqual([{ id: "c1", name: "t", arguments: '{"a":1}' }])
	})
})
