/** @file Tests for CreateConversationOptions.parseThink — <think> splitting in the agent loop. */

import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Mock } from "vitest"
import { BHZAI } from "../core/bhzai.js"
import type { BHZAIDriver, ChatRequest, DriverEvent } from "../types/driver.js"
import { sendMessage } from "./agent-loop.js"
import type { BHZAIConversationImpl } from "./conversation.js"

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
				capabilities: { toolCalls: true, streaming: true, reasoning: true },
			},
		],
		capabilities: () => ({ toolCalls: true, streaming: true, reasoning: true }),
		chat: vi.fn(async function* (_request: ChatRequest) {
			for (const event of scriptedEvents) {
				yield event
			}
		}),
		embed: undefined,
	}
}

/** Build a BHZAI whose driver streams `chunks` as text deltas, then stops. */
function bhStreaming(chunks: string[]): BHZAI {
	const bh = new BHZAI()
	bh.addDriver(
		makeMockDriver([
			...chunks.map((text) => ({ type: "delta" as const, text })),
			{ type: "done" as const, stopReason: "stop" },
		]),
	)
	return bh
}

/** Collect every `message.delta` payload fired on a conversation. */
function recordDeltas(conversation: BHZAIConversationImpl): Array<{ kind: string; delta: string }> {
	const seen: Array<{ kind: string; delta: string }> = []
	conversation.on("message.delta", (payload) => {
		const p = payload as { kind: string; delta: string }
		seen.push({ kind: p.kind, delta: p.delta })
	})
	return seen
}

describe("parseThink", () => {
	describe("enabled", () => {
		let bh: BHZAI

		beforeEach(() => {
			bh = bhStreaming(["<think>reasoning</think>answer"])
		})

		it("routes think content to message.think and keeps it out of the body", async () => {
			const conversation = (await bh.createConversation({
				model: "mock-driver-id/mock-model",
				parseThink: true,
			})) as BHZAIConversationImpl

			const assistant = await sendMessage(conversation, "hi")

			expect(assistant.think).toBe("reasoning")
			expect(assistant.content).toBe("answer")
			expect(assistant.content).not.toContain("<think>")
			// Stored on the message's meta bag, which is what persists.
			expect(assistant.meta.think).toBe("reasoning")
		})

		it("dispatches reasoning and text on their own message.delta channels", async () => {
			const conversation = (await bh.createConversation({
				model: "mock-driver-id/mock-model",
				parseThink: true,
			})) as BHZAIConversationImpl
			const deltas = recordDeltas(conversation)

			await sendMessage(conversation, "hi")

			expect(deltas).toEqual([
				{ kind: "reasoning", delta: "reasoning" },
				{ kind: "text", delta: "answer" },
			])
		})

		it("never dispatches an empty delta", async () => {
			// Each tag arrives on its own chunk, so several pushes yield nothing.
			const conversation = (await bhStreaming(["<think>", "a", "</think>", "b"]).createConversation(
				{
					model: "mock-driver-id/mock-model",
					parseThink: true,
				},
			)) as BHZAIConversationImpl
			const deltas = recordDeltas(conversation)

			await sendMessage(conversation, "hi")

			expect(deltas.every((d) => d.delta.length > 0)).toBe(true)
			expect(deltas).toEqual([
				{ kind: "reasoning", delta: "a" },
				{ kind: "text", delta: "b" },
			])
		})

		it("handles tags split across chunk boundaries", async () => {
			const conversation = (await bhStreaming([
				"<thi",
				"nk>rea",
				"soning</thin",
				"k>ans",
				"wer",
			]).createConversation({
				model: "mock-driver-id/mock-model",
				parseThink: true,
			})) as BHZAIConversationImpl

			const assistant = await sendMessage(conversation, "hi")

			expect(assistant.think).toBe("reasoning")
			expect(assistant.content).toBe("answer")
		})

		it("handles several think blocks in one turn", async () => {
			const conversation = (await bhStreaming([
				"<think>one</think>A<think>two</think>B",
			]).createConversation({
				model: "mock-driver-id/mock-model",
				parseThink: true,
			})) as BHZAIConversationImpl

			const assistant = await sendMessage(conversation, "hi")

			expect(assistant.think).toBe("onetwo")
			expect(assistant.content).toBe("AB")
		})

		it("leaves plain output untouched when no tags are present", async () => {
			const conversation = (await bhStreaming(["just ", "text"]).createConversation({
				model: "mock-driver-id/mock-model",
				parseThink: true,
			})) as BHZAIConversationImpl

			const assistant = await sendMessage(conversation, "hi")

			expect(assistant.content).toBe("just text")
			expect(assistant.think).toBeUndefined()
		})

		it("does not leak a think block across turns", async () => {
			// An unterminated block in turn 1 must not swallow turn 2's answer.
			const bh2 = new BHZAI()
			let turn = 0
			bh2.addDriver({
				id: "mock-driver-id",
				listModels: async () => [
					{
						ref: "mock-driver-id/mock-model",
						id: "mock-model",
						driver: "mock-driver-id",
						availability: "ready" as const,
						capabilities: { toolCalls: true, streaming: true, reasoning: true },
					},
				],
				capabilities: () => ({ toolCalls: true, streaming: true, reasoning: true }),
				chat: async function* (_request: ChatRequest) {
					turn += 1
					yield turn === 1
						? { type: "delta" as const, text: "<think>never closed" }
						: { type: "delta" as const, text: "second answer" }
					yield { type: "done" as const, stopReason: "stop" }
				},
				embed: undefined,
			})

			const conversation = (await bh2.createConversation({
				model: "mock-driver-id/mock-model",
				parseThink: true,
			})) as BHZAIConversationImpl

			const first = await sendMessage(conversation, "one")
			expect(first.think).toBe("never closed")
			expect(first.content).toBe("")

			const second = await sendMessage(conversation, "two")
			expect(second.content).toBe("second answer")
			expect(second.think).toBeUndefined()
		})

		it("preserves message.think across a snapshot round-trip", async () => {
			const conversation = (await bh.createConversation({
				model: "mock-driver-id/mock-model",
				parseThink: true,
			})) as BHZAIConversationImpl

			await sendMessage(conversation, "hi")

			const reloaded = (await bh.loadConversation(conversation.toJSON())) as BHZAIConversationImpl
			const assistant = reloaded.messages.find((m) => m.role === "assistant")

			expect(assistant?.think).toBe("reasoning")
			expect(assistant?.content).toBe("answer")
		})

		it("leaves a driver's native reasoning-delta channel on meta.reasoning", async () => {
			const bh2 = new BHZAI()
			bh2.addDriver(
				makeMockDriver([
					{ type: "reasoning-delta", text: "native" },
					{ type: "delta", text: "answer" },
					{ type: "done", stopReason: "stop" },
				]),
			)
			const conversation = (await bh2.createConversation({
				model: "mock-driver-id/mock-model",
				parseThink: true,
			})) as BHZAIConversationImpl

			const assistant = await sendMessage(conversation, "hi")

			expect(assistant.meta.reasoning).toBe("native")
			expect(assistant.think).toBeUndefined()
			expect(assistant.content).toBe("answer")
		})
	})

	describe("disabled (default)", () => {
		it("passes <think> tags straight through into the message body", async () => {
			const conversation = (await bhStreaming([
				"<think>reasoning</think>answer",
			]).createConversation({
				model: "mock-driver-id/mock-model",
			})) as BHZAIConversationImpl
			const deltas = recordDeltas(conversation)

			const assistant = await sendMessage(conversation, "hi")

			expect(assistant.content).toBe("<think>reasoning</think>answer")
			expect(assistant.think).toBeUndefined()
			expect(deltas).toEqual([{ kind: "text", delta: "<think>reasoning</think>answer" }])
		})

		it("is off when parseThink is explicitly false", async () => {
			const conversation = (await bhStreaming(["<think>x</think>y"]).createConversation({
				model: "mock-driver-id/mock-model",
				parseThink: false,
			})) as BHZAIConversationImpl

			const assistant = await sendMessage(conversation, "hi")
			expect(assistant.content).toBe("<think>x</think>y")
		})
	})
})
