/**
 * @file Tests for TASK_0024 (system-prompt layering and start event) and for
 * the standalone fold-based `Conversation` system-prompt resolver.
 */

import { beforeEach, describe, expect, it, vi } from "vitest"
import { BHZAI } from "../core/bhzai.js"
import { BHZAIConversationImpl, type CreateConversationOptions } from "./conversation.js"
import {
	Conversation,
	type MessageInit,
	type PluginActivationSource,
	computePreContextSystemPrompt,
	ensureStarted,
} from "./system-prompt.js"

describe("TASK_0024: System-prompt layering and start event", () => {
	let bh: BHZAI

	beforeEach(() => {
		bh = new BHZAI()
	})

	// =========================================================================
	// Test 1: Calling ensureStarted twice fires start exactly once
	// =========================================================================
	it("ensureStarted fires start exactly once when called twice", async () => {
		const conversation = new BHZAIConversationImpl(bh)
		const startSpy = vi.fn()
		conversation.on("start", startSpy)

		// First call
		await ensureStarted(conversation, bh, {}, undefined)

		// Second call
		await ensureStarted(conversation, bh, {}, undefined)

		// Spy should have been called exactly once
		expect(startSpy).toHaveBeenCalledTimes(1)
	})

	// =========================================================================
	// Test 2: Two appendSystemPrompt handlers concatenate in order with blank line
	// =========================================================================
	it("two appendSystemPrompt handlers concatenate with blank-line separator", async () => {
		// Create a conversation with a base system prompt
		const bh2 = new BHZAI({ systemPrompt: "Base prompt" })
		const conversation = new BHZAIConversationImpl(bh2)

		// Register two handlers that append.
		// IMPORTANT: Handlers must read the incoming payload's already-accumulated
		// appendSystemPrompt value and append to it (the read-then-append idiom),
		// rather than blindly returning their own value. This is how multiple
		// handlers cooperatively contribute to an accumulating string field.
		conversation.on("start", () => ({
			appendSystemPrompt: "Fragment A",
		}))

		conversation.on("start", (payload) => {
			// Read the existing appendSystemPrompt (from previous handler) and append
			const existing = (payload as Record<string, unknown>).appendSystemPrompt ?? ""
			const toAppend = existing ? `${existing}\n\nFragment B` : "Fragment B"
			return { appendSystemPrompt: toAppend }
		})

		// Fire start
		await ensureStarted(conversation, bh, {}, undefined)

		// Verify the final prompt contains all parts with exact blank-line separator
		const finalPrompt = computePreContextSystemPrompt(conversation)
		expect(finalPrompt).toBe("Base prompt\n\nFragment A\n\nFragment B")
	})

	// =========================================================================
	// Test 3: systemPrompt handler replaces (not appends)
	// =========================================================================
	it("systemPrompt handler replaces the prompt outright", async () => {
		// Create conversation with a non-empty base prompt
		const bh2 = new BHZAI({ systemPrompt: "Original base prompt with many words" })
		const conversation = new BHZAIConversationImpl(bh2)

		// Register a handler that returns a replace
		conversation.on("start", () => ({
			systemPrompt: "Completely new prompt",
		}))

		// Fire start
		await ensureStarted(conversation, bh, {}, undefined)

		// Verify the prompt was completely replaced
		const finalPrompt = computePreContextSystemPrompt(conversation)
		expect(finalPrompt).toBe("Completely new prompt")

		// Verify the original prompt is NOT present as a substring
		expect(finalPrompt).not.toContain("Original base prompt")
	})

	// =========================================================================
	// Test 4: Two prepend handlers stack in registration order
	// =========================================================================
	it("two prepend handlers stack messages in registration order", async () => {
		const conversation = new BHZAIConversationImpl(bh)

		// Register two handlers that each prepend a message.
		// Handlers MUST read the incoming payload's prepend array and append to it
		// to support accumulation across multiple handlers (the read-then-append idiom).
		conversation.on("start", (payload) => ({
			prepend: [
				{
					role: "system" as const,
					content: "First system message",
				},
			],
		}))

		conversation.on("start", (payload) => ({
			prepend: [
				...(((payload as Record<string, unknown>).prepend as MessageInit[]) ?? []),
				{
					role: "assistant" as const,
					content: "Second assistant message",
				},
			],
		}))

		// Fire start with no first message
		await ensureStarted(conversation, bh, {}, undefined)

		// Verify the messages were prepended in order
		const messages = conversation.messages
		expect(messages.length).toBe(2)
		expect(messages[0].role).toBe("system")
		expect(messages[0].content).toBe("First system message")
		expect(messages[1].role).toBe("assistant")
		expect(messages[1].content).toBe("Second assistant message")
	})

	// =========================================================================
	// Test 5: loadConversation-produced conversation never fires start
	// =========================================================================
	it("loaded conversation never fires start even when ensureStarted is called", async () => {
		const snapshot = {
			v: 1,
			id: "test-conv-id",
			messages: [],
			model: "test/model",
			usage: { inputTokens: 0, outputTokens: 0 },
			meta: {},
		}

		// Load a conversation (this marks it as _started = true)
		const conversation = await bh.loadConversation(snapshot)

		const startSpy = vi.fn()
		conversation.on("start", startSpy)

		// Try to ensure it's started (should be a no-op)
		await ensureStarted(conversation as BHZAIConversationImpl, bh, {}, undefined)

		// Start should NOT have fired
		expect(startSpy).not.toHaveBeenCalled()
	})

	// =========================================================================
	// Test 6: contextIncluded: false is stored in meta
	// =========================================================================
	it("MessageInit with contextIncluded: false produces meta.contextIncluded === false", async () => {
		const conversation = new BHZAIConversationImpl(bh)

		// Register a handler that prepends a message with contextIncluded: false
		conversation.on("start", (payload) => ({
			prepend: [
				{
					role: "user" as const,
					content: "Display-only message",
					contextIncluded: false,
				},
			],
		}))

		// Fire start
		await ensureStarted(conversation, bh, {}, undefined)

		// Verify the message was stored with the convention
		const messages = conversation.messages
		expect(messages.length).toBe(1)
		expect(messages[0].meta.contextIncluded).toBe(false)
	})

	// =========================================================================
	// Test 7: appendSystemPrompt on empty base
	// =========================================================================
	it("appendSystemPrompt on empty base does not prepend a leading blank line", async () => {
		// Create conversation with empty base prompt
		const bh2 = new BHZAI({ systemPrompt: "" })
		const conversation = new BHZAIConversationImpl(bh2)

		conversation.on("start", () => ({
			appendSystemPrompt: "First fragment",
		}))

		await ensureStarted(conversation, bh, {}, undefined)

		const finalPrompt = computePreContextSystemPrompt(conversation)
		// Should NOT have a leading blank line
		expect(finalPrompt).toBe("First fragment")
		expect(finalPrompt).not.toMatch(/^\n/)
	})

	// =========================================================================
	// Test 8: Per-conversation systemPrompt override replaces host default
	// =========================================================================
	it("per-conversation systemPrompt overrides host default entirely", async () => {
		const hostDefault = "Host system prompt"
		const perConvOverride = "Per-conversation override"

		// Create with host default
		const bh2 = new BHZAI({ systemPrompt: hostDefault })
		const conversation = new BHZAIConversationImpl(bh2, {
			systemPrompt: perConvOverride,
		})

		// No handlers, just check the prompt
		await ensureStarted(conversation, bh, {}, undefined)

		const finalPrompt = computePreContextSystemPrompt(conversation)
		expect(finalPrompt).toBe(perConvOverride)
		expect(finalPrompt).not.toContain("Host system prompt")
	})

	// =========================================================================
	// Test 9: Empty host default + per-conversation override
	// =========================================================================
	it("per-conversation systemPrompt works with empty host default", async () => {
		const perConvOverride = "My conversation prompt"

		const bh2 = new BHZAI({ systemPrompt: "" })
		const conversation = new BHZAIConversationImpl(bh2, {
			systemPrompt: perConvOverride,
		})

		await ensureStarted(conversation, bh, {}, undefined)

		const finalPrompt = computePreContextSystemPrompt(conversation)
		expect(finalPrompt).toBe(perConvOverride)
	})

	// =========================================================================
	// Test 10: start event receives correct payload
	// =========================================================================
	it("start event payload contains conversation, options, and firstMessage", async () => {
		const conversation = new BHZAIConversationImpl(bh, {
			model: "test/model",
		})

		const startSpy = vi.fn()
		conversation.on("start", startSpy)

		const firstMessage = {
			id: "msg-1",
			role: "user" as const,
			time: Date.now(),
			content: "First message",
			blocks: [{ type: "text" as const, text: "First message" }],
			meta: {},
			append: vi.fn(),
			setContent: vi.fn(),
		}

		await ensureStarted(conversation, bh, { model: "test/model" }, firstMessage)

		expect(startSpy).toHaveBeenCalledTimes(1)
		const payload = startSpy.mock.calls[0][0]
		expect(payload.conversation).toBe(conversation)
		expect(payload.options).toEqual({ model: "test/model" })
		expect(payload.firstMessage).toBe(firstMessage)
	})

	// =========================================================================
	// Test 11: Prepended messages have proper structure
	// =========================================================================
	it("prepended messages have id, time, blocks, and meta fields", async () => {
		const conversation = new BHZAIConversationImpl(bh)

		conversation.on("start", () => ({
			prepend: [
				{
					role: "system" as const,
					content: "System preamble",
					meta: { source: "preamble" },
				},
			],
		}))

		await ensureStarted(conversation, bh, {}, undefined)

		const message = conversation.messages[0]
		expect(message.id).toBeDefined()
		expect(message.id).toMatch(/^[0-9a-f-]{36}$/) // UUID format
		expect(message.time).toBeGreaterThan(0)
		expect(message.blocks).toHaveLength(1)
		expect(message.blocks[0]).toEqual({
			type: "text",
			text: "System preamble",
		})
		expect(message.meta.source).toBe("preamble")
		expect(message.meta.contextIncluded).toBe(true)
	})

	// =========================================================================
	// Test 12: Prepended messages come before triggering message
	// =========================================================================
	it("prepended messages are inserted before firstMessage in history", async () => {
		const conversation = new BHZAIConversationImpl(bh)

		conversation.on("start", () => ({
			prepend: [
				{
					role: "system" as const,
					content: "Preamble",
				},
			],
		}))

		const firstMessage = {
			id: "user-msg-1",
			role: "user" as const,
			time: Date.now(),
			content: "User question",
			blocks: [{ type: "text" as const, text: "User question" }],
			meta: {},
			append: vi.fn(),
			setContent: vi.fn(),
		}

		await ensureStarted(conversation, bh, {}, firstMessage)

		// Manually insert the first message to simulate what sendMessage would do
		;(
			conversation as unknown as {
				_messages: (typeof firstMessage)[]
			}
		)._messages.push(firstMessage)

		const messages = conversation.messages
		expect(messages.length).toBe(2)
		expect(messages[0].content).toBe("Preamble")
		expect(messages[1].content).toBe("User question")
	})

	// =========================================================================
	// Test 13: systemPrompt after appendSystemPrompt replaces accumulated value
	// =========================================================================
	it("systemPrompt handler replaces accumulated appends", async () => {
		const hostDefault = "Host default"
		const bh2 = new BHZAI({ systemPrompt: hostDefault })
		const conversation = new BHZAIConversationImpl(bh2)

		conversation.on("start", () => ({
			appendSystemPrompt: "Appended fragment",
		}))

		conversation.on("start", () => ({
			systemPrompt: "Complete replacement",
		}))

		await ensureStarted(conversation, bh, {}, undefined)

		const finalPrompt = computePreContextSystemPrompt(conversation)
		expect(finalPrompt).toBe("Complete replacement")
		expect(finalPrompt).not.toContain("Host default")
		expect(finalPrompt).not.toContain("Appended fragment")
	})

	// =========================================================================
	// Test 14: Message content as ContentBlock array
	// =========================================================================
	it("MessageInit with ContentBlock[] content is handled correctly", async () => {
		const conversation = new BHZAIConversationImpl(bh)

		conversation.on("start", () => ({
			prepend: [
				{
					role: "system" as const,
					content: [
						{ type: "text" as const, text: "Multi-block " },
						{ type: "text" as const, text: "content" },
					],
				},
			],
		}))

		await ensureStarted(conversation, bh, {}, undefined)

		const message = conversation.messages[0]
		expect(message.content).toBe("Multi-block content")
		expect(message.blocks).toHaveLength(2)
	})

	// =========================================================================
	// Test 15: No patches returns unchanged prompt
	// =========================================================================
	it("no patches preserves layers 1-2 prompt unchanged", async () => {
		const hostDefault = "Host prompt"
		const bh2 = new BHZAI({ systemPrompt: hostDefault })
		const conversation = new BHZAIConversationImpl(bh2)

		// No handlers registered

		await ensureStarted(conversation, bh, {}, undefined)

		const finalPrompt = computePreContextSystemPrompt(conversation)
		expect(finalPrompt).toBe(hostDefault)
	})
})

describe("Conversation system-prompt resolution", () => {
	it("uses the base prompt when no handlers are registered", () => {
		const conversation = new Conversation("base")
		expect(conversation.systemPrompt).toBe("base")
	})

	it("a single handler can replace the system prompt", () => {
		const conversation = new Conversation("base")
		conversation.onStart(() => ({ systemPrompt: "X" }))
		expect(conversation.systemPrompt).toBe("X")
	})

	it("a single handler can append to the system prompt", () => {
		const conversation = new Conversation("base")
		conversation.onStart(() => ({ appendSystemPrompt: "Y" }))
		expect(conversation.systemPrompt).toBe("base\n\nY")
	})

	it("a single patch applies replace before append", () => {
		const conversation = new Conversation("base")
		conversation.onStart(() => ({ systemPrompt: "X", appendSystemPrompt: "Y" }))
		expect(conversation.systemPrompt).toBe("X\n\nY")
	})

	// The bug from issue #4: replace-then-append across two independent handlers.
	// A shallow-merged patch object would collapse to { systemPrompt: "X",
	// appendSystemPrompt: "Y" } and silently drop the append, yielding "X".
	it("replace handler then append handler chains to X\\n\\nY", () => {
		const conversation = new Conversation("base")
		conversation.onStart(() => ({ systemPrompt: "X" }))
		conversation.onStart(() => ({ appendSystemPrompt: "Y" }))
		expect(conversation.systemPrompt).toBe("X\n\nY")
	})

	// The reverse order: a later replace discards earlier accumulated appends.
	it("append handler then replace handler resolves to the replacement", () => {
		const conversation = new Conversation("base")
		conversation.onStart(() => ({ appendSystemPrompt: "Y" }))
		conversation.onStart(() => ({ systemPrompt: "X" }))
		expect(conversation.systemPrompt).toBe("X")
	})

	it("multiple append handlers accumulate in registration order", () => {
		const conversation = new Conversation("base")
		conversation.onStart(() => ({ appendSystemPrompt: "A" }))
		conversation.onStart(() => ({ appendSystemPrompt: "B" }))
		expect(conversation.systemPrompt).toBe("base\n\nA\n\nB")
	})

	it("a handler reads the running value left by the previous handler", () => {
		const conversation = new Conversation("base")
		const seen: string[] = []
		conversation.onStart(() => ({ systemPrompt: "X" }))
		conversation.onStart((current) => {
			seen.push(current.systemPrompt)
			return { appendSystemPrompt: "Y" }
		})
		expect(conversation.systemPrompt).toBe("X\n\nY")
		expect(seen).toEqual(["X"])
	})

	it("a handler returning nothing leaves the running value untouched", () => {
		const conversation = new Conversation("base")
		conversation.onStart(() => ({ systemPrompt: "X" }))
		conversation.onStart(() => undefined)
		expect(conversation.systemPrompt).toBe("X")
	})

	it("prepend lines accumulate with the latest handler at the front", () => {
		const conversation = new Conversation("base")
		conversation.onStart(() => ({ prepend: ["a"] }))
		conversation.onStart(() => ({ prepend: ["b"] }))
		expect(conversation.prepend).toEqual(["b", "a"])
	})

	it("prepend accumulates independently of system-prompt replacement", () => {
		const conversation = new Conversation("base")
		conversation.onStart(() => ({ prepend: ["a"], systemPrompt: "X" }))
		conversation.onStart(() => ({ prepend: ["b"], appendSystemPrompt: "Y" }))
		expect(conversation.systemPrompt).toBe("X\n\nY")
		expect(conversation.prepend).toEqual(["b", "a"])
	})

	it("resolution is cached and handlers run only once", () => {
		const conversation = new Conversation("base")
		let calls = 0
		conversation.onStart(() => {
			calls += 1
			return { appendSystemPrompt: "Y" }
		})
		expect(conversation.ensureStarted()).toBe(conversation.ensureStarted())
		expect(conversation.systemPrompt).toBe("base\n\nY")
		expect(calls).toBe(1)
	})
})

// ---------------------------------------------------------------------------
// Per-conversation plugin activation.
// ---------------------------------------------------------------------------

/**
 * Minimal stand-in for the kernel. `Conversation` depends on the structural
 * `PluginActivationSource` interface rather than on `BHZAI`, so the test can
 * supply the two methods directly instead of booting a kernel.
 */
function fakeKernel(disabled: string[] = [], names = ["alpha", "beta"]): PluginActivationSource {
	const off = new Set(disabled)
	return {
		isPluginEnabled: (name) => names.includes(name) && !off.has(name),
		listPlugins: () => names.map((name) => ({ name })),
	}
}

describe("Conversation plugin activation", () => {
	it("runs an owned handler when its plugin is globally enabled", () => {
		const conversation = new Conversation("base", { BHZAI: fakeKernel() })
		conversation.onStart(() => ({ appendSystemPrompt: "A" }), "alpha")
		expect(conversation.systemPrompt).toBe("base\n\nA")
	})

	it("skips an owned handler when its plugin is globally disabled", () => {
		const conversation = new Conversation("base", { BHZAI: fakeKernel(["alpha"]) })
		conversation.onStart(() => ({ appendSystemPrompt: "A" }), "alpha")
		expect(conversation.systemPrompt).toBe("base")
	})

	it("a conversation override can disable a globally-enabled plugin", () => {
		const conversation = new Conversation("base", { BHZAI: fakeKernel() })
		conversation.onStart(() => ({ appendSystemPrompt: "A" }), "alpha")
		conversation.disablePlugin("alpha")
		expect(conversation.systemPrompt).toBe("base")
	})

	it("a conversation override can enable a globally-disabled plugin", () => {
		const conversation = new Conversation("base", { BHZAI: fakeKernel(["alpha"]) })
		conversation.onStart(() => ({ appendSystemPrompt: "A" }), "alpha")
		conversation.enablePlugin("alpha")
		expect(conversation.systemPrompt).toBe("base\n\nA")
	})

	it("overrides are per conversation, not shared", () => {
		const kernel = fakeKernel()
		const a = new Conversation("base", { BHZAI: kernel })
		const b = new Conversation("base", { BHZAI: kernel })
		a.onStart(() => ({ appendSystemPrompt: "A" }), "alpha")
		b.onStart(() => ({ appendSystemPrompt: "A" }), "alpha")
		a.disablePlugin("alpha")
		expect(a.systemPrompt).toBe("base")
		expect(b.systemPrompt).toBe("base\n\nA")
	})

	it("resetPlugin returns an overridden plugin to inheriting the global state", () => {
		const conversation = new Conversation("base", { BHZAI: fakeKernel(["alpha"]) })
		conversation.enablePlugin("alpha")
		expect(conversation.isPluginEnabled("alpha")).toBe(true)
		conversation.resetPlugin("alpha")
		expect(conversation.isPluginEnabled("alpha")).toBe(false)
	})

	it("unowned handlers always run, whatever is disabled", () => {
		const conversation = new Conversation("base", { BHZAI: fakeKernel(["alpha"]) })
		conversation.disablePlugin("beta")
		conversation.onStart(() => ({ appendSystemPrompt: "H" }))
		expect(conversation.systemPrompt).toBe("base\n\nH")
	})

	it("a skipped handler leaves the running value untouched for the next handler", () => {
		const conversation = new Conversation("base", { BHZAI: fakeKernel(["alpha"]) })
		conversation.onStart(() => ({ systemPrompt: "REPLACED" }), "alpha")
		conversation.onStart(() => ({ appendSystemPrompt: "B" }), "beta")
		expect(conversation.systemPrompt).toBe("base\n\nB")
	})

	it("toggling after the conversation has started does not change the resolved prompt", () => {
		const conversation = new Conversation("base", { BHZAI: fakeKernel() })
		conversation.onStart(() => ({ appendSystemPrompt: "A" }), "alpha")
		expect(conversation.systemPrompt).toBe("base\n\nA")
		conversation.disablePlugin("alpha")
		expect(conversation.systemPrompt).toBe("base\n\nA")
	})

	it("restart() re-resolves against the current activation state", () => {
		const conversation = new Conversation("base", { BHZAI: fakeKernel() })
		conversation.onStart(() => ({ appendSystemPrompt: "A" }), "alpha")
		expect(conversation.systemPrompt).toBe("base\n\nA")
		conversation.disablePlugin("alpha")
		conversation.restart()
		expect(conversation.systemPrompt).toBe("base")
		conversation.enablePlugin("alpha")
		conversation.restart()
		expect(conversation.systemPrompt).toBe("base\n\nA")
	})

	it("listPlugins reports global state, override and effective state", () => {
		const conversation = new Conversation("base", { BHZAI: fakeKernel(["beta"]) })
		conversation.disablePlugin("alpha")
		expect(conversation.listPlugins()).toEqual([
			{ name: "alpha", globalEnabled: true, override: false, effective: false },
			{ name: "beta", globalEnabled: false, override: undefined, effective: false },
		])
	})

	it("a conversation with no kernel gates nothing and lists nothing", () => {
		const conversation = new Conversation("base")
		conversation.onStart(() => ({ appendSystemPrompt: "A" }), "alpha")
		expect(conversation.systemPrompt).toBe("base\n\nA")
		expect(conversation.isPluginEnabled("alpha")).toBe(true)
		expect(conversation.listPlugins()).toEqual([])
	})

	it("a conversation with no kernel still honors its own overrides", () => {
		const conversation = new Conversation("base")
		conversation.disablePlugin("alpha")
		conversation.onStart(() => ({ appendSystemPrompt: "A" }), "alpha")
		expect(conversation.systemPrompt).toBe("base")
	})

	it("the activation methods return this for chaining", () => {
		const conversation = new Conversation("base")
		expect(conversation.disablePlugin("a")).toBe(conversation)
		expect(conversation.enablePlugin("a")).toBe(conversation)
		expect(conversation.resetPlugin("a")).toBe(conversation)
	})
})
