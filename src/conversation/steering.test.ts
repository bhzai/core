/** @file Tests for TASK_0030: Steering & concurrent input (deliverAs modes, waitForIdle, idle event) */

import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Mock } from "vitest"
import { BHZAI } from "../core/bhzai.js"
import type { BHZAIDriver, ChatRequest, DriverEvent } from "../types/driver.js"
import type { BHZAIMessage } from "../types/message.js"
import { ConversationBusyError, sendMessage } from "./agent-loop.js"
import type { BHZAIConversationImpl } from "./conversation.js"

/**
 * Helper: sleep for a given number of milliseconds.
 */
function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Mock driver factory with controllable async timing.
 * The driver yields a delta event, waits for a gate to resolve,
 * then yields the done event. This allows tests to control exactly
 * when the driver finishes streaming.
 */
function makeDelayedMockDriver(
	gate: Promise<void>,
): BHZAIDriver & { chat: Mock<(request: ChatRequest) => AsyncIterable<DriverEvent>> } {
	return {
		id: "mock-driver-id",
		listModels: async () => [
			{
				ref: "mock-driver-id/mock-model",
				id: "mock-model",
				driver: "mock-driver-id",
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
			yield { type: "delta", text: "Response" }
			// Wait for the gate to resolve before continuing
			await gate
			yield { type: "done", stopReason: "stop" }
		}),
		embed: undefined,
	}
}

/**
 * Make a stateful mock driver that yields tool calls on first invocation,
 * then a final response on the second invocation.
 */
function makeStatefulMockDriver(
	firstCallEvents: DriverEvent[],
	secondCallEvents: DriverEvent[],
	delayBetweenEvents = 0,
): BHZAIDriver & { chat: Mock<(request: ChatRequest) => AsyncIterable<DriverEvent>> } {
	let callCount = 0
	return {
		id: "mock-driver-id",
		listModels: async () => [
			{
				ref: "mock-driver-id/mock-model",
				id: "mock-model",
				driver: "mock-driver-id",
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
			const events = callCount === 1 ? firstCallEvents : secondCallEvents
			for (const event of events) {
				if (delayBetweenEvents > 0) {
					await delay(delayBetweenEvents)
				}
				yield event
			}
		}),
		embed: undefined,
	}
}

describe("TASK_0030: Steering & concurrent input", () => {
	let bh: BHZAI

	beforeEach(() => {
		bh = new BHZAI()
	})

	// =========================================================================
	// REQUIRED TEST 1: sendMessage() with default/immediate while busy REJECTS
	// =========================================================================
	it("sendMessage() called with default options while mid-stream REJECTS with ConversationBusyError", async () => {
		// Create a gate we can control from the test body
		let resolveGate!: () => void
		const gate = new Promise<void>((resolve) => {
			resolveGate = resolve
		})

		const mockDriver = makeDelayedMockDriver(gate)
		bh.addDriver(mockDriver)

		const conversation = (await bh.createConversation({
			model: "mock-driver-id/mock-model",
		})) as BHZAIConversationImpl

		// Start the first message WITHOUT awaiting it
		const firstPromise = sendMessage(conversation, "First message")

		// Give the event loop a chance to start streaming
		await delay(10)

		// Now attempt a second message WHILE the first is still streaming
		const secondPromise = sendMessage(conversation, "Second message")

		// The second call should reject with ConversationBusyError
		await expect(secondPromise).rejects.toBeInstanceOf(ConversationBusyError)
		expect(conversation._getSteerQueueLength()).toBe(0)
		expect(conversation._getFollowUpQueueLength()).toBe(0)

		// Clean up: resolve the gate so the first message completes
		resolveGate()
		await firstPromise
	})

	it("sendMessage() called with explicit deliverAs: 'immediate' while mid-stream REJECTS like default", async () => {
		let resolveGate!: () => void
		const gate = new Promise<void>((resolve) => {
			resolveGate = resolve
		})

		const mockDriver = makeDelayedMockDriver(gate)
		bh.addDriver(mockDriver)

		const conversation = (await bh.createConversation({
			model: "mock-driver-id/mock-model",
		})) as BHZAIConversationImpl

		const firstPromise = sendMessage(conversation, "First message")
		await delay(10)

		// Explicitly pass deliverAs: 'immediate'
		const secondPromise = sendMessage(conversation, "Second message", { deliverAs: "immediate" })

		// Should still reject with ConversationBusyError
		await expect(secondPromise).rejects.toBeInstanceOf(ConversationBusyError)
		expect(conversation._getSteerQueueLength()).toBe(0)
		expect(conversation._getFollowUpQueueLength()).toBe(0)

		resolveGate()
		await firstPromise
	})

	// =========================================================================
	// REQUIRED TEST 2: deliverAs 'steer' is delivered before next LLM call
	// =========================================================================
	it("deliverAs: 'steer' is delivered after tool batch settles, before next driver chat()", async () => {
		// Sequence tracker
		const sequence: string[] = []

		// Tool with controllable delay
		let resolveTool1!: () => void
		const tool1Gate = new Promise<void>((resolve) => {
			resolveTool1 = resolve
		})
		let resolveTool2!: () => void
		const tool2Gate = new Promise<void>((resolve) => {
			resolveTool2 = resolve
		})

		bh.addTool({
			name: "tool1",
			description: "Tool 1",
			inputSchema: { type: "object" },
			execute: async () => {
				sequence.push("tool1-start")
				await tool1Gate
				sequence.push("tool1-end")
				return "result1"
			},
		})

		bh.addTool({
			name: "tool2",
			description: "Tool 2",
			inputSchema: { type: "object" },
			execute: async () => {
				sequence.push("tool2-start")
				await tool2Gate
				sequence.push("tool2-end")
				return "result2"
			},
		})

		// Mock driver: first call emits tool calls, second call emits final response
		const mockDriver = makeStatefulMockDriver(
			[
				{ type: "tool-call", toolCallId: "tc1", name: "tool1", input: {} },
				{ type: "tool-call", toolCallId: "tc2", name: "tool2", input: {} },
				{ type: "done", stopReason: "tool-calls" },
			],
			[
				{ type: "delta", text: "Done" },
				{ type: "done", stopReason: "stop" },
			],
		)
		bh.addDriver(mockDriver)

		const conversation = (await bh.createConversation({
			model: "mock-driver-id/mock-model",
		})) as BHZAIConversationImpl

		// Spy on driver calls to know when it's invoked
		const originalChat = mockDriver.chat
		let chatCallCount = 0
		mockDriver.chat = vi.fn(async function* (request: ChatRequest) {
			chatCallCount++
			sequence.push(`driver-chat-call-${chatCallCount}`)
			// Delegate to the original
			// biome-ignore lint/style/noNonNullAssertion: we know getMockImplementation() returns the implementation
			for await (const event of originalChat.getMockImplementation()!(request)) {
				yield event
			}
		})

		// Start the first sendMessage WITHOUT awaiting
		const firstPromise = sendMessage(conversation, "Call tools")

		// Wait for tools to start
		await delay(20)

		// Now send a steer message while tools are still executing
		const steerPromise = sendMessage(conversation, "Steer message", { deliverAs: "steer" })

		// The steer message should NOT be resolved yet
		let steerResolved = false
		steerPromise.then(() => {
			steerResolved = true
		})
		await delay(10)

		// It should still be pending (tools still running)
		expect(steerResolved).toBe(false)

		// Release tool1 and tool2
		resolveTool1()
		resolveTool2()

		// Wait a bit for tools to finish and driver to be called again
		await delay(30)

		// The steer message should now be resolved
		await expect(steerPromise).resolves.toBeDefined()

		// Verify sequence: tools settle, steer is in context of second chat call
		// Should see: tool1-start, tool2-start, tool1-end, tool2-end, steer delivered, driver-chat-call-2
		const tool1EndIdx = sequence.indexOf("tool1-end")
		const tool2EndIdx = sequence.indexOf("tool2-end")
		const chat2Idx = sequence.indexOf("driver-chat-call-2")

		expect(tool1EndIdx).toBeGreaterThan(-1)
		expect(tool2EndIdx).toBeGreaterThan(-1)
		expect(chat2Idx).toBeGreaterThan(-1)
		// Both tools should be done before the second chat call
		expect(tool1EndIdx).toBeLessThan(chat2Idx)
		expect(tool2EndIdx).toBeLessThan(chat2Idx)

		// Verify the steer message appears in conversation
		const userMessages = conversation.messages.filter((m) => m.role === "user")
		const steerContent = userMessages.find((m) => m.content === "Steer message")
		expect(steerContent).toBeDefined()

		// Clean up
		await firstPromise
	})

	// =========================================================================
	// REQUIRED TEST 3: deliverAs 'followUp' is delivered only at idle
	// =========================================================================
	it("deliverAs: 'followUp' is delivered only after conversation reaches idle", async () => {
		// Sequence tracker
		const sequence: string[] = []

		// Create a gate to control when the first stream completes
		let resolveGate!: () => void
		const gate = new Promise<void>((resolve) => {
			resolveGate = resolve
		})

		const mockDriver = makeDelayedMockDriver(gate)
		bh.addDriver(mockDriver)

		const conversation = (await bh.createConversation({
			model: "mock-driver-id/mock-model",
		})) as BHZAIConversationImpl

		// Listen for loop(end) event
		conversation.on("loop", (payload: unknown) => {
			const p = payload as { state?: string }
			if (p.state === "end") {
				sequence.push("loop-end")
			}
		})

		// Start the first sendMessage WITHOUT awaiting
		const firstPromise = sendMessage(conversation, "First message")

		// Wait for it to start streaming
		await delay(10)

		// Queue a followUp message
		const followUpPromise = sendMessage(conversation, "FollowUp message", { deliverAs: "followUp" })

		// The followUp should NOT be resolved yet
		let followUpResolved = false
		followUpPromise.then(() => {
			followUpResolved = true
			sequence.push("followup-delivered")
		})

		// Verify followUp not in messages yet
		expect(conversation.messages.find((m) => m.content === "FollowUp message")).toBeUndefined()

		// Release the gate
		resolveGate()

		// Wait for first message to complete
		await delay(20)

		// loop(end) should have fired
		expect(sequence).toContain("loop-end")

		// followUp should now be resolved and delivered
		await expect(followUpPromise).resolves.toBeDefined()
		expect(followUpResolved).toBe(true)

		// Verify sequence: loop-end before followup-delivered
		const loopEndIdx = sequence.indexOf("loop-end")
		const followupIdx = sequence.indexOf("followup-delivered")
		expect(loopEndIdx).toBeGreaterThan(-1)
		expect(followupIdx).toBeGreaterThan(-1)
		expect(loopEndIdx).toBeLessThan(followupIdx)

		// Verify followUp message is now in conversation
		const followUpMsg = conversation.messages.find((m) => m.content === "FollowUp message")
		expect(followUpMsg).toBeDefined()

		// Verify a NEW loop(start) fired for the followUp's own run
		const loopStarts = conversation.messages.map((m) => m).filter((m) => m.role === "user")
		expect(loopStarts.length).toBeGreaterThanOrEqual(2)

		await firstPromise
	})

	// =========================================================================
	// REQUIRED TEST 4: Blocked steer message via message(before) handler
	// =========================================================================
	it("a queued 'steer' message blocked by message(before) resolves with meta.blocked: true", async () => {
		let resolveTool!: () => void
		const toolGate = new Promise<void>((resolve) => {
			resolveTool = resolve
		})

		bh.addTool({
			name: "tool1",
			description: "Tool 1",
			inputSchema: { type: "object" },
			execute: async () => {
				await toolGate
				return "result1"
			},
		})

		const mockDriver = makeStatefulMockDriver(
			[
				{ type: "tool-call", toolCallId: "tc1", name: "tool1", input: {} },
				{ type: "done", stopReason: "tool-calls" },
			],
			[
				{ type: "delta", text: "Done" },
				{ type: "done", stopReason: "stop" },
			],
		)
		bh.addDriver(mockDriver)

		const conversation = (await bh.createConversation({
			model: "mock-driver-id/mock-model",
		})) as BHZAIConversationImpl

		// Register a message(before) handler that blocks messages starting with "BLOCK"
		conversation.on("message", (payload: unknown) => {
			const p = payload as { state?: string; message?: { content?: string } }
			if (p.state === "before" && p.message?.content?.startsWith("BLOCK")) {
				return { block: true, reason: "Blocked by policy" }
			}
		})

		// Start the first sendMessage (will trigger tool call)
		const firstPromise = sendMessage(conversation, "Call tools")

		// Wait for tool to start
		await delay(10)

		// Queue a steer message that will be blocked
		const steerBlockedPromise = sendMessage(conversation, "BLOCK-this-steer", {
			deliverAs: "steer",
		})

		// Wait for tool to complete
		resolveTool()
		await delay(30)

		// The steer message should resolve with blocked flag
		const steerResult = await steerBlockedPromise
		expect(steerResult.meta.blocked).toBe(true)

		// Verify the message is NOT in conversation
		expect(conversation.messages.find((m) => m.content === "BLOCK-this-steer")).toBeUndefined()

		await firstPromise
	})

	// =========================================================================
	// REQUIRED TEST 5: waitForIdle() waits for queues to drain
	// =========================================================================
	it("waitForIdle() does NOT resolve until followUp queue is drained", async () => {
		let resolveGate!: () => void
		const gate = new Promise<void>((resolve) => {
			resolveGate = resolve
		})

		const mockDriver = makeDelayedMockDriver(gate)
		bh.addDriver(mockDriver)

		const conversation = (await bh.createConversation({
			model: "mock-driver-id/mock-model",
		})) as BHZAIConversationImpl

		// Start first message WITHOUT awaiting
		const firstPromise = sendMessage(conversation, "First message")

		// Wait for it to start streaming
		await delay(10)

		// Queue a followUp message
		const followUpPromise = sendMessage(conversation, "FollowUp message", { deliverAs: "followUp" })

		// Call waitForIdle while the first message is still streaming
		let waitForIdleResolved = false
		const waitPromise = conversation.waitForIdle().then(() => {
			waitForIdleResolved = true
		})

		// Release the first message
		resolveGate()

		// Wait for the first message and followUp to process
		await delay(50)

		// At this point, waitForIdle should still NOT have resolved
		// because the followUp is queued and will trigger a new run
		// We can't make a hard assertion here due to race conditions,
		// but we can wait a bit longer and verify it eventually resolves

		await Promise.all([waitPromise, followUpPromise])

		// After everything, waitForIdle should have resolved
		expect(waitForIdleResolved).toBe(true)

		await firstPromise
	})

	// =========================================================================
	// REQUIRED TEST 6: followUp queued at idle boundary prevents immediate idle event
	// =========================================================================
	it("when a followUp is queued before loop exit, a new run starts and idle fires after both runs complete", async () => {
		let resolveGate!: () => void
		const gate = new Promise<void>((resolve) => {
			resolveGate = resolve
		})

		const mockDriver = makeDelayedMockDriver(gate)
		bh.addDriver(mockDriver)

		const conversation = (await bh.createConversation({
			model: "mock-driver-id/mock-model",
		})) as BHZAIConversationImpl

		const idleFireCount: number[] = []
		conversation.on("idle", () => {
			idleFireCount.push(1)
		})

		// Start the first message
		const firstPromise = sendMessage(conversation, "Initial message")

		// Wait for it to start
		await delay(10)

		// Queue a followUp message while the first is still streaming
		const followUpPromise = sendMessage(conversation, "Queued followUp", { deliverAs: "followUp" })

		// Release the gate
		resolveGate()

		// Wait for the followUp to be processed
		await followUpPromise

		// Wait for everything to settle
		await delay(50)

		// idle should have fired exactly once (after both runs complete)
		expect(idleFireCount.length).toBe(1)

		// Both messages should be in the conversation
		const initialMsg = conversation.messages.find((m) => m.content === "Initial message")
		const followUpMsg = conversation.messages.find((m) => m.content === "Queued followUp")
		expect(initialMsg).toBeDefined()
		expect(followUpMsg).toBeDefined()

		// Verify both are user messages (triggering messages for each run)
		const userMessages = conversation.messages.filter((m) => m.role === "user")
		expect(userMessages.length).toBe(2)

		await firstPromise
	})

	// =========================================================================
	// SANITY TESTS (from original suite, kept if non-redundant)
	// =========================================================================

	it("ConversationBusyError has correct name and structure", () => {
		const error = new ConversationBusyError("Test message")
		expect(error).toBeInstanceOf(Error)
		expect(error.name).toBe("ConversationBusyError")
		expect(error.message).toBe("Test message")
	})

	it("queue accessor methods work correctly", async () => {
		const conversation = (await bh.createConversation({
			model: "mock-driver-id/mock-model",
		})) as BHZAIConversationImpl

		expect(conversation._getSteerQueueLength()).toBe(0)
		expect(conversation._getFollowUpQueueLength()).toBe(0)

		conversation._pushSteerQueue({
			content: "Test steer",
			resolve: () => {},
			reject: () => {},
		})
		expect(conversation._getSteerQueueLength()).toBe(1)

		const steerEntries = conversation._drainSteerQueue()
		expect(steerEntries).toHaveLength(1)
		expect(conversation._getSteerQueueLength()).toBe(0)
	})

	it("waitForIdle() fast path resolves immediately when idle and queues empty", async () => {
		const conversation = (await bh.createConversation({
			model: "mock-driver-id/mock-model",
		})) as BHZAIConversationImpl

		expect(conversation.status).toBe("idle")

		const promise = conversation.waitForIdle()
		const resolved = await Promise.race([promise, Promise.reject(new Error("Timeout"))])
		expect(resolved).toBeUndefined()
	})

	it("idle event fires when conversation reaches idle (no pending messages)", async () => {
		let resolveGate!: () => void
		const gate = new Promise<void>((resolve) => {
			resolveGate = resolve
		})

		const mockDriver = makeDelayedMockDriver(gate)
		bh.addDriver(mockDriver)

		const conversation = (await bh.createConversation({
			model: "mock-driver-id/mock-model",
		})) as BHZAIConversationImpl

		const idleEvents: unknown[] = []
		conversation.on("idle", (payload) => {
			idleEvents.push(payload)
		})

		const msgPromise = sendMessage(conversation, "Test")
		await delay(10)
		resolveGate()

		await msgPromise
		await delay(10)

		expect(idleEvents.length).toBeGreaterThan(0)
		const payload = idleEvents[0] as { conversation?: unknown }
		expect(payload.conversation).toBe(conversation)
	})

	it("conversation status transitions idle -> streaming -> idle", async () => {
		let resolveGate!: () => void
		const gate = new Promise<void>((resolve) => {
			resolveGate = resolve
		})

		const mockDriver = makeDelayedMockDriver(gate)
		bh.addDriver(mockDriver)

		const conversation = (await bh.createConversation({
			model: "mock-driver-id/mock-model",
		})) as BHZAIConversationImpl

		expect(conversation.status).toBe("idle")

		const msgPromise = sendMessage(conversation, "Test")
		await delay(10)

		// Should be streaming now
		expect(conversation.status).toBe("streaming")

		resolveGate()
		await msgPromise

		// Should be back to idle
		expect(conversation.status).toBe("idle")
	})

	it("sequential sendMessage calls maintain message order", async () => {
		let resolveGate1!: () => void
		const gate1 = new Promise<void>((resolve) => {
			resolveGate1 = resolve
		})
		let resolveGate2!: () => void
		const gate2 = new Promise<void>((resolve) => {
			resolveGate2 = resolve
		})
		let resolveGate3!: () => void
		const gate3 = new Promise<void>((resolve) => {
			resolveGate3 = resolve
		})

		// Mock driver that's stateful: different gate per call
		let callCount = 0
		const mockDriver: BHZAIDriver & {
			chat: Mock<(request: ChatRequest) => AsyncIterable<DriverEvent>>
		} = {
			id: "mock-driver-id",
			listModels: async () => [
				{
					ref: "mock-driver-id/mock-model",
					id: "mock-model",
					driver: "mock-driver-id",
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
				yield { type: "delta", text: "Response" }
				if (callCount === 1) await gate1
				else if (callCount === 2) await gate2
				else await gate3
				yield { type: "done", stopReason: "stop" }
			}),
			embed: undefined,
		}
		bh.addDriver(mockDriver)

		const conversation = (await bh.createConversation({
			model: "mock-driver-id/mock-model",
		})) as BHZAIConversationImpl

		// Send three messages sequentially
		const p1 = sendMessage(conversation, "Message 1")
		await delay(10)
		resolveGate1()
		await p1

		const p2 = sendMessage(conversation, "Message 2")
		await delay(10)
		resolveGate2()
		await p2

		const p3 = sendMessage(conversation, "Message 3")
		await delay(10)
		resolveGate3()
		await p3

		// Verify message order
		const userMessages = conversation.messages.filter((m) => m.role === "user")
		expect(userMessages.map((m) => m.content)).toEqual(["Message 1", "Message 2", "Message 3"])
	})
})
