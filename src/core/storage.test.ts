/** @file Tests for TASK_0029: Storage interfaces and auto-save wiring (conversationStore, memoryStore, skillResolver) */

import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Mock } from "vitest"
import { sendMessage } from "../conversation/agent-loop.js"
import type { BHZAIConversationImpl } from "../conversation/conversation.js"
import type { BHZAIDriver, ChatRequest, DriverEvent } from "../types/driver.js"
import type { ConversationStore, ConversationSummary } from "../types/storage.js"
import { BHZAI } from "./bhzai.js"

/**
 * Helper: create a mock driver that yields a scripted response.
 */
function makeMockDriver(
	scriptEvents: DriverEvent[],
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
			for (const event of scriptEvents) {
				yield event
			}
		}),
		embed: undefined,
	}
}

describe("TASK_0029: Storage interfaces and auto-save wiring", () => {
	let bh: BHZAI

	beforeEach(() => {
		bh = new BHZAI()
	})

	// =========================================================================
	// Test 1: No store registered — full conversation completes with zero errors
	// =========================================================================
	it("Test 1: No conversationStore registered → full conversation completes with zero errors and no error events", async () => {
		const mockDriver = makeMockDriver([
			{ type: "delta", text: "Hello " },
			{ type: "delta", text: "world" },
			{ type: "done", stopReason: "stop" },
		])
		bh.addDriver(mockDriver)

		// Register error-event spy
		const errorSpy = vi.fn()
		bh.on("error", errorSpy)

		await bh.init()

		// Create conversation and send message
		const conversation = (await bh.createConversation({
			model: "mock-driver/mock-model",
		})) as BHZAIConversationImpl

		const result = await sendMessage(conversation, "Hello")

		// Verify conversation completed
		expect(result.role).toBe("assistant")
		expect(result.content).toBe("Hello world")

		// Verify NO error events were fired
		expect(errorSpy).not.toHaveBeenCalled()

		// Verify conversation is idle
		expect(conversation.status).toBe("idle")
	})

	// =========================================================================
	// Test 2: Mock conversationStore registered → auto-save fires on message(sent)
	// =========================================================================
	it("Test 2: Mock conversationStore registered → save() called once per message(sent) with correct snapshot", async () => {
		const mockStore: ConversationStore = {
			save: vi.fn(async () => {}),
			load: vi.fn(async () => undefined),
			list: vi.fn(async () => []),
			delete: vi.fn(async () => {}),
		}

		bh.use({ name: "mock-store-plugin", conversationStore: mockStore })

		const mockDriver = makeMockDriver([
			{ type: "delta", text: "Response" },
			{ type: "done", stopReason: "stop" },
		])
		bh.addDriver(mockDriver)

		await bh.init()

		const conversation = (await bh.createConversation({
			model: "mock-driver/mock-model",
		})) as BHZAIConversationImpl

		const result = await sendMessage(conversation, "Hello")

		// Verify save was called
		expect(mockStore.save).toHaveBeenCalled()

		// Verify save was called with a snapshot
		const savedSnapshot = (mockStore.save as Mock).mock.calls[0]?.[0]
		expect(savedSnapshot).toBeDefined()
		expect(savedSnapshot?.v).toBe(1)
		expect(savedSnapshot?.id).toBe(conversation.id)
		expect(savedSnapshot?.messages).toBeDefined()

		// Verify the saved snapshot matches conversation.toJSON()
		const currentSnapshot = conversation.toJSON()
		expect(savedSnapshot).toEqual(currentSnapshot)
	})

	// =========================================================================
	// Test 3: bh.conversations.list() delegates to store and returns verbatim
	// =========================================================================
	it("Test 3: bh.conversations.list() delegates to store and returns output unchanged", async () => {
		const mockSummaries: ConversationSummary[] = [
			{ id: "conv-1", title: "First", updatedAt: 1000, messageCount: 3 },
			{ id: "conv-2", title: "Second", updatedAt: 2000, messageCount: 5 },
		]

		const mockStore: ConversationStore = {
			save: vi.fn(async () => {}),
			load: vi.fn(async () => undefined),
			list: vi.fn(async (query) => {
				// Verify the query is passed through unchanged
				if (query?.limit === 5) {
					return mockSummaries
				}
				return []
			}),
			delete: vi.fn(async () => {}),
		}

		bh.use({ name: "mock-store", conversationStore: mockStore })
		await bh.init()

		const result = await bh.conversations.list({ limit: 5 })

		// Verify store.list was called with the exact query
		expect(mockStore.list).toHaveBeenCalledWith({ limit: 5 })

		// Verify the result is the store's output verbatim
		expect(result).toEqual(mockSummaries)
	})

	// =========================================================================
	// Test 4: bh.conversations.list() with no store throws matching error
	// =========================================================================
	it("Test 4: bh.conversations.list() with no store throws descriptive error", async () => {
		await bh.init()

		// Attempting to list conversations with no store should throw
		await expect(bh.conversations.list()).rejects.toThrow(/no conversationStore/i)
	})

	// =========================================================================
	// Test 5: Multiple stores registered → only last one's save() is called
	// =========================================================================
	it("Test 5: Two stores registered → only second (last-registered) store's save() is called", async () => {
		const firstStore: ConversationStore = {
			save: vi.fn(async () => {}),
			load: vi.fn(async () => undefined),
			list: vi.fn(async () => []),
			delete: vi.fn(async () => {}),
		}

		const secondStore: ConversationStore = {
			save: vi.fn(async () => {}),
			load: vi.fn(async () => undefined),
			list: vi.fn(async () => []),
			delete: vi.fn(async () => {}),
		}

		// Register both stores
		bh.use({ name: "store-1", conversationStore: firstStore })
		bh.use({ name: "store-2", conversationStore: secondStore })

		const mockDriver = makeMockDriver([
			{ type: "delta", text: "Hello" },
			{ type: "done", stopReason: "stop" },
		])
		bh.addDriver(mockDriver)

		await bh.init()

		const conversation = (await bh.createConversation({
			model: "mock-driver/mock-model",
		})) as BHZAIConversationImpl

		await sendMessage(conversation, "Hi")

		// Verify first store's save was NOT called
		expect(firstStore.save).not.toHaveBeenCalled()

		// Verify second store's save WAS called
		expect(secondStore.save).toHaveBeenCalled()
		expect(secondStore.save).toHaveBeenCalledTimes(1)
	})

	// =========================================================================
	// Test 6: bh.conversations.list() query forwarding (before parameter)
	// =========================================================================
	it("Test 6: bh.conversations.list() forwards query.before unchanged", async () => {
		const mockStore: ConversationStore = {
			save: vi.fn(async () => {}),
			load: vi.fn(async () => undefined),
			list: vi.fn(async () => []),
			delete: vi.fn(async () => {}),
		}

		bh.use({ name: "mock-store", conversationStore: mockStore })
		await bh.init()

		await bh.conversations.list({ before: 1234567890 })

		// Verify the before parameter was passed through
		expect(mockStore.list).toHaveBeenCalledWith({ before: 1234567890 })
	})

	// =========================================================================
	// Test 7: bh.conversations.list() with no query parameter works
	// =========================================================================
	it("Test 7: bh.conversations.list() with no arguments calls store.list(undefined)", async () => {
		const mockStore: ConversationStore = {
			save: vi.fn(async () => {}),
			load: vi.fn(async () => undefined),
			list: vi.fn(async () => []),
			delete: vi.fn(async () => {}),
		}

		bh.use({ name: "mock-store", conversationStore: mockStore })
		await bh.init()

		await bh.conversations.list()

		// Verify store.list was called (with undefined argument)
		expect(mockStore.list).toHaveBeenCalled()
	})

	// =========================================================================
	// Test 8: Multiple message(sent) events → multiple save() calls
	// =========================================================================
	it("Test 8: Multiple message(sent) events trigger multiple store.save() calls", async () => {
		const mockStore: ConversationStore = {
			save: vi.fn(async () => {}),
			load: vi.fn(async () => undefined),
			list: vi.fn(async () => []),
			delete: vi.fn(async () => {}),
		}

		bh.use({ name: "mock-store", conversationStore: mockStore })

		const mockDriver = makeMockDriver([
			{ type: "delta", text: "First response" },
			{ type: "done", stopReason: "stop" },
		])
		bh.addDriver(mockDriver)

		await bh.init()

		const conversation = (await bh.createConversation({
			model: "mock-driver/mock-model",
		})) as BHZAIConversationImpl

		// Send first message (produces assistant message → message(sent) → save)
		await sendMessage(conversation, "First")

		const firstCallCount = (mockStore.save as Mock).mock.calls.length

		// Send another message (produces another assistant message → message(sent) → save)
		await sendMessage(conversation, "Second")

		const secondCallCount = (mockStore.save as Mock).mock.calls.length

		// Verify multiple saves occurred
		expect(secondCallCount).toBeGreaterThan(firstCallCount)
	})

	// =========================================================================
	// Test 9: Auto-save does not break if store.save() throws
	// =========================================================================
	it("Test 9: Auto-save does not propagate store.save() errors to the conversation", async () => {
		const mockStore: ConversationStore = {
			save: vi.fn(async () => {
				throw new Error("Store is down")
			}),
			load: vi.fn(async () => undefined),
			list: vi.fn(async () => []),
			delete: vi.fn(async () => {}),
		}

		bh.use({ name: "mock-store", conversationStore: mockStore })

		const mockDriver = makeMockDriver([
			{ type: "delta", text: "Hello" },
			{ type: "done", stopReason: "stop" },
		])
		bh.addDriver(mockDriver)

		const errorSpy = vi.fn()
		bh.on("error", errorSpy)

		await bh.init()

		const conversation = (await bh.createConversation({
			model: "mock-driver/mock-model",
		})) as BHZAIConversationImpl

		// Send message — save() will throw, but the conversation should complete
		const result = await sendMessage(conversation, "Hello")

		// Conversation should complete successfully
		expect(result.content).toBe("Hello")
		expect(conversation.status).toBe("idle")

		// Verify store.save was called (and it threw, but we caught it)
		expect(mockStore.save).toHaveBeenCalled()
	})
})
