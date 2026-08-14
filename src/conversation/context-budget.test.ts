/** @file Tests for the pre-flight context-budget module. */

import { describe, expect, it } from "vitest"
import type { ToolWireDefinition } from "../types/driver.js"
import type { BHZAIMessage } from "../types/message.js"
import {
	estimateMessageTokens,
	estimateSystemPromptTokens,
	estimateToolTokens,
	fitContextToWindow,
} from "./context-budget.js"

/** Create a minimal message for testing. */
function makeMessage(role: BHZAIMessage["role"], content: string): BHZAIMessage {
	return {
		id: `msg-${Math.random().toString(36).slice(2)}`,
		role,
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

/** Create a tool definition for testing. */
function makeTool(name: string, description: string): ToolWireDefinition {
	return {
		name,
		description,
		inputSchema: { type: "object", properties: {} },
	}
}

describe("estimateMessageTokens", () => {
	it("returns at least 1 token for any message", () => {
		const msg = makeMessage("user", "")
		expect(estimateMessageTokens(msg)).toBeGreaterThanOrEqual(1)
	})

	it("estimates ~4 chars per token", () => {
		// 40 chars → ~10 tokens
		const msg = makeMessage("user", "a".repeat(40))
		expect(estimateMessageTokens(msg)).toBe(10)
	})

	it("counts meta.toolCalls when present", () => {
		const msg = makeMessage("assistant", "ok")
		msg.meta.toolCalls = [{ id: "call-1", name: "search", arguments: '{"q":"test query here"}' }]
		// The toolCalls JSON adds characters beyond the content
		const baseTokens = estimateMessageTokens(makeMessage("assistant", "ok"))
		const withToolCalls = estimateMessageTokens(msg)
		expect(withToolCalls).toBeGreaterThan(baseTokens)
	})
})

describe("estimateSystemPromptTokens", () => {
	it("returns 0 for empty string", () => {
		expect(estimateSystemPromptTokens("")).toBe(0)
	})

	it("estimates ~4 chars per token", () => {
		// 100 chars → 25 tokens
		expect(estimateSystemPromptTokens("a".repeat(100))).toBe(25)
	})
})

describe("estimateToolTokens", () => {
	it("returns 0 for empty array", () => {
		expect(estimateToolTokens([])).toBe(0)
	})

	it("counts tool name + description + schema + overhead", () => {
		const tool = makeTool("search", "Search the web for information")
		const tokens = estimateToolTokens([tool])
		// Should include name + description + schema chars / 4 + 10 overhead
		expect(tokens).toBeGreaterThan(10) // at least the overhead
	})
})

describe("fitContextToWindow", () => {
	it("returns all messages when they fit (first turn, heuristic)", () => {
		const messages = [makeMessage("user", "Hello world")]
		const result = fitContextToWindow({
			messages,
			systemPrompt: "You are helpful.",
			tools: [],
			contextWindow: 1000,
			outputReserve: 100,
			lastInputTokens: undefined,
		})
		expect(result.trimmed).toBe(false)
		expect(result.overLimit).toBe(false)
		expect(result.messages).toHaveLength(1)
	})

	it("trims oldest messages when over budget", () => {
		// Create 10 messages, each ~40 chars (10 tokens)
		const messages: BHZAIMessage[] = []
		for (let i = 0; i < 10; i++) {
			messages.push(makeMessage("user", `Message ${i}: ${"x".repeat(30)}`))
		}
		// Last message is the "current" user message
		// With contextWindow=100, outputReserve=20, systemPrompt=0, tools=0
		// Available for messages = 80 tokens
		// 10 messages × ~10 tokens = ~100 tokens → needs trimming
		const result = fitContextToWindow({
			messages,
			systemPrompt: "",
			tools: [],
			contextWindow: 100,
			outputReserve: 20,
			lastInputTokens: undefined,
		})
		expect(result.trimmed).toBe(true)
		expect(result.overLimit).toBe(false)
		// The last user message must be preserved
		expect(result.messages).toContain(messages[messages.length - 1])
		expect(result.messages.length).toBeLessThan(messages.length)
	})

	it("preserves the most recent user message even when trimming", () => {
		const messages = [
			makeMessage("user", `old message 1 ${"x".repeat(40)}`),
			makeMessage("assistant", `response 1 ${"x".repeat(40)}`),
			makeMessage("user", `old message 2 ${"x".repeat(40)}`),
			makeMessage("assistant", `response 2 ${"x".repeat(40)}`),
			makeMessage("user", `current message ${"x".repeat(40)}`),
		]
		const result = fitContextToWindow({
			messages,
			systemPrompt: "",
			tools: [],
			contextWindow: 50,
			outputReserve: 10,
			lastInputTokens: undefined,
		})
		// The last user message must always be in the result
		expect(result.messages).toContain(messages[4])
	})

	it("sets overLimit when even the last user message + system prompt exceed the window", () => {
		const messages = [makeMessage("user", "x".repeat(500))] // ~125 tokens
		const result = fitContextToWindow({
			messages,
			systemPrompt: "y".repeat(100), // ~25 tokens
			tools: [],
			contextWindow: 50,
			outputReserve: 10,
			lastInputTokens: undefined,
		})
		expect(result.overLimit).toBe(true)
	})

	it("sets overLimit when system prompt + tools alone exceed the budget", () => {
		const messages = [makeMessage("user", "hi")]
		const result = fitContextToWindow({
			messages,
			systemPrompt: "x".repeat(500),
			tools: [],
			contextWindow: 50,
			outputReserve: 10,
			lastInputTokens: undefined,
		})
		expect(result.overLimit).toBe(true)
	})

	it("uses lastInputTokens as base when available", () => {
		// lastInputTokens = 200 (real count from last turn)
		// Current messages heuristic = ~10 tokens (one short message)
		// systemPrompt = 0, tools = 0
		// estimatedTotal = max(200, 10) = 200
		// 200 + 50 (outputReserve) = 250 <= 1000 → fits
		const messages = [makeMessage("user", "new message")]
		const result = fitContextToWindow({
			messages,
			systemPrompt: "",
			tools: [],
			contextWindow: 1000,
			outputReserve: 50,
			lastInputTokens: 200,
		})
		expect(result.trimmed).toBe(false)
		expect(result.overLimit).toBe(false)
		expect(result.estimatedTokens).toBeGreaterThanOrEqual(200)
	})

	it("subtracts outputReserve from the available budget", () => {
		// 100 tokens of messages, contextWindow=100, outputReserve=50
		// Available = 100 - 50 = 50 → messages must be trimmed to ~50 tokens
		const messages: BHZAIMessage[] = []
		for (let i = 0; i < 10; i++) {
			messages.push(makeMessage("user", "x".repeat(36))) // ~9 tokens each
		}
		const result = fitContextToWindow({
			messages,
			systemPrompt: "",
			tools: [],
			contextWindow: 100,
			outputReserve: 50,
			lastInputTokens: undefined,
		})
		expect(result.trimmed).toBe(true)
		// Estimated tokens + outputReserve should fit within contextWindow
		expect(result.estimatedTokens + 50).toBeLessThanOrEqual(100)
	})

	it("counts tools in the budget", () => {
		const messages = [makeMessage("user", "hi")]
		const tools = [makeTool("very_long_tool_name_that_takes_many_tokens", "x".repeat(200))]
		const result = fitContextToWindow({
			messages,
			systemPrompt: "",
			tools,
			contextWindow: 50,
			outputReserve: 10,
			lastInputTokens: undefined,
		})
		// Tools alone should exceed the small window
		expect(result.overLimit).toBe(true)
	})

	it("returns all messages when contextWindow is large enough", () => {
		const messages = [
			makeMessage("user", "first"),
			makeMessage("assistant", "second"),
			makeMessage("user", "third"),
		]
		const result = fitContextToWindow({
			messages,
			systemPrompt: "system",
			tools: [makeTool("tool", "desc")],
			contextWindow: 10000,
			outputReserve: 1000,
			lastInputTokens: undefined,
		})
		expect(result.trimmed).toBe(false)
		expect(result.overLimit).toBe(false)
		expect(result.messages).toHaveLength(3)
	})

	it("handles messages with no user role when over budget", () => {
		const messages = [makeMessage("assistant", "x".repeat(100))] // ~25 tokens
		const result = fitContextToWindow({
			messages,
			systemPrompt: "",
			tools: [],
			contextWindow: 5,
			outputReserve: 1,
			lastInputTokens: undefined,
		})
		// No user message to preserve → overLimit when over budget
		expect(result.overLimit).toBe(true)
	})
})
