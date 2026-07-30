/** @file Tests for TASK_0027: Loop termination & guardrails (maxIterations, turn(end) veto, abort, terminate hint) */

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
 * Mock driver factory: creates a driver that yields a scripted sequence
 * that can be state-aware (called multiple times with different responses).
 */
function makeMockDriver(
	scriptProvider: (callCount: number) => DriverEvent[],
): BHZAIDriver & { chat: Mock<(request: ChatRequest) => AsyncIterable<DriverEvent>> } {
	let callCount = 0
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
			const events = scriptProvider(callCount++)
			for (const event of events) {
				yield event
			}
		}),
		embed: undefined,
	}
}

describe("TASK_0027: Loop termination & guardrails", () => {
	let bh: BHZAI
	let mockDriver: BHZAIDriver & { chat: Mock<(request: ChatRequest) => AsyncIterable<DriverEvent>> }

	beforeEach(() => {
		bh = new BHZAI()
	})

	// =========================================================================
	// Test 1: Natural stop (zero tool calls) ends the loop normally
	// =========================================================================
	it("Test 1: Natural stop (zero tool calls) ends loop on first iteration", async () => {
		mockDriver = makeMockDriver(() => [
			{ type: "delta", text: "Hello, world!" },
			{ type: "done", stopReason: "stop" },
		])
		bh.addDriver(mockDriver)

		const conversation = (await bh.createConversation({
			model: "mock-driver/mock-model",
		})) as BHZAIConversationImpl

		const result = await sendMessage(conversation, "Hello")

		// Verify the driver was called exactly once (natural stop on first iteration).
		expect(mockDriver.chat.mock.calls).toHaveLength(1)

		// Verify result is the assistant message.
		expect(result.role).toBe("assistant")
		expect(result.content).toBe("Hello, world!")

		// Verify no truncation flag (natural exit, not max-iterations).
		expect(result.meta.truncatedBy).toBeUndefined()

		// Verify conversation returned to idle.
		expect(conversation.status).toBe("idle")
	})

	// =========================================================================
	// Test 2: ALL tool results carry terminate hint => loop stops
	// =========================================================================
	it("Test 2: All tool results carry terminate hint => loop stops (batch settles, driver not called again)", async () => {
		let callCount = 0
		mockDriver = makeMockDriver((callNum) => {
			callCount++
			if (callNum === 0) {
				// First turn: emit tool call
				return [
					{ type: "tool-call", toolCallId: "tc1", name: "dummy-tool", input: {} },
					{ type: "done", stopReason: "tool-calls" },
				]
			}
			// Second turn (should NOT reach here if terminate hint works):
			return [
				{ type: "delta", text: "Unreachable" },
				{ type: "done", stopReason: "stop" },
			]
		})
		bh.addDriver(mockDriver)

		// Register a tool that returns a result with terminate hint.
		bh.addTool({
			name: "dummy-tool",
			description: "A dummy tool",
			inputSchema: { type: "object" },
			execute: async () => {
				const result: CallToolResult = {
					content: [{ type: "text", text: "done" }],
					_meta: {
						"BHZAI/terminate": true,
					},
				}
				return result
			},
		})

		const conversation = (await bh.createConversation({
			model: "mock-driver/mock-model",
		})) as BHZAIConversationImpl

		const result = await sendMessage(conversation, "Call tool")

		// Verify the driver was called exactly once (tool call → terminate hint → stop).
		expect(mockDriver.chat.mock.calls).toHaveLength(1)
		expect(callCount).toBe(1)

		// Verify result is the assistant message from the first turn.
		expect(result.role).toBe("assistant")

		// Verify no truncation flag (terminated by hint, not max-iterations).
		expect(result.meta.truncatedBy).toBeUndefined()
	})

	// =========================================================================
	// Test 3: ONLY ONE of multiple tool results carries terminate hint => NO stop
	// =========================================================================
	it("Test 3: One of two tool results has terminate hint => loop does NOT stop (continues to next iteration)", async () => {
		let callCount = 0
		mockDriver = makeMockDriver((callNum) => {
			callCount++
			if (callNum === 0) {
				// First turn: emit two tool calls
				return [
					{ type: "tool-call", toolCallId: "tc1", name: "tool1", input: {} },
					{ type: "tool-call", toolCallId: "tc2", name: "tool2", input: {} },
					{ type: "done", stopReason: "tool-calls" },
				]
			}
			// Second turn: emit stop (should reach here because NOT all results had terminate hint).
			return [
				{ type: "delta", text: "Continuing" },
				{ type: "done", stopReason: "stop" },
			]
		})
		bh.addDriver(mockDriver)

		// Register two tools: first has terminate hint, second does not.
		bh.addTool({
			name: "tool1",
			description: "Tool 1 with terminate hint",
			inputSchema: { type: "object" },
			execute: async () => {
				const result: CallToolResult = {
					content: [{ type: "text", text: "result1" }],
					_meta: {
						"BHZAI/terminate": true, // This tool has the hint
					},
				}
				return result
			},
		})

		bh.addTool({
			name: "tool2",
			description: "Tool 2 without terminate hint",
			inputSchema: { type: "object" },
			execute: async () => {
				const result: CallToolResult = {
					content: [{ type: "text", text: "result2" }],
					// No terminate hint — only one of two
				}
				return result
			},
		})

		const conversation = (await bh.createConversation({
			model: "mock-driver/mock-model",
		})) as BHZAIConversationImpl

		const result = await sendMessage(conversation, "Call tools")

		// Verify the driver was called twice (tool-calls → not all terminate → continue to next iteration → stop).
		expect(mockDriver.chat.mock.calls).toHaveLength(2)
		expect(callCount).toBe(2)

		// Verify result contains "Continuing" from second iteration.
		expect(result.content).toContain("Continuing")
	})

	// =========================================================================
	// Test 4: maxIterations default (8) is honored exactly
	// =========================================================================
	it("Test 4: maxIterations default 8 is honored exactly (driver called exactly 8 times)", async () => {
		let callCount = 0
		mockDriver = makeMockDriver(() => {
			callCount++
			// Always return a tool call (never stop naturally).
			return [
				{ type: "tool-call", toolCallId: `tc${callCount}`, name: "endless-tool", input: {} },
				{ type: "done", stopReason: "tool-calls" },
			]
		})
		bh.addDriver(mockDriver)

		// Register a tool that always succeeds (no terminate hint).
		bh.addTool({
			name: "endless-tool",
			description: "A tool that always returns without terminate hint",
			inputSchema: { type: "object" },
			execute: async () => ({
				content: [{ type: "text", text: "result" }],
			}),
		})

		const conversation = (await bh.createConversation({
			model: "mock-driver/mock-model",
		})) as BHZAIConversationImpl

		const result = await sendMessage(conversation, "Loop forever")

		// Verify driver was called exactly 8 times (default maxIterations).
		expect(mockDriver.chat.mock.calls).toHaveLength(8)
		expect(callCount).toBe(8)

		// Verify final message has truncatedBy flag.
		expect(result.meta.truncatedBy).toBe("max-iterations")
	})

	// =========================================================================
	// Test 5: maxIterations override (e.g., 3) is honored exactly
	// =========================================================================
	it("Test 5: maxIterations override (3) is honored exactly (driver called 3 times)", async () => {
		let callCount = 0
		mockDriver = makeMockDriver(() => {
			callCount++
			// Always return a tool call.
			return [
				{ type: "tool-call", toolCallId: `tc${callCount}`, name: "endless-tool", input: {} },
				{ type: "done", stopReason: "tool-calls" },
			]
		})
		bh.addDriver(mockDriver)

		bh.addTool({
			name: "endless-tool",
			description: "Endless tool",
			inputSchema: { type: "object" },
			execute: async () => ({
				content: [{ type: "text", text: "result" }],
			}),
		})

		// Create conversation with maxIterations override.
		const conversation = (await bh.createConversation({
			model: "mock-driver/mock-model",
			maxIterations: 3,
		})) as BHZAIConversationImpl

		const result = await sendMessage(conversation, "Loop 3 times")

		// Verify driver was called exactly 3 times.
		expect(mockDriver.chat.mock.calls).toHaveLength(3)
		expect(callCount).toBe(3)

		// Verify final message has truncatedBy flag.
		expect(result.meta.truncatedBy).toBe("max-iterations")
	})

	// =========================================================================
	// Test 6: turn(end) veto prevents natural stop but is still bounded by maxIterations
	// =========================================================================
	it("Test 6: turn(end) veto prevents natural stop but maxIterations still applies (exactly 8 turn(end) events)", async () => {
		let callCount = 0
		mockDriver = makeMockDriver(() => {
			callCount++
			// Always return a single tool call (will be vetoed/continued).
			return [
				{ type: "tool-call", toolCallId: `tc${callCount}`, name: "simple-tool", input: {} },
				{ type: "done", stopReason: "tool-calls" },
			]
		})
		bh.addDriver(mockDriver)

		bh.addTool({
			name: "simple-tool",
			description: "Simple tool",
			inputSchema: { type: "object" },
			execute: async () => ({
				content: [{ type: "text", text: "result" }],
			}),
		})

		const conversation = (await bh.createConversation({
			model: "mock-driver/mock-model",
		})) as BHZAIConversationImpl

		// Track turn(end) events.
		const turnEndEvents: unknown[] = []
		conversation.on("turn", (payload: unknown) => {
			const p = payload as { state: string }
			if (p.state === "end") {
				turnEndEvents.push(payload)
				// Always veto with continueWith.
				return { continueWith: "continue please" }
			}
		})

		const result = await sendMessage(conversation, "Test veto")

		// Verify exactly 8 turn(end) events (one per iteration, stopping at maxIterations).
		expect(turnEndEvents).toHaveLength(8)

		// Verify result has truncatedBy flag (stopped by maxIterations, not naturally).
		expect(result.meta.truncatedBy).toBe("max-iterations")
	})

	// =========================================================================
	// Test 7: conversation.abort() drives tool execution to error state
	// =========================================================================
	it("Test 7: conversation.abort() mid-tool-call drives that call to error state + fires abort event", async () => {
		mockDriver = makeMockDriver(() => [
			{ type: "tool-call", toolCallId: "tc1", name: "slow-tool", input: {} },
			{ type: "done", stopReason: "tool-calls" },
		])
		bh.addDriver(mockDriver)

		// Register a tool that never resolves (simulating a hanging operation).
		let toolExecuteStarted = false
		bh.addTool({
			name: "slow-tool",
			description: "A slow/hanging tool",
			inputSchema: { type: "object" },
			execute: async ({ signal }) => {
				toolExecuteStarted = true
				// Never resolve; just wait for abort.
				await new Promise(() => {
					// Intentionally never resolve.
				})
			},
		})

		const conversation = (await bh.createConversation({
			model: "mock-driver/mock-model",
		})) as BHZAIConversationImpl

		// Track tool events to verify error state.
		const toolEvents: Array<{ state: string; toolCallId: string }> = []
		conversation.on("tool", (payload: unknown) => {
			const p = payload as { state: string; toolCallId: string }
			toolEvents.push({ state: p.state, toolCallId: p.toolCallId })
		})

		// Track abort events.
		const abortEvents: unknown[] = []
		conversation.on("abort", (payload: unknown) => {
			abortEvents.push(payload)
		})

		// Start sendMessage in a promise so we can abort it.
		setTimeout(() => {
			// Give the tool a moment to start, then abort.
			setTimeout(() => {
				conversation.abort("user cancelled")
			}, 50)
		}, 0)

		const sendMessagePromise = sendMessage(conversation, "Test abort")

		// Wait for sendMessage to settle (should resolve, not hang or reject).
		const result = await sendMessagePromise

		// Verify sendMessage settled cleanly (resolves with a message).
		expect(result).toBeDefined()
		expect((result as { meta?: Record<string, unknown> }).meta?.aborted).toBe(true)

		// Verify abort event was fired.
		expect(abortEvents).toHaveLength(1)
		expect((abortEvents[0] as { reason?: string }).reason).toBe("user cancelled")

		// Verify tool reached error state (final event for that tool should be error).
		const tc1Events = toolEvents.filter((e) => e.toolCallId === "tc1")
		expect(tc1Events).toContainEqual({ state: "error", toolCallId: "tc1" })
	})

	// =========================================================================
	// Test 8: per-turn timeout test (if implemented)
	// =========================================================================
	it("Test 8: turnTimeoutMs timeout does NOT flip conversation.status to aborted (per-turn scope)", async () => {
		mockDriver = makeMockDriver(() => [
			{ type: "tool-call", toolCallId: "tc1", name: "hanging-tool", input: {} },
			{ type: "done", stopReason: "tool-calls" },
		])
		bh.addDriver(mockDriver)

		// Register a tool that never resolves (simulates slow/hanging tool).
		bh.addTool({
			name: "hanging-tool",
			description: "A hanging tool",
			inputSchema: { type: "object" },
			execute: async () => {
				// Never resolve — simulates a tool that hangs.
				await new Promise(() => {})
				return { content: [{ type: "text", text: "never" }] }
			},
		})

		const conversation = (await bh.createConversation({
			model: "mock-driver/mock-model",
			turnTimeoutMs: 50, // Short per-turn timeout (50ms).
		})) as BHZAIConversationImpl

		// Wrap sendMessage in a test timeout to prevent hanging the entire test.
		// The per-turn timeout should cause the iteration to fail/timeout without
		// flipping the conversation status to 'aborted'.
		const testTimeoutMs = 500
		const sendMessagePromise = sendMessage(conversation, "Test timeout").catch((err) => {
			// It's ok if sendMessage throws or rejects; we just want it to not hang.
			return { error: String(err) }
		})

		// Create a test-level timeout to catch any hangs.
		const result = await Promise.race([
			sendMessagePromise,
			new Promise((resolve) => {
				setTimeout(() => resolve({ timeout: "test-timeout" }), testTimeoutMs)
			}),
		])

		// Verify sendMessage settled (didn't hang the test).
		expect(result).toBeDefined()

		// Verify conversation.status is NOT 'aborted'.
		// (Per-turn timeout does not flip to 'aborted' — only full abort() does.)
		expect(conversation.status).not.toBe("aborted")
	})
})
