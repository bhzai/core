/** @file Tests for the prompt-compaction module. */

import { describe, expect, it, vi } from "vitest"
import type { BHZAIMessage } from "../types/message.js"
import type { BHZAIConversationImpl } from "./conversation.js"
import { compactPrompt, runPromptCompaction } from "./prompt-compaction.js"

/** Create a minimal message for testing. */
function makeMessage(content: string): BHZAIMessage {
	return {
		id: `msg-${Math.random().toString(36).slice(2)}`,
		role: "user",
		content,
		blocks: [{ type: "text", text: content }],
		time: Date.now(),
		meta: {},
		append: () => {
			throw new Error("append not supported in test")
		},
		setContent: () => {
			throw new Error("setContent not supported in test")
		},
	}
}

/** Create a mock conversation that mocks bh.complete(). */
function makeMockConversation(completeResult: string): BHZAIConversationImpl {
	const completeMock = vi.fn().mockResolvedValue({ text: completeResult })
	const conversation = {
		_getBh: () => ({ complete: completeMock }),
		_getCreateOptions: () => ({ compaction: { auto: false, reserveTokens: 100 } }),
		_dispatchConversationEvent: vi.fn().mockResolvedValue({ patch: undefined }),
	} as unknown as BHZAIConversationImpl
	return conversation
}

describe("runPromptCompaction", () => {
	it("summarizes a large message via bh.complete()", async () => {
		// Content large enough to need compaction but small enough for one chunk
		// availableTokens=50 → chunkBudget=25 tokens → 100 chars per chunk
		// 200 chars → 2 chunks → 2 summaries concatenated
		const content = "x".repeat(200)
		const message = makeMessage(content)
		const conversation = makeMockConversation("Summarized")

		const result = await runPromptCompaction(conversation, message, 50)
		expect(result).toBeDefined()
		expect(result).toContain("Summarized")
	})

	it("returns undefined when bh.complete() fails", async () => {
		const content = "x".repeat(1000)
		const message = makeMessage(content)
		const completeMock = vi.fn().mockRejectedValue(new Error("API error"))
		const conversation = {
			_getBh: () => ({ complete: completeMock }),
			_getCreateOptions: () => ({ compaction: { auto: false, reserveTokens: 100 } }),
			_dispatchConversationEvent: vi.fn().mockResolvedValue({ patch: undefined }),
		} as unknown as BHZAIConversationImpl

		const result = await runPromptCompaction(conversation, message, 50)
		expect(result).toBeUndefined()
	})

	it("returns undefined for empty content", async () => {
		const message = makeMessage("")
		const conversation = makeMockConversation("summary")

		const result = await runPromptCompaction(conversation, message, 50)
		expect(result).toBeUndefined()
	})

	it("splits multi-paragraph content into chunks", async () => {
		// Create content with multiple paragraphs
		const para1 = `First paragraph. ${"x".repeat(200)}`
		const para2 = `Second paragraph. ${"x".repeat(200)}`
		const para3 = `Third paragraph. ${"x".repeat(200)}`
		const content = `${para1}\n\n${para2}\n\n${para3}`
		const message = makeMessage(content)

		let callCount = 0
		const completeMock = vi.fn().mockImplementation(() => {
			callCount++
			return Promise.resolve({ text: `Summary ${callCount}` })
		})
		const conversation = {
			_getBh: () => ({ complete: completeMock }),
			_getCreateOptions: () => ({ compaction: { auto: false, reserveTokens: 100 } }),
			_dispatchConversationEvent: vi.fn().mockResolvedValue({ patch: undefined }),
		} as unknown as BHZAIConversationImpl

		// availableTokens=200 → chunkBudget=100 tokens → 400 chars per chunk
		// Each paragraph is ~218 chars → fits in one chunk → 3 chunks total
		const result = await runPromptCompaction(conversation, message, 200)
		expect(result).toBeDefined()
		// Should have made 3 complete() calls (one per paragraph chunk)
		expect(completeMock).toHaveBeenCalledTimes(3)
		expect(result).toContain("Summary 1")
		expect(result).toContain("Summary 2")
		expect(result).toContain("Summary 3")
	})

	it("passes compaction.model to bh.complete()", async () => {
		const content = "x".repeat(200)
		const message = makeMessage(content)
		const completeMock = vi.fn().mockResolvedValue({ text: "Summary" })
		const conversation = {
			_getBh: () => ({ complete: completeMock }),
			_getCreateOptions: () => ({
				compaction: { auto: false, reserveTokens: 100, model: "openai/gpt-4o-mini" },
			}),
			_dispatchConversationEvent: vi.fn().mockResolvedValue({ patch: undefined }),
		} as unknown as BHZAIConversationImpl

		await runPromptCompaction(conversation, message, 50)
		expect(completeMock).toHaveBeenCalledWith(
			expect.objectContaining({ model: "openai/gpt-4o-mini" }),
		)
	})
})

describe("compactPrompt", () => {
	it("uses plugin-provided summary when handled", async () => {
		const message = makeMessage("x".repeat(1000))
		const completeMock = vi.fn()
		const conversation = {
			_getBh: () => ({ complete: completeMock }),
			_getCreateOptions: () => ({ compaction: { auto: false, reserveTokens: 100 } }),
			_dispatchConversationEvent: vi.fn().mockResolvedValue({
				patch: { summary: "Plugin summary", handled: true },
			}),
		} as unknown as BHZAIConversationImpl

		const result = await compactPrompt(conversation, message, 250, 50)
		expect(result).toBeDefined()
		expect(result?.content).toBe("Plugin summary")
		expect(result?.meta.promptCompactionSummary).toBe(true)
		expect(result?.meta.originalContent).toBe(message.content)
		// bh.complete() should NOT have been called (plugin handled it)
		expect(completeMock).not.toHaveBeenCalled()
	})

	it("falls back to core default when plugin does not handle", async () => {
		const message = makeMessage("x".repeat(200))
		const completeMock = vi.fn().mockResolvedValue({ text: "Core summary" })
		const conversation = {
			_getBh: () => ({ complete: completeMock }),
			_getCreateOptions: () => ({ compaction: { auto: false, reserveTokens: 100 } }),
			_dispatchConversationEvent: vi.fn().mockResolvedValue({ patch: undefined }),
		} as unknown as BHZAIConversationImpl

		const result = await compactPrompt(conversation, message, 250, 50)
		expect(result).toBeDefined()
		expect(result?.content).toContain("Core summary")
		expect(completeMock).toHaveBeenCalled()
	})

	it("returns undefined when compaction fails", async () => {
		const message = makeMessage("")
		const conversation = makeMockConversation("summary")

		const result = await compactPrompt(conversation, message, 0, 50)
		expect(result).toBeUndefined()
	})
})
