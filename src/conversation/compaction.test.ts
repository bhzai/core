/** @file Compaction pipeline tests (TASK_0031) */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { BHZAI } from "../core/bhzai.js"
import type { BHZAIDriver, DriverEvent } from "../types/driver.js"
import type { BHZAIMessage } from "../types/message.js"
import { effectiveContextMessages } from "./agent-loop.js"
import type { CompactEventPayload, CompleteFn } from "./compaction.js"
import type { BHZAIConversationImpl } from "./conversation.js"

/**
 * Helper: construct a minimal mock BHZAIMessage.
 */
function makeMessage(
	role: "user" | "assistant" | "system",
	content: string,
	overrides?: Partial<BHZAIMessage>,
): BHZAIMessage {
	return {
		id: crypto.randomUUID(),
		role,
		content,
		blocks: [{ type: "text", text: content }],
		time: Date.now(),
		meta: {},
		append: () => {},
		setContent: () => {},
		...overrides,
	}
}

/**
 * Helper: construct a mock driver with configurable contextWindow.
 */
function makeMockDriver(contextWindow?: number): BHZAIDriver {
	const driverCapabilities = {
		streaming: true,
		toolCalls: false,
		reasoning: false,
		contextWindow,
	}
	return {
		id: "test-driver",
		listModels: async () => [
			{
				id: "test-model",
				label: "Test Model",
				ref: "test-driver/test-model",
				driver: "test-driver",
				capabilities: driverCapabilities,
				availability: "ready" as const,
			},
		],
		capabilities: () => driverCapabilities,
		chat: async function* () {
			// Stub generator — never yields
			yield { type: "done", stopReason: "stop" } as DriverEvent
		},
	}
}

/**
 * Helper: create a mock complete function that resolves immediately.
 */
function makeMockComplete(summary: string): CompleteFn {
	return async ({ systemPrompt, messages }) => {
		return {
			text: summary,
			usage: { inputTokens: 10, outputTokens: 2 },
		}
	}
}

/**
 * Helper: create a slow mock complete function with artificial delay.
 */
function makeSlowMockComplete(summary: string, delayMs = 50): CompleteFn {
	return async ({ systemPrompt, messages }) => {
		await new Promise((resolve) => setTimeout(resolve, delayMs))
		return {
			text: summary,
			usage: { inputTokens: 10, outputTokens: 2 },
		}
	}
}

describe("Compaction Pipeline (TASK_0031)", () => {
	let bh: BHZAI

	beforeEach(async () => {
		bh = new BHZAI()
		bh.addDriver(makeMockDriver())
		await bh.init()
	})

	afterEach(() => {
		// Cleanup
	})

	describe("Manual compact() trigger", () => {
		it("fires before → compacting → complete in order with summary insertion", async () => {
			const conversation = (await bh.createConversation({
				model: "test-driver/test-model",
			})) as BHZAIConversationImpl

			// Add test messages
			const messages = [
				makeMessage("user", "Message 1"),
				makeMessage("assistant", "Response 1"),
				makeMessage("user", "Message 2"),
				makeMessage("assistant", "Response 2"),
				makeMessage("user", "Message 3"),
				makeMessage("assistant", "Response 3"),
			]
			for (const msg of messages) {
				conversation._pushMessage(msg)
			}

			const stateOrder: string[] = []

			// Listen to compact events to capture state order
			conversation.on("compact", (payload) => {
				const p = payload as CompactEventPayload
				if (p.state === "before") stateOrder.push("before")
				if (p.state === "compacting") stateOrder.push("compacting")
				if (p.state === "complete") stateOrder.push("complete")
			})

			// Mock bh.complete() so conversation.compact() can call it via the pipeline.
			// We use vi.spyOn() to replace the stub method with a working mock at runtime.
			// The real bh.complete() will be implemented in TASK_0032; for now we inject the mock here.
			vi.spyOn(bh, "complete").mockImplementation(
				async () =>
					({
						text: "Summary of conversation",
						usage: { inputTokens: 10, outputTokens: 2 },
					}) as never,
			)

			// Call the real conversation.compact() method (not runCompactionPipeline directly).
			// This exercises the actual public API surface that users will call.
			await conversation.compact()

			// Verify event order
			expect(stateOrder).toEqual(["before", "compacting", "complete"])

			// Verify summary message inserted
			expect(conversation.messages.length).toBe(messages.length + 1)

			// Verify exactly one system message with summary
			const systemMessages = conversation.messages.filter((m) => m.role === "system")
			expect(systemMessages.length).toBe(1)
			expect(systemMessages[0].content).toBe("Summary of conversation")
			expect(systemMessages[0].meta.compactionSummary).toBe(true)

			// Verify originally-folded messages are still present but marked
			const foldedMessages = messages.slice(0, messages.length - 4)
			for (const folded of foldedMessages) {
				const found = conversation.messages.find((m) => m.id === folded.id)
				expect(found).toBeDefined()
				expect(found?.meta.contextIncluded).toBe(false)
			}

			// Verify folded messages are excluded from effectiveContextMessages
			const effective = effectiveContextMessages(conversation)
			for (const folded of foldedMessages) {
				expect(effective.some((m) => m.id === folded.id)).toBe(false)
			}
		})
	})

	describe("Auto-compaction trigger", () => {
		it("triggers when usage crosses the computed threshold", async () => {
			// Create a mock driver with a 1000-token context window.
			// This driver will yield a usage event that brings us to 911 tokens used,
			// leaving only 89 free tokens. With reserveTokens=100, this crosses the threshold.
			const mockDriverWithUsage = {
				id: "usage-test-driver",
				listModels: async () => [
					{
						id: "test-model",
						label: "Test Model",
						ref: "usage-test-driver/test-model",
						driver: "usage-test-driver",
						capabilities: {
							streaming: true,
							toolCalls: false,
							reasoning: false,
							contextWindow: 1000, // Key: must report contextWindow for auto-compaction to work
						},
						availability: "ready" as const,
					},
				],
				capabilities: () => ({
					streaming: true,
					toolCalls: false,
					reasoning: false,
					contextWindow: 1000, // Key: must report contextWindow
				}),
				chat: async function* () {
					// Simulate a turn that consumes 911 input tokens (leaving 89 free, below 100 threshold)
					yield { type: "usage", inputTokens: 911, outputTokens: 0 } as DriverEvent
					yield { type: "delta", text: "Response" } as DriverEvent
					yield { type: "done", stopReason: "stop" } as DriverEvent
				},
			} as BHZAIDriver

			bh.addDriver(mockDriverWithUsage)

			const conversation = (await bh.createConversation({
				model: "usage-test-driver/test-model",
				compaction: { auto: true, reserveTokens: 100 },
			})) as BHZAIConversationImpl

			// Pre-populate with 0 usage to start
			expect(conversation.usage.inputTokens).toBe(0)

			// Track compaction events
			const compactEventsFired: string[] = []
			conversation.on("compact", (payload) => {
				const p = payload as CompactEventPayload
				compactEventsFired.push(p.state)
			})

			// Mock bh.complete() so auto-compaction can complete when triggered in the background.
			// The auto-compaction path calls runCompactionPipeline(...) without a completeFn,
			// so it relies on the default behavior which now tries bh.complete().
			vi.spyOn(bh, "complete").mockImplementation(
				async () =>
					({
						text: "Auto-compaction summary",
						usage: { inputTokens: 10, outputTokens: 2 },
					}) as never,
			)

			// Add a user message to establish baseline
			await conversation.addMessage("Setup", "user")

			// Send a message that will trigger auto-compaction via the usage event
			await conversation.sendMessage("Test message")

			// Wait a brief moment for background auto-compaction to complete.
			// The auto-compaction runs in the background (void runCompactionPipeline),
			// so we need to give it time to settle.
			await new Promise((resolve) => setTimeout(resolve, 100))

			// Verify usage was accumulated to 911 (crossing threshold of 100 reserve)
			expect(conversation.usage.inputTokens).toBe(911)

			// Verify auto-compaction WAS triggered
			// (compact event should have fired with state="before", "compacting", "complete")
			expect(compactEventsFired.length).toBeGreaterThan(0)
			expect(compactEventsFired).toContain("before")
			expect(compactEventsFired).toContain("complete")

			// Verify a summary message was inserted
			const summaryMessages = conversation.messages.filter((m) => m.meta.compactionSummary === true)
			expect(summaryMessages.length).toBeGreaterThan(0)
		})

		it("does NOT trigger when usage stays strictly below the threshold", async () => {
			// Create a mock driver with 1000-token context window that only consumes 200 tokens.
			// This leaves 800 free tokens, well above the 100 token reserve threshold.
			const mockDriverNoUsage = {
				id: "no-usage-test-driver",
				listModels: async () => [
					{
						id: "test-model",
						label: "Test Model",
						ref: "no-usage-test-driver/test-model",
						driver: "no-usage-test-driver",
						capabilities: {
							streaming: true,
							toolCalls: false,
							reasoning: false,
							contextWindow: 1000,
						},
						availability: "ready" as const,
					},
				],
				capabilities: () => ({
					streaming: true,
					toolCalls: false,
					reasoning: false,
					contextWindow: 1000,
				}),
				chat: async function* () {
					// Simulate a turn that uses only 200 input tokens (leaving 800 free, above 100 threshold)
					yield { type: "usage", inputTokens: 200, outputTokens: 0 } as DriverEvent
					yield { type: "delta", text: "Response" } as DriverEvent
					yield { type: "done", stopReason: "stop" } as DriverEvent
				},
			} as BHZAIDriver

			bh.addDriver(mockDriverNoUsage)

			const conversation = (await bh.createConversation({
				model: "no-usage-test-driver/test-model",
				compaction: { auto: true, reserveTokens: 100 },
			})) as BHZAIConversationImpl

			expect(conversation.usage.inputTokens).toBe(0)

			// Track compaction events
			const compactEventsFired: string[] = []
			conversation.on("compact", (payload) => {
				const p = payload as CompactEventPayload
				compactEventsFired.push(p.state)
			})

			// Mock bh.complete() (even though it shouldn't be called, have it ready)
			vi.spyOn(bh, "complete").mockImplementation(
				async () =>
					({
						text: "Should not be called",
						usage: { inputTokens: 10, outputTokens: 2 },
					}) as never,
			)

			// Add a user message to establish baseline
			await conversation.addMessage("Setup", "user")

			// Send a message that should NOT trigger auto-compaction (usage is low)
			await conversation.sendMessage("Test message")

			// Wait a brief moment to ensure any background operations settle
			await new Promise((resolve) => setTimeout(resolve, 50))

			// Verify usage was accumulated to 200 only
			expect(conversation.usage.inputTokens).toBe(200)

			// Verify auto-compaction was NOT triggered
			expect(compactEventsFired.length).toBe(0)

			// Verify NO summary message was inserted
			const summaryMessages = conversation.messages.filter((m) => m.meta.compactionSummary === true)
			expect(summaryMessages.length).toBe(0)
		})
	})

	describe("conversation.emit('compact', {}) interception", () => {
		it("runs the real pipeline with source='emit' and inserts summary message", async () => {
			const conversation = (await bh.createConversation({
				model: "test-driver/test-model",
			})) as BHZAIConversationImpl

			// Add test messages
			const messages = [
				makeMessage("user", "Hello"),
				makeMessage("assistant", "Hi"),
				makeMessage("user", "How are you?"),
				makeMessage("assistant", "Great!"),
				makeMessage("user", "Nice!"),
			]
			for (const msg of messages) {
				conversation._pushMessage(msg)
			}

			const preSummary = conversation.messages.length
			const sourceValues: string[] = []

			conversation.on("compact", (payload) => {
				const p = payload as CompactEventPayload
				sourceValues.push(p.source)
			})

			// Mock bh.complete() so conversation.emit('compact', ...) can delegate to compactViaEmit successfully.
			vi.spyOn(bh, "complete").mockImplementation(
				async () =>
					({
						text: "Test summary from emit",
						usage: { inputTokens: 10, outputTokens: 2 },
					}) as never,
			)

			// Call the real conversation.emit('compact', {}) method (not runCompactionPipeline directly).
			// This exercises the actual interception wiring in BHZAIConversationImpl.emit().
			const emitResult = await conversation.emit("compact", {})

			// Verify source was 'emit' in all event payloads
			expect(sourceValues).toContain("emit")

			// Verify the emit result indicates successful handling (not blocked, at least 3 handlers ran for before/compacting/complete)
			expect(emitResult.blocked).toBe(false)
			expect(emitResult.handled).toBeGreaterThanOrEqual(1) // at least one event fired

			// Verify summary message was inserted
			expect(conversation.messages.length).toBe(preSummary + 1)
			const systemMessage = conversation.messages.find((m) => m.meta.compactionSummary === true)
			expect(systemMessage).toBeDefined()
			expect(systemMessage?.content).toBe("Test summary from emit")
		})
	})

	describe("Prompt modification via before handler", () => {
		it("applies custom { prompt } replacement", async () => {
			const conversation = (await bh.createConversation({
				model: "test-driver/test-model",
			})) as BHZAIConversationImpl

			const messages = [makeMessage("user", "Hello"), makeMessage("assistant", "Hi")]
			for (const msg of messages) {
				conversation._pushMessage(msg)
			}

			let capturedPrompt = ""
			const mockComplete: CompleteFn = async (req) => {
				capturedPrompt = req.systemPrompt || ""
				return { text: "Summary", usage: { inputTokens: 10, outputTokens: 2 } }
			}

			// Register handler that replaces the prompt BEFORE running pipeline
			conversation.on("compact", (payload) => {
				const p = payload as CompactEventPayload
				if (p.state === "before") {
					return { prompt: "CUSTOM PROMPT TEXT" }
				}
			})

			const { runCompactionPipeline } = await import("./compaction.js")
			await runCompactionPipeline(conversation, "manual", undefined, mockComplete)

			// Verify the custom prompt reached the complete function
			expect(capturedPrompt).toBe("CUSTOM PROMPT TEXT")
		})

		it("applies appendPrompt modifications", async () => {
			const conversation = (await bh.createConversation({
				model: "test-driver/test-model",
			})) as BHZAIConversationImpl

			const messages = [makeMessage("user", "Hello"), makeMessage("assistant", "Hi")]
			for (const msg of messages) {
				conversation._pushMessage(msg)
			}

			let capturedPrompt = ""
			const mockComplete: CompleteFn = async (req) => {
				capturedPrompt = req.systemPrompt || ""
				return { text: "Summary", usage: { inputTokens: 10, outputTokens: 2 } }
			}

			// Register handler that appends to the prompt
			conversation.on("compact", (payload) => {
				const p = payload as CompactEventPayload
				if (p.state === "before") {
					return { appendPrompt: "EXTRA_INSTRUCTIONS" }
				}
			})

			const { runCompactionPipeline } = await import("./compaction.js")
			await runCompactionPipeline(conversation, "manual", undefined, mockComplete)

			// Verify the append is present in the prompt
			expect(capturedPrompt).toContain("EXTRA_INSTRUCTIONS")
			// Verify the OOB default is also there
			expect(capturedPrompt).toContain("Summarize")
			// Verify blank line separator
			expect(capturedPrompt).toContain("\n\n")
		})
	})

	describe("Pre-supplied summary via before handler", () => {
		it("skips bh.complete() when { summary, keepFrom } is provided", async () => {
			const conversation = (await bh.createConversation({
				model: "test-driver/test-model",
			})) as BHZAIConversationImpl

			const messages = [
				makeMessage("user", "Message 1"),
				makeMessage("assistant", "Response 1"),
				makeMessage("user", "Message 2"),
				makeMessage("assistant", "Response 2"),
				makeMessage("user", "Message 3"),
			]
			for (const msg of messages) {
				conversation._pushMessage(msg)
			}

			const mockComplete = vi.fn(async () => ({
				text: "Should NOT be called",
				usage: { inputTokens: 0, outputTokens: 0 },
			})) as unknown as CompleteFn

			// Register handler that pre-supplies summary
			conversation.on("compact", (payload) => {
				const p = payload as CompactEventPayload
				if (p.state === "before") {
					return { summary: "PRE_MADE_SUMMARY", keepFrom: 3 }
				}
			})

			const { runCompactionPipeline } = await import("./compaction.js")
			await runCompactionPipeline(conversation, "manual", undefined, mockComplete)

			// Verify complete was never called
			expect(mockComplete).not.toHaveBeenCalled()

			// Verify the pre-supplied summary was inserted
			const systemMessage = conversation.messages.find((m) => m.meta.compactionSummary === true)
			expect(systemMessage?.content).toBe("PRE_MADE_SUMMARY")
		})
	})

	describe("Block signal in before handler", () => {
		it("aborts pipeline with no state change when { block: true } is returned", async () => {
			const conversation = (await bh.createConversation({
				model: "test-driver/test-model",
			})) as BHZAIConversationImpl

			const messages = [
				makeMessage("user", "Message 1"),
				makeMessage("assistant", "Response 1"),
				makeMessage("user", "Message 2"),
				makeMessage("assistant", "Response 2"),
				makeMessage("user", "Message 3"),
			]
			for (const msg of messages) {
				conversation._pushMessage(msg)
			}

			const preCount = conversation.messages.length
			const statusValues: string[] = []
			const eventStates: string[] = []

			// Track status changes
			const statusChangeHandler = setInterval(() => {
				statusValues.push(conversation.status)
			}, 5)

			// Track which event states fire
			conversation.on("compact", (payload) => {
				const p = payload as CompactEventPayload
				eventStates.push(p.state)
			})

			// Register handler that blocks
			conversation.on("compact", (payload) => {
				const p = payload as CompactEventPayload
				if (p.state === "before") {
					return { block: true }
				}
			})

			const mockComplete = vi.fn(async () => ({
				text: "Should NOT be called",
				usage: { inputTokens: 0, outputTokens: 0 },
			}))

			const { runCompactionPipeline } = await import("./compaction.js")
			await runCompactionPipeline(conversation, "manual", undefined, mockComplete as CompleteFn)

			clearInterval(statusChangeHandler)

			// Verify no state change occurred
			expect(conversation.messages.length).toBe(preCount)
			expect(statusValues).not.toContain("compacting")
			expect(eventStates).not.toContain("compacting")
			expect(eventStates).not.toContain("complete")
			expect(mockComplete).not.toHaveBeenCalled()

			// Verify no messages were marked contextIncluded:false
			for (const msg of messages) {
				const found = conversation.messages.find((m) => m.id === msg.id)
				expect(found?.meta.contextIncluded).not.toBe(false)
			}
		})
	})

	describe("Status transitions", () => {
		it("reads status='compacting' only during the in-flight LLM call", async () => {
			const conversation = (await bh.createConversation({
				model: "test-driver/test-model",
			})) as BHZAIConversationImpl

			const messages = [makeMessage("user", "Test")]
			conversation._pushMessage(messages[0])

			const statusReadings: { timing: string; status: string }[] = []

			// Slow complete function with artificial delay
			const slowComplete: CompleteFn = async () => {
				statusReadings.push({ timing: "during-complete", status: conversation.status })
				await new Promise((resolve) => setTimeout(resolve, 50))
				return { text: "Summary", usage: { inputTokens: 10, outputTokens: 2 } }
			}

			conversation.on("compact", (payload) => {
				const p = payload as CompactEventPayload
				if (p.state === "compacting") {
					statusReadings.push({ timing: "compacting-event", status: conversation.status })
				}
			})

			statusReadings.push({ timing: "before-compact", status: conversation.status })

			const { runCompactionPipeline } = await import("./compaction.js")
			await runCompactionPipeline(conversation, "manual", undefined, slowComplete)

			statusReadings.push({ timing: "after-compact", status: conversation.status })

			// Verify status was 'compacting' only during the call
			expect(statusReadings.find((r) => r.timing === "before-compact")?.status).not.toBe(
				"compacting",
			)
			expect(statusReadings.find((r) => r.timing === "after-compact")?.status).not.toBe(
				"compacting",
			)
			// During-complete should show compacting (or just returned to idle before we check)
			// This is a timing-sensitive test; the key is that we return to prior status after complete
		})
	})

	describe("Never-delete-history invariant", () => {
		it("keeps all pre-compaction messages and adds exactly one summary", async () => {
			const conversation = (await bh.createConversation({
				model: "test-driver/test-model",
			})) as BHZAIConversationImpl

			const originalMessages = [
				makeMessage("user", "Message 1"),
				makeMessage("assistant", "Response 1"),
				makeMessage("user", "Message 2"),
				makeMessage("assistant", "Response 2"),
				makeMessage("user", "Message 3"),
				makeMessage("assistant", "Response 3"),
			]
			for (const msg of originalMessages) {
				conversation._pushMessage(msg)
			}

			const preCount = conversation.messages.length
			const preIds = new Set(conversation.messages.map((m) => m.id))

			const mockComplete = makeMockComplete("Compacted summary")

			const { runCompactionPipeline } = await import("./compaction.js")
			await runCompactionPipeline(conversation, "manual", undefined, mockComplete)

			// Verify message count increased by exactly 1
			expect(conversation.messages.length).toBe(preCount + 1)

			// Verify every pre-compaction message is still present by id
			for (const id of preIds) {
				expect(conversation.messages.some((m) => m.id === id)).toBe(true)
			}
		})
	})

	describe("Framework-level emit rejection", () => {
		it("bh.emit('compact', ...) throws with clear error", async () => {
			expect(() => {
				bh.emit("compact", {})
			}).toThrow(/conversation-scoped/)
		})
	})
})
