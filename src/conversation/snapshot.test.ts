/** @file Tests for TASK_0028: Conversation serialization contract (snapshots, versioning, round-tripping) */

import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Mock } from "vitest"
import { BHZAI } from "../core/bhzai.js"
import type { ChatRequest, DriverEvent } from "../types/driver.js"
import { sendMessage } from "./agent-loop.js"
import type { BHZAIConversationImpl } from "./conversation.js"
import {
	type ConversationSnapshot,
	type PlainMessage,
	fromSnapshot,
	toSnapshot,
} from "./snapshot.js"
import { ensureStarted } from "./system-prompt.js"

/**
 * Mock driver factory for scripted test responses.
 */
function makeMockDriver(scriptedEvents: DriverEvent[]) {
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
			for (const event of scriptedEvents) {
				yield event
			}
		}),
		embed: undefined,
	}
}

describe("TASK_0028: Conversation serialization contract", () => {
	let bh: BHZAI

	beforeEach(() => {
		bh = new BHZAI()
	})

	// =========================================================================
	// Test 1: Round-trip a real scripted conversation through toJSON/loadConversation
	// =========================================================================
	it("round-trips a scripted conversation: send message, toJSON(), loadConversation() preserves state", async () => {
		// Register a mock driver
		const mockDriver = makeMockDriver([
			{ type: "delta", text: "Hello " },
			{ type: "delta", text: "world" },
			{ type: "done", stopReason: "stop" },
		])
		bh.addDriver(mockDriver)

		// Create conversation and send a user message
		const conv1 = (await bh.createConversation({
			model: "mock-driver-id/mock-model",
		})) as BHZAIConversationImpl

		const userMsg = await sendMessage(conv1, "Tell me something")
		expect(conv1.messages).toHaveLength(2) // user + assistant
		expect(userMsg.content).toContain("Hello world")

		// Serialize to snapshot
		const snapshot = conv1.toJSON()
		expect(snapshot.v).toBe(1)
		expect(snapshot.id).toBe(conv1.id)
		expect(snapshot.messages).toHaveLength(2)
		expect(snapshot.model).toBe("mock-driver-id/mock-model")

		// Load from snapshot
		const conv2 = (await bh.loadConversation(snapshot)) as BHZAIConversationImpl

		// Assert deep equality of relevant fields
		expect(conv2.id).toBe(conv1.id)
		expect(conv2.messages).toHaveLength(conv1.messages.length)
		expect(conv2._getModelRef()).toBe(conv1._getModelRef())
		expect(conv2.usage).toEqual(conv1.usage)
		expect(conv2.meta).toEqual(conv1.meta)

		// Verify messages are deep-equal (data fields, not reference-equal)
		for (let i = 0; i < conv1.messages.length; i++) {
			const m1 = conv1.messages[i]
			const m2 = conv2.messages[i]
			expect(m2.id).toBe(m1.id)
			expect(m2.role).toBe(m1.role)
			expect(m2.content).toBe(m1.content)
			expect(m2.blocks).toEqual(m1.blocks)
			expect(m2.time).toBe(m1.time)
			expect(m2.meta).toEqual(m1.meta)
		}
	})

	// =========================================================================
	// Test 2: Load a manually-truncated snapshot (sliced to first message)
	// =========================================================================
	it("loads a truncated snapshot (sliced messages) successfully", async () => {
		// Register a mock driver
		const mockDriver = makeMockDriver([
			{ type: "delta", text: "Response 1" },
			{ type: "done", stopReason: "stop" },
		])
		bh.addDriver(mockDriver)

		// Create conversation with multiple messages
		const conv1 = (await bh.createConversation({
			model: "mock-driver-id/mock-model",
		})) as BHZAIConversationImpl

		await sendMessage(conv1, "Message 1")
		// Simulate additional messages by adding them directly (for test purposes)
		const snapshot = conv1.toJSON()

		// Truncate the snapshot to just the first message
		const truncatedSnapshot: ConversationSnapshot = {
			...snapshot,
			messages: snapshot.messages.slice(0, 1),
		}

		// Load the truncated snapshot
		const conv2 = (await bh.loadConversation(truncatedSnapshot)) as BHZAIConversationImpl

		// Assert it loaded with exactly the truncated length
		expect(conv2.messages).toHaveLength(1)
		// Compare data fields only (not methods), since reloaded messages have methods attached
		const reloadedMsg = conv2.messages[0]
		const originalMsg = snapshot.messages[0]
		expect(reloadedMsg.id).toBe(originalMsg.id)
		expect(reloadedMsg.role).toBe(originalMsg.role)
		expect(reloadedMsg.content).toBe(originalMsg.content)
		expect(reloadedMsg.blocks).toEqual(originalMsg.blocks)
		expect(reloadedMsg.time).toBe(originalMsg.time)
		expect(reloadedMsg.meta).toEqual(originalMsg.meta)
		expect(conv2.id).toBe(conv1.id)
	})

	// =========================================================================
	// Test 3: Version mismatch (v: 999) throws "unsupported|version" error
	// =========================================================================
	it("throws with unsupported version error when v !== 1", async () => {
		const badSnapshot = {
			v: 999,
			id: "test-id",
			messages: [],
			model: "test/model",
			usage: { inputTokens: 0, outputTokens: 0 },
			meta: {},
		}

		// Expect loadConversation to throw matching /unsupported|version/i
		await expect(bh.loadConversation(badSnapshot)).rejects.toThrow(/unsupported|version/i)
	})

	// =========================================================================
	// Test 4a: Unregistered model triggers model.resolve with substitute handler
	// =========================================================================
	it("fires model.resolve when snapshot model is unregistered, accepts substitute from handler", async () => {
		// Create a snapshot with an unregistered model
		const badSnapshot: ConversationSnapshot = {
			v: 1,
			id: "test-conv-id",
			messages: [],
			model: "nonexistent-driver/nonexistent-model",
			usage: { inputTokens: 0, outputTokens: 0 },
			meta: {},
		}

		// Register a model.resolve handler that supplies a substitute
		const resolveHandler = vi.fn(async (payload: unknown) => {
			const p = payload as { catalogue: unknown[]; conversation: unknown }
			// Return a patch with a valid model
			return { model: "mock-driver-id/mock-model" }
		})
		bh.on("model.resolve", resolveHandler)

		// Register the mock driver
		const mockDriver = makeMockDriver([{ type: "done", stopReason: "stop" }])
		bh.addDriver(mockDriver)

		// Load the snapshot
		const conv = (await bh.loadConversation(badSnapshot)) as BHZAIConversationImpl

		// Assert model.resolve was fired
		expect(resolveHandler).toHaveBeenCalledTimes(1)

		// Assert the conversation has the substituted model
		expect(conv._getModelRef()).toBe("mock-driver-id/mock-model")
	})

	// =========================================================================
	// Test 4b: Unregistered model triggers model.resolve with no handler
	// =========================================================================
	it("fires model.resolve when snapshot model is unregistered, model stays undefined if no handler provides one", async () => {
		// Create a snapshot with an unregistered model
		const badSnapshot: ConversationSnapshot = {
			v: 1,
			id: "test-conv-id-2",
			messages: [],
			model: "nonexistent-driver/nonexistent-model",
			usage: { inputTokens: 0, outputTokens: 0 },
			meta: {},
		}

		// Register a model.resolve handler that does NOT supply a model
		const resolveHandler = vi.fn(async (_payload: unknown) => {
			// Return empty patch (no model)
			return {}
		})
		bh.on("model.resolve", resolveHandler)

		// Load the snapshot
		const conv = (await bh.loadConversation(badSnapshot)) as BHZAIConversationImpl

		// Assert model.resolve was fired
		expect(resolveHandler).toHaveBeenCalledTimes(1)

		// Assert the conversation's model is undefined (no handler provided one)
		expect(conv._getModelRef()).toBeUndefined()
	})

	// =========================================================================
	// Test 5: JSON round-trip proves plain-JSON-only (no functions/classes/Map/Set)
	// =========================================================================
	it("snapshot is pure JSON-serializable: JSON.parse(JSON.stringify()) deep-equals original", async () => {
		// Create a conversation with messages
		const mockDriver = makeMockDriver([
			{ type: "delta", text: "Test response" },
			{ type: "done", stopReason: "stop" },
		])
		bh.addDriver(mockDriver)

		const conv = (await bh.createConversation({
			model: "mock-driver-id/mock-model",
		})) as BHZAIConversationImpl

		await sendMessage(conv, "Test message")

		// Serialize to snapshot
		const originalSnapshot = conv.toJSON()

		// JSON round-trip: stringify and parse
		const jsonString = JSON.stringify(originalSnapshot)
		const reparsedSnapshot = JSON.parse(jsonString) as ConversationSnapshot

		// Deep-equal comparison
		expect(reparsedSnapshot).toEqual(originalSnapshot)

		// Additional verification: stringify of both must be identical
		expect(JSON.stringify(reparsedSnapshot)).toBe(jsonString)
	})

	// =========================================================================
	// Test 6: Loaded conversation never fires 'start' even when ensureStarted() is called
	// =========================================================================
	it("conversation loaded from snapshot never fires 'start' event, even when ensureStarted() is invoked", async () => {
		// Create a snapshot
		const mockDriver = makeMockDriver([
			{ type: "delta", text: "Response" },
			{ type: "done", stopReason: "stop" },
		])
		bh.addDriver(mockDriver)

		const conv1 = (await bh.createConversation({
			model: "mock-driver-id/mock-model",
		})) as BHZAIConversationImpl

		await sendMessage(conv1, "Initial message")
		const snapshot = conv1.toJSON()

		// Load from snapshot
		const conv2 = (await bh.loadConversation(snapshot)) as BHZAIConversationImpl

		// Register a spy on the 'start' event
		const startSpy = vi.fn()
		conv2.on("start", startSpy)

		// Invoke ensureStarted() explicitly
		await ensureStarted(conv2, bh, {}, undefined)

		// Assert 'start' was never fired
		expect(startSpy).not.toHaveBeenCalled()
	})

	// =========================================================================
	// Test 7: Reloaded messages throw when append/setContent is called
	// =========================================================================
	it("messages from a loaded snapshot throw when append() or setContent() is called", async () => {
		// Create and serialize a conversation
		const mockDriver = makeMockDriver([
			{ type: "delta", text: "Response" },
			{ type: "done", stopReason: "stop" },
		])
		bh.addDriver(mockDriver)

		const conv1 = (await bh.createConversation({
			model: "mock-driver-id/mock-model",
		})) as BHZAIConversationImpl

		await sendMessage(conv1, "Test")
		const snapshot = conv1.toJSON()

		// Load from snapshot
		const conv2 = (await bh.loadConversation(snapshot)) as BHZAIConversationImpl

		// Get a message from the loaded conversation
		const reloadedMsg = conv2.messages[0]

		// Assert that calling append() throws
		expect(() => reloadedMsg.append(" more text")).toThrow(/cannot mutate a reloaded/)

		// Assert that calling setContent() throws
		expect(() => reloadedMsg.setContent("new content")).toThrow(/cannot mutate a reloaded/)
	})

	// =========================================================================
	// Test 8: Empty snapshot (no messages) loads successfully
	// =========================================================================
	it("loads successfully with empty messages array", async () => {
		const emptySnapshot: ConversationSnapshot = {
			v: 1,
			id: "empty-conv",
			messages: [],
			model: "mock-driver-id/mock-model",
			usage: { inputTokens: 0, outputTokens: 0 },
			meta: { title: "Empty" },
		}

		const conv = (await bh.loadConversation(emptySnapshot)) as BHZAIConversationImpl

		expect(conv.id).toBe("empty-conv")
		expect(conv.messages).toHaveLength(0)
		expect(conv.meta).toEqual({ title: "Empty" })
	})

	// =========================================================================
	// Test 9: Snapshot preserves and restores meta and usage
	// =========================================================================
	it("preserves and restores meta and usage through serialization", async () => {
		// Create a conversation with custom metadata and usage
		const mockDriver = makeMockDriver([
			{ type: "delta", text: "Hi" },
			{ type: "done", stopReason: "stop" },
		])
		bh.addDriver(mockDriver)

		const conv1 = (await bh.createConversation({
			model: "mock-driver-id/mock-model",
		})) as BHZAIConversationImpl

		// Manually set metadata
		await conv1.setMeta({ title: "Test Conversation", customFlag: true })

		await sendMessage(conv1, "Test message")

		// Serialize
		const snapshot = conv1.toJSON()

		// Verify snapshot has the metadata
		expect(snapshot.meta).toEqual({ title: "Test Conversation", customFlag: true })
		expect(snapshot.usage.inputTokens).toBeGreaterThanOrEqual(0)
		expect(snapshot.usage.outputTokens).toBeGreaterThanOrEqual(0)

		// Load and verify
		const conv2 = (await bh.loadConversation(snapshot)) as BHZAIConversationImpl

		expect(conv2.meta).toEqual({ title: "Test Conversation", customFlag: true })
		expect(conv2.usage).toEqual(snapshot.usage)
	})

	// =========================================================================
	// Test 10: Handles snapshot with empty meta field gracefully
	// =========================================================================
	it("loads snapshot with empty meta field", async () => {
		const snapshot: ConversationSnapshot = {
			v: 1,
			id: "test-id",
			messages: [],
			model: "",
			usage: { inputTokens: 5, outputTokens: 10 },
			meta: {},
		}

		const conv = (await bh.loadConversation(snapshot)) as BHZAIConversationImpl

		expect(conv.meta).toEqual({})
		expect(conv.usage).toEqual({ inputTokens: 5, outputTokens: 10 })
	})

	// =========================================================================
	// Test 11: toPlainMessage strips methods and preserves data
	// =========================================================================
	it("toPlainMessage correctly strips methods while preserving all data fields", async () => {
		// Create a conversation to get a real message with methods
		const mockDriver = makeMockDriver([
			{ type: "delta", text: "Response" },
			{ type: "done", stopReason: "stop" },
		])
		bh.addDriver(mockDriver)

		const conv = (await bh.createConversation({
			model: "mock-driver-id/mock-model",
		})) as BHZAIConversationImpl

		await sendMessage(conv, "Test")

		const msg = conv.messages[0]

		// Verify the live message has methods
		expect(typeof msg.append).toBe("function")
		expect(typeof msg.setContent).toBe("function")

		// Convert to plain message
		const { toPlainMessage } = await import("./snapshot.js")
		const plain = toPlainMessage(msg)

		// Verify plain message has data fields
		expect(plain.id).toBe(msg.id)
		expect(plain.role).toBe(msg.role)
		expect(plain.content).toBe(msg.content)
		expect(plain.blocks).toEqual(msg.blocks)
		expect(plain.time).toBe(msg.time)
		expect(plain.meta).toEqual(msg.meta)

		// Verify plain message has no methods
		expect((plain as unknown as { append?: unknown }).append).toBeUndefined()
		expect((plain as unknown as { setContent?: unknown }).setContent).toBeUndefined()
	})

	// =========================================================================
	// Test 12: Invalid snapshot shapes throw appropriate errors
	// =========================================================================
	it("throws on invalid snapshot shape (missing id)", async () => {
		const badSnapshot = {
			v: 1,
			// missing id
			messages: [],
			model: "test/model",
			usage: { inputTokens: 0, outputTokens: 0 },
			meta: {},
		}

		await expect(bh.loadConversation(badSnapshot)).rejects.toThrow(/id.*must be a non-empty string/)
	})

	it("throws on invalid snapshot shape (messages not array)", async () => {
		const badSnapshot = {
			v: 1,
			id: "test-id",
			messages: "not an array", // Invalid
			model: "test/model",
			usage: { inputTokens: 0, outputTokens: 0 },
			meta: {},
		}

		await expect(bh.loadConversation(badSnapshot)).rejects.toThrow(/messages.*must be an array/)
	})

	it("throws on invalid snapshot shape (malformed message in array)", async () => {
		const badSnapshot = {
			v: 1,
			id: "test-id",
			messages: [
				{
					// Missing required 'id' field
					role: "user",
					content: "test",
					blocks: [],
					time: Date.now(),
					meta: {},
				},
			],
			model: "test/model",
			usage: { inputTokens: 0, outputTokens: 0 },
			meta: {},
		}

		await expect(bh.loadConversation(badSnapshot)).rejects.toThrow(
			/message\[0\].*does not match PlainMessage shape/,
		)
	})
})
