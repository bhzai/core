/** @file Tests for the open message-field contract (accessors over message.meta). */

import { describe, expect, it } from "vitest"
import type { BHZAIMessage } from "../types/message.js"
import { BHZAI } from "./bhzai.js"
import { MessageFieldRegistry, applyMessageFields } from "./message-fields.js"

/** A bare message object, standing in for one built by the conversation layer. */
function plainMessage(meta: Record<string, unknown> = {}): BHZAIMessage {
	return {
		id: "m1",
		role: "assistant",
		content: "hi",
		blocks: [{ type: "text", text: "hi" }],
		time: 0,
		meta,
		append() {},
		setContent() {},
	}
}

describe("MessageFieldRegistry", () => {
	it("installs an accessor that reads and writes the backing meta key", () => {
		const registry = new MessageFieldRegistry()
		registry.define("think")
		const message = registry.applyTo(plainMessage())

		expect(message.think).toBeUndefined()

		message.think = "reasoning"
		expect(message.think).toBe("reasoning")
		// The value lives in `meta` — that is what makes it serializable.
		expect(message.meta.think).toBe("reasoning")

		// Writes straight to `meta` are visible through the accessor.
		message.meta.think = "rewritten"
		expect(message.think).toBe("rewritten")
	})

	it("reads a pre-existing meta value through a field defined afterwards", () => {
		const registry = new MessageFieldRegistry()
		registry.define("think")
		const message = registry.applyTo(plainMessage({ think: "restored" }))

		expect(message.think).toBe("restored")
	})

	it("honors metaKey and default overrides", () => {
		const registry = new MessageFieldRegistry()
		registry.define("sentiment", { metaKey: "acme:sentiment", default: "neutral" })
		const message = registry.applyTo(plainMessage()) as BHZAIMessage & { sentiment?: string }

		expect(message.sentiment).toBe("neutral")

		message.sentiment = "positive"
		expect(message.meta["acme:sentiment"]).toBe("positive")
		expect(message.meta.sentiment).toBeUndefined()
		expect(message.sentiment).toBe("positive")
	})

	it("keeps accessors non-enumerable so they stay out of serialization", () => {
		const registry = new MessageFieldRegistry()
		registry.define("think")
		const message = registry.applyTo(plainMessage())
		message.think = "secret-reasoning"

		expect(Object.keys(message)).not.toContain("think")

		// `think` must not appear as a top-level key of the serialized message —
		// the value rides along inside `meta`, which already round-trips.
		const serialized = JSON.parse(JSON.stringify(message)) as Record<string, unknown>
		expect(serialized.think).toBeUndefined()
		expect((serialized.meta as Record<string, unknown>).think).toBe("secret-reasoning")
	})

	it("rejects reserved BHZAIMessage member names", () => {
		const registry = new MessageFieldRegistry()
		for (const reserved of ["id", "role", "content", "blocks", "time", "meta", "append"]) {
			expect(() => registry.define(reserved)).toThrow(/reserved BHZAIMessage member/)
		}
	})

	it("rejects a duplicate field name", () => {
		const registry = new MessageFieldRegistry()
		registry.define("think")
		expect(() => registry.define("think")).toThrow(/already defined/)
	})

	it("rejects an empty field name", () => {
		const registry = new MessageFieldRegistry()
		expect(() => registry.define("")).toThrow(/non-empty string/)
	})

	it("lists fields in registration order", () => {
		const registry = new MessageFieldRegistry()
		registry.define("a")
		registry.define("b", { metaKey: "bb" })

		expect(registry.list().map((f) => f.name)).toEqual(["a", "b"])
		expect(registry.list().map((f) => f.metaKey)).toEqual(["a", "bb"])
		expect(registry.has("a")).toBe(true)
		expect(registry.has("nope")).toBe(false)
	})

	it("applyMessageFields re-installs a captured field list on a copy", () => {
		const registry = new MessageFieldRegistry()
		registry.define("think")
		const message = registry.applyTo(plainMessage())
		message.think = "kept"

		// A bare spread drops non-enumerable accessors...
		const bareCopy = { ...message }
		expect(Object.getOwnPropertyDescriptor(bareCopy, "think")).toBeUndefined()

		// ...and re-applying restores them over the shared `meta`.
		const restored = applyMessageFields(bareCopy, registry.list())
		expect(restored.think).toBe("kept")
	})
})

describe("bh.defineMessageField", () => {
	it("registers the built-in think field on every instance", () => {
		const bh = new BHZAI()
		expect(bh._getMessageFields().has("think")).toBe(true)
		// So a second registration by a plugin is rejected rather than silently
		// hijacking the built-in's storage.
		expect(() => bh.defineMessageField("think")).toThrow(/already defined/)
	})

	it("exposes a plugin-declared field on messages the kernel builds", () => {
		const bh = new BHZAI()
		bh.defineMessageField("sentiment", { default: "neutral" })

		const message = bh._getMessageFields().applyTo(plainMessage()) as BHZAIMessage & {
			sentiment?: string
		}
		expect(message.sentiment).toBe("neutral")
		message.sentiment = "positive"
		expect(message.meta.sentiment).toBe("positive")
	})

	it("refuses registration after dispose()", async () => {
		const bh = new BHZAI()
		await bh.init()
		await bh.dispose()
		expect(() => bh.defineMessageField("late")).toThrow(/disposed/)
	})
})
