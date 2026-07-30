/** @file Tests for the canonical BHZAIMessage factory and message-field propagation. */

import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Mock } from "vitest"
import { BHZAI } from "../core/bhzai.js"
import { MessageFieldRegistry } from "../core/message-fields.js"
import type { BHZAIDriver, ChatRequest, DriverEvent } from "../types/driver.js"
import { sendMessage } from "./agent-loop.js"
import type { BHZAIConversationImpl } from "./conversation.js"
import { createMessage, withMessageFields } from "./message.js"

function makeMockDriver(
	scriptedEvents: DriverEvent[],
): BHZAIDriver & { chat: Mock<(request: ChatRequest) => AsyncIterable<DriverEvent>> } {
	return {
		id: "mock-driver-id",
		listModels: async () => [
			{
				ref: "mock-driver-id/mock-model",
				id: "mock-model",
				driver: "mock-driver-id",
				availability: "ready" as const,
				capabilities: { toolCalls: true, streaming: true, reasoning: false },
			},
		],
		capabilities: () => ({ toolCalls: true, streaming: true, reasoning: false }),
		chat: vi.fn(async function* (_request: ChatRequest) {
			for (const event of scriptedEvents) {
				yield event
			}
		}),
		embed: undefined,
	}
}

describe("createMessage", () => {
	it("derives blocks from a string content", () => {
		const message = createMessage({ role: "user", content: "hello" })
		expect(message.content).toBe("hello")
		expect(message.blocks).toEqual([{ type: "text", text: "hello" }])
		expect(message.id).toBeTruthy()
		expect(typeof message.time).toBe("number")
	})

	it("derives the content string from text blocks, ignoring non-text blocks", () => {
		const message = createMessage({
			role: "user",
			content: [
				{ type: "text", text: "a" },
				{ type: "image", data: "xxx", mimeType: "image/png" },
				{ type: "text", text: "b" },
			],
		})
		expect(message.content).toBe("ab")
		expect(message.blocks).toHaveLength(3)
	})

	it("preserves an explicit blocks override without re-deriving content", () => {
		// The snapshot-restore path: both views are already known and persisted.
		const message = createMessage({
			role: "assistant",
			content: "persisted-content",
			blocks: [{ type: "image", data: "xxx", mimeType: "image/png" }],
		})
		expect(message.content).toBe("persisted-content")
		expect(message.blocks).toEqual([{ type: "image", data: "xxx", mimeType: "image/png" }])
	})

	it("copies seed meta rather than aliasing it", () => {
		const seed = { contextIncluded: false }
		const message = createMessage({ role: "system", content: "x", meta: seed })
		message.meta.extra = 1
		expect(seed).toEqual({ contextIncluded: false })
	})

	it("appends to the last block when it is text", () => {
		const message = createMessage({ role: "assistant", content: "a" })
		message.append("b")
		expect(message.content).toBe("ab")
		expect(message.blocks).toEqual([{ type: "text", text: "ab" }])
	})

	it("appends a new text block when the last block is not text", () => {
		// The former agent-loop factory appended to the last *text* block anywhere
		// in the array, which put new text before a trailing non-text block.
		const message = createMessage({
			role: "assistant",
			content: [
				{ type: "text", text: "a" },
				{ type: "image", data: "xxx", mimeType: "image/png" },
			],
		})
		message.append("b")
		expect(message.blocks).toHaveLength(3)
		expect(message.blocks[2]).toEqual({ type: "text", text: "b" })
		expect(message.content).toBe("ab")
	})

	it("setContent accepts both a string and blocks", () => {
		const message = createMessage({ role: "assistant", content: "a" })

		message.setContent("b")
		expect(message.content).toBe("b")
		expect(message.blocks).toEqual([{ type: "text", text: "b" }])

		message.setContent([{ type: "text", text: "c" }])
		expect(message.content).toBe("c")
		expect(message.blocks).toEqual([{ type: "text", text: "c" }])
	})

	it("throws from both mutators when built immutable", () => {
		const message = createMessage({ role: "system", content: "x" }, undefined, {
			mutable: false,
		})
		expect(() => message.append("y")).toThrow(/cannot mutate a reloaded\/finalized message/)
		expect(() => message.setContent("y")).toThrow(/cannot mutate a reloaded\/finalized message/)
	})

	it("uses a custom frozen reason, substituting the method name", () => {
		const message = createMessage({ role: "system", content: "x" }, undefined, {
			mutable: false,
			frozenReason: "{method}() is not supported on compaction summary messages",
		})
		expect(() => message.append("y")).toThrow(
			"append() is not supported on compaction summary messages",
		)
		expect(() => message.setContent("y")).toThrow(
			"setContent() is not supported on compaction summary messages",
		)
	})

	it("installs registered message fields", () => {
		const registry = new MessageFieldRegistry()
		registry.define("think")
		const message = createMessage({ role: "assistant", content: "" }, registry)

		message.think = "reasoning"
		expect(message.meta.think).toBe("reasoning")
	})
})

describe("withMessageFields", () => {
	it("applies a patch while retaining the field accessors", () => {
		const registry = new MessageFieldRegistry()
		registry.define("think")
		const message = createMessage({ role: "user", content: "a" }, registry)
		message.think = "kept"

		const patched = withMessageFields(message, { content: "b" }, registry)

		expect(patched.content).toBe("b")
		expect(patched.think).toBe("kept")

		// A bare spread would have lost the accessor entirely.
		expect(Object.getOwnPropertyDescriptor({ ...message }, "think")).toBeUndefined()
	})
})

describe("message fields reach every construction site", () => {
	let bh: BHZAI

	beforeEach(() => {
		bh = new BHZAI()
		bh.addDriver(
			makeMockDriver([
				{ type: "delta", text: "hello" },
				{ type: "done", stopReason: "stop" },
			]),
		)
		bh.defineMessageField("tag", { default: "none" })
	})

	it("agent-loop user and assistant messages carry fields", async () => {
		const conversation = (await bh.createConversation({
			model: "mock-driver-id/mock-model",
		})) as BHZAIConversationImpl

		const assistant = await sendMessage(conversation, "hi")
		const [user] = conversation.messages

		for (const message of [user, assistant] as Array<
			(typeof conversation.messages)[number] & { tag?: string }
		>) {
			expect(message.tag).toBe("none")
			message.tag = "set"
			expect(message.meta.tag).toBe("set")
		}
	})

	it("the message(before) patch copy retains fields", async () => {
		const conversation = (await bh.createConversation({
			model: "mock-driver-id/mock-model",
		})) as BHZAIConversationImpl

		// A handler patches the message; the loop spreads it to apply the patch.
		conversation.on("message", (payload) => {
			const p = payload as { state: string }
			if (p.state === "before") {
				return { content: "patched" }
			}
			return undefined
		})

		await sendMessage(conversation, "hi")
		const stored = conversation.messages[0] as (typeof conversation.messages)[number] & {
			tag?: string
		}

		expect(stored.content).toBe("patched")
		// Without withMessageFields this accessor is gone and `tag` reads undefined.
		expect(stored.tag).toBe("none")
		stored.tag = "still-works"
		expect(stored.meta.tag).toBe("still-works")
	})

	it("a blocked message retains fields", async () => {
		const conversation = (await bh.createConversation({
			model: "mock-driver-id/mock-model",
		})) as BHZAIConversationImpl

		conversation.on("message", (payload) => {
			const p = payload as { state: string }
			if (p.state === "before") {
				return { block: true, reason: "nope" }
			}
			return undefined
		})

		const blocked = (await sendMessage(conversation, "hi")) as { tag?: string; meta: object }
		expect(blocked.meta).toMatchObject({ blocked: true, blockedReason: "nope" })
		expect(blocked.tag).toBe("none")
	})

	it("messages restored from a snapshot carry fields over persisted meta", async () => {
		const conversation = (await bh.createConversation({
			model: "mock-driver-id/mock-model",
		})) as BHZAIConversationImpl

		await sendMessage(conversation, "hi")
		const live = conversation.messages[0] as (typeof conversation.messages)[number] & {
			tag?: string
		}
		live.tag = "persisted"

		const reloaded = (await bh.loadConversation(conversation.toJSON())) as BHZAIConversationImpl
		const restored = reloaded.messages[0] as (typeof reloaded.messages)[number] & { tag?: string }

		expect(restored.tag).toBe("persisted")
		// Still immutable after reload.
		expect(() => restored.append("x")).toThrow(/cannot mutate a reloaded/)
	})

	it("prepended start-event messages carry fields", async () => {
		bh.on("conversation.start", () => ({
			prepend: [{ role: "system" as const, content: "preamble" }],
		}))

		const conversation = (await bh.createConversation({
			model: "mock-driver-id/mock-model",
		})) as BHZAIConversationImpl
		await sendMessage(conversation, "hi")

		const preamble = conversation.messages.find((m) => m.content === "preamble") as
			| ((typeof conversation.messages)[number] & { tag?: string })
			| undefined

		expect(preamble).toBeDefined()
		expect(preamble?.tag).toBe("none")
	})
})
