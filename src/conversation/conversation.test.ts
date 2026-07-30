/** @file Tests for TASK_0023: Conversation surface skeleton */

import { beforeEach, describe, expect, it, vi } from "vitest"
import { BHZAI } from "../core/bhzai.js"
import { EventBus } from "../core/event-bus.js"
import { NoModelError } from "../core/models.js"
import {
	type BHZAIConversation,
	BHZAIConversationImpl,
	type ConversationSnapshot,
} from "./conversation.js"

/**
 * Test suite for BHZAIConversation and conversation event mirroring (TASK_0023).
 *
 * All 8 test cases from TASK_0023's "Tests Required" section are included below,
 * plus edge cases for UUID validity and complete acceptance criteria verification.
 */
describe("TASK_0023: Conversation surface skeleton", () => {
	let bh: BHZAI

	beforeEach(() => {
		bh = new BHZAI()
	})

	// =========================================================================
	// Test 1: createConversation() with explicit model does NOT trigger model.resolve
	// =========================================================================
	it("createConversation() with explicit model does NOT trigger model.resolve", async () => {
		const modelResolveSpy = vi.fn()
		bh.on("model.resolve", modelResolveSpy)

		const conversation = await bh.createConversation({
			model: "ollama/llama3.3",
		})

		expect(modelResolveSpy).not.toHaveBeenCalled()
		expect(conversation).toBeDefined()
	})

	// =========================================================================
	// Test 2: createConversation() with no model and no defaultModel DOES trigger model.resolve
	// =========================================================================
	it("createConversation() with no model and no defaultModel DOES trigger model.resolve", async () => {
		const modelResolveSpy = vi.fn()
		bh.on("model.resolve", modelResolveSpy)

		// Create a fresh BHZAI with no defaultModel
		const bhNoDefault = new BHZAI()
		bhNoDefault.on("model.resolve", modelResolveSpy)

		const conversation = await bhNoDefault.createConversation()

		expect(modelResolveSpy).toHaveBeenCalledTimes(1)
		expect(modelResolveSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				conversation,
			}),
		)
		expect(conversation).toBeDefined()
	})

	// =========================================================================
	// Test 3: conversation.created fires on framework bus with correct payload
	// =========================================================================
	it("conversation.created fires on framework bus with correct reference-equal payload", async () => {
		const createdSpy = vi.fn()
		bh.on("conversation.created", createdSpy)

		const conversation = await bh.createConversation({ model: "test/model" })

		expect(createdSpy).toHaveBeenCalledTimes(1)
		const call = createdSpy.mock.calls[0]
		expect(call[0]).toEqual({ conversation })
		// Verify reference equality
		expect(call[0].conversation).toBe(conversation)
	})

	// =========================================================================
	// Test 4: loadConversation() fires conversation.loaded (NOT conversation.created)
	// =========================================================================
	it("loadConversation() fires conversation.loaded (not conversation.created)", async () => {
		const createdSpy = vi.fn()
		const loadedSpy = vi.fn()
		bh.on("conversation.created", createdSpy)
		bh.on("conversation.loaded", loadedSpy)

		const snapshot: ConversationSnapshot = {
			v: 1,
			id: "test-id-123",
			messages: [],
			meta: { title: "Test" },
			usage: { inputTokens: 10, outputTokens: 20 },
			model: "test/model",
		}

		const conversation = await bh.loadConversation(snapshot, {
			model: "test/model",
		})

		expect(createdSpy).not.toHaveBeenCalled()
		expect(loadedSpy).toHaveBeenCalledTimes(1)
		const call = loadedSpy.mock.calls[0]
		expect(call[0]).toEqual({ conversation, snapshot })
		// Verify snapshot is the exact object passed in
		expect(call[0].snapshot).toBe(snapshot)
	})

	// =========================================================================
	// Test 5: setMeta() shallow-merges and fires meta.changed with correct payload
	// =========================================================================
	it("setMeta() shallow-merges and fires meta.changed with correct patch", async () => {
		const conversation = await bh.createConversation({ model: "test/model" })

		const metaChangedSpy = vi.fn()
		conversation.on("meta.changed", metaChangedSpy)

		// First call: setMeta({ foo: 1 })
		await conversation.setMeta({ foo: 1 })

		expect(metaChangedSpy).toHaveBeenCalledTimes(1)
		let call = metaChangedSpy.mock.calls[0]
		expect(call[0]).toEqual({
			meta: { foo: 1 },
			patch: { foo: 1 },
		})
		expect(conversation.meta.foo).toBe(1)

		// Second call: setMeta({ bar: 2 })
		await conversation.setMeta({ bar: 2 })

		expect(metaChangedSpy).toHaveBeenCalledTimes(2)
		call = metaChangedSpy.mock.calls[1]
		expect(call[0]).toEqual({
			meta: { foo: 1, bar: 2 },
			patch: { bar: 2 },
		})
		// Verify both fields exist in meta
		expect(conversation.meta.foo).toBe(1)
		expect(conversation.meta.bar).toBe(2)
	})

	// =========================================================================
	// Test 6: Mirroring order and shared patch chain (critical)
	// =========================================================================
	it("mirroring: conversation handlers run first, framework handlers see their patches", async () => {
		const conversation = await bh.createConversation({ model: "test/model" })

		const order: string[] = []

		// Register conversation-scoped handler
		conversation.on("message", (payload) => {
			order.push("conv")
			return { tag: "from-h1" }
		})

		// Register framework-level handler
		bh.on("conversation.message", (payload) => {
			order.push("fw")
			// This handler should see the patch from the conversation handler
			expect(payload).toEqual(
				expect.objectContaining({
					tag: "from-h1",
				}),
			)
			return undefined
		})

		// Trigger a conversation-level message dispatch directly via the
		// internal dispatchConversationEvent mechanism
		// biome-ignore lint/suspicious/noExplicitAny: accessing internal method not in public interface
		const result = await (conversation as any).dispatchConversationEvent("message", {
			role: "user",
			content: "test",
		})

		expect(order).toEqual(["conv", "fw"])
		// Verify the final patch includes the conversation handler's patch
		expect(result.patch).toEqual(
			expect.objectContaining({
				tag: "from-h1",
			}),
		)
	})

	// =========================================================================
	// Test 7: Custom namespaced events work correctly
	// =========================================================================
	it("conversation.emit() accepts namespaced custom events", async () => {
		const conversation = await bh.createConversation({ model: "test/model" })

		const customSpy = vi.fn()
		conversation.on("some-plugin.custom", customSpy)

		// Emit a namespaced custom event
		await conversation.emit("some-plugin.custom", {})

		expect(customSpy).toHaveBeenCalledTimes(1)
	})

	// =========================================================================
	// Test 8: UUID validity and uniqueness
	// =========================================================================
	it("conversation.id is a valid UUID v4 and unique across instances", async () => {
		const conv1 = await bh.createConversation({ model: "test/model" })
		const conv2 = await bh.createConversation({ model: "test/model" })

		// UUID v4 regex check
		const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
		expect(conv1.id).toMatch(uuidRegex)
		expect(conv2.id).toMatch(uuidRegex)

		// Uniqueness check
		expect(conv1.id).not.toBe(conv2.id)
	})

	// =========================================================================
	// Test 9: status is 'idle' after both createConversation and loadConversation
	// =========================================================================
	it("conversation.status === 'idle' after createConversation", async () => {
		const conversation = await bh.createConversation({ model: "test/model" })
		expect(conversation.status).toBe("idle")
	})

	it("conversation.status === 'idle' after loadConversation", async () => {
		const snapshot: ConversationSnapshot = {
			v: 1,
			id: "test-id-456",
			messages: [],
			model: "test/model",
			usage: { inputTokens: 0, outputTokens: 0 },
			meta: {},
		}

		const conversation = await bh.loadConversation(snapshot, {
			model: "test/model",
		})

		expect(conversation.status).toBe("idle")
	})

	// =========================================================================
	// Additional tests for acceptance criteria and edge cases
	// =========================================================================

	it("conversation.messages returns a read-only (frozen) copy", async () => {
		const conversation = await bh.createConversation({ model: "test/model" })

		const messages = conversation.messages
		expect(Object.isFrozen(messages)).toBe(true)

		// Attempting to mutate should throw or fail silently (frozen object)
		expect(() => {
			// biome-ignore lint/suspicious/noExplicitAny: testing frozen array behavior
			;(messages as any).push({ id: "test" })
		}).toThrow()
	})

	it("conversation.meta returns a read-only snapshot", async () => {
		const conversation = await bh.createConversation({ model: "test/model" })
		await conversation.setMeta({ foo: "bar" })

		const meta = conversation.meta
		expect(Object.isFrozen(meta)).toBe(true)
		expect(meta.foo).toBe("bar")
	})

	it("conversation.usage returns a snapshot of token counts", async () => {
		const snapshot: ConversationSnapshot = {
			v: 1,
			id: "test-id-789",
			messages: [],
			usage: { inputTokens: 100, outputTokens: 200 },
			model: "test/model",
			meta: {},
		}

		const conversation = await bh.loadConversation(snapshot, {
			model: "test/model",
		})

		expect(conversation.usage).toEqual({
			inputTokens: 100,
			outputTokens: 200,
		})
	})

	it("loadConversation throws on invalid snapshot shape", async () => {
		await expect(bh.loadConversation({ id: 123 })).rejects.toThrow() // id should be string

		await expect(
			bh.loadConversation({
				id: "test-id",
				// missing messages array
			}),
		).rejects.toThrow()
	})

	it("abort() sets status to 'aborted'", async () => {
		const conversation = await bh.createConversation({ model: "test/model" })

		expect(conversation.status).toBe("idle")
		conversation.abort("test abort")
		expect(conversation.status).toBe("aborted")
	})

	it("waitForIdle() resolves immediately (stub behavior for this task)", async () => {
		const conversation = await bh.createConversation({ model: "test/model" })

		const promise = conversation.waitForIdle()
		expect(promise).toBeInstanceOf(Promise)

		await expect(promise).resolves.toBeUndefined()
	})

	// sendMessage and addMessage are now implemented by TASK_0025.
	// Tests for them are in agent-loop.test.ts.

	it("setModel() throws with TODO message", async () => {
		const conversation = await bh.createConversation({ model: "test/model" })

		expect(() => {
			conversation.setModel("other/model")
		}).toThrow(/not implemented — see TASK_0025/)
	})

	it("compact() delegates to the real bh.complete() (TASK_0032) and surfaces NoModelError when no model is resolvable", async () => {
		const conversation = await bh.createConversation({ model: "test/model" })

		// Add a message so there's something to compact
		await conversation.addMessage("Test message", "user")

		// compact() without a completeFn override calls bh.complete() (now fully implemented in TASK_0032).
		// Since no driver is registered and no defaultModel is set on this BHZAI instance,
		// bh.complete() will throw NoModelError when trying to resolve a model.
		// This verifies that compact() properly delegates and propagates real errors from bh.complete().
		await expect(conversation.compact()).rejects.toBeInstanceOf(NoModelError)
	})

	it("toJSON() returns a snapshot-like object", async () => {
		const conversation = await bh.createConversation({ model: "test/model" })
		await conversation.setMeta({ title: "Test" })

		const json = conversation.toJSON()
		expect(json.id).toBe(conversation.id)
		expect(json.messages).toEqual([])
		expect(json.meta).toEqual({ title: "Test" })
		expect(json.usage).toEqual({ inputTokens: 0, outputTokens: 0 })
	})

	it("createConversation with defaultModel does NOT trigger model.resolve", async () => {
		const bhWithDefault = new BHZAI({
			defaultModel: "default/model",
		})
		const modelResolveSpy = vi.fn()
		bhWithDefault.on("model.resolve", modelResolveSpy)

		const conversation = await bhWithDefault.createConversation()

		expect(modelResolveSpy).not.toHaveBeenCalled()
	})

	it("model.resolve patch is applied to conversation", async () => {
		const bh2 = new BHZAI()
		bh2.on("model.resolve", (payload) => {
			return { model: "resolved/model" }
		})

		const conversation = await bh2.createConversation()

		// The model should have been set from the patch
		const json = conversation.toJSON()
		expect(json.model).toBe("resolved/model")
	})

	it("framework bus receives mirrored events", async () => {
		const conversation = await bh.createConversation({ model: "test/model" })

		const frameworkMetaChangedSpy = vi.fn()
		bh.on("conversation.meta.changed", frameworkMetaChangedSpy)

		await conversation.setMeta({ title: "New Title" })

		expect(frameworkMetaChangedSpy).toHaveBeenCalledTimes(1)
		expect(frameworkMetaChangedSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				meta: { title: "New Title" },
			}),
		)
	})

	it("block signal from conversation handler stops framework mirror", async () => {
		const conversation = await bh.createConversation({ model: "test/model" })

		const order: string[] = []

		// Register conversation handler that blocks
		conversation.on("message", () => {
			order.push("conv")
			return { block: true, reason: "blocked-by-conv" }
		})

		// Register framework handler (should NOT run due to block)
		bh.on("conversation.message", () => {
			order.push("fw")
		})

		// biome-ignore lint/suspicious/noExplicitAny: accessing internal method not in public interface
		const result = await (conversation as any).dispatchConversationEvent(
			"message",
			{ role: "user", content: "test" },
			{ blockable: true },
		)

		// Framework handler should NOT have run
		expect(order).toEqual(["conv"])
		expect(result.blocked).toBe(true)
	})
})
