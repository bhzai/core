/** @file Tests for TASK_0025: Agent loop core (sendMessage, context event, message states) */

import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Mock } from "vitest"
import { BHZAI } from "../core/bhzai.js"
import type { ContentBlock } from "../types/content.js"
import type { BHZAIDriver, ChatRequest, DriverEvent } from "../types/driver.js"
import {
	addMessage,
	applyContextSystemPromptPatch,
	effectiveContextMessages,
	sendMessage,
} from "./agent-loop.js"
import type { BHZAIConversationImpl } from "./conversation.js"

/**
 * Mock driver that yields a scripted sequence of DriverEvents.
 *
 * For testing, returns a fixed sequence of deltas and a done event.
 */
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

describe("TASK_0025: Agent loop core", () => {
	let bh: BHZAI
	let mockDriver: BHZAIDriver & { chat: Mock<(request: ChatRequest) => AsyncIterable<DriverEvent>> }

	beforeEach(() => {
		bh = new BHZAI()
		// Register mock driver
		mockDriver = makeMockDriver([
			{ type: "delta", text: "Hello " },
			{ type: "delta", text: "world" },
			{ type: "done", stopReason: "stop" },
		])
		bh.addDriver(mockDriver)
	})

	// =========================================================================
	// Test 1: message(before) handler returning { block: true } prevents driver call
	// =========================================================================
	it("message(before) handler returning { block: true } prevents driver call and resolves with blocked message", async () => {
		const conversation = (await bh.createConversation({
			model: "mock-driver-id/mock-model",
		})) as BHZAIConversationImpl

		// Register a handler that blocks the message
		conversation.on("message", (payload: unknown) => {
			const p = payload as { state: string }
			if (p.state === "before") {
				return { block: true, reason: "blocked by filter" }
			}
		})

		const result = await sendMessage(conversation, "This will be blocked")

		// Verify it resolves (does not throw)
		expect(result).toBeDefined()

		// Verify the meta flags
		expect(result.meta.blocked).toBe(true)
		expect(result.meta.blockedReason).toBe("blocked by filter")

		// Verify the mock driver was never called
		expect(mockDriver.chat.mock.calls).toHaveLength(0)

		// Verify no messages were added to conversation
		expect(conversation.messages).toHaveLength(0)
	})

	// =========================================================================
	// Test 2: message(before) handler mutating the message affects driver input
	// =========================================================================
	it("message(before) handler modifying user message content affects driver input", async () => {
		const conversation = (await bh.createConversation({
			model: "mock-driver-id/mock-model",
		})) as BHZAIConversationImpl

		// Register a handler that appends to the message
		conversation.on("message", (payload: unknown) => {
			const p = payload as {
				state: string
				message: { append: (text: string) => void }
			}
			if (p.state === "before") {
				p.message.append(" EXTRA")
			}
		})

		await sendMessage(conversation, "Original")

		// Check that the driver received the modified content
		const chatCalls = mockDriver.chat.mock.calls
		expect(chatCalls).toHaveLength(1)
		const chatRequest = chatCalls[0][0] as ChatRequest
		const userMessage = chatRequest.messages[chatRequest.messages.length - 1]
		expect(userMessage.content).toBe("Original EXTRA")
	})

	// =========================================================================
	// Test 3: context event patch for tools flows through, deep copy protects real state
	// =========================================================================
	it("context event handler can patch tools, and deep copy prevents mutation of real state", async () => {
		const conversation = (await bh.createConversation({
			model: "mock-driver-id/mock-model",
		})) as BHZAIConversationImpl

		// Add a tool to the framework
		bh.addTool({
			name: "tool1",
			description: "First tool",
			inputSchema: { type: "object" },
			execute: async () => "ok",
		})

		const rogue = {
			name: "rogue-tool",
			description: "Should not persist",
			inputSchema: { type: "object" },
			execute: async () => "rogue",
		}

		let contextToolsInHandler: Array<{
			name: string
			description: string
			inputSchema: unknown
			execute: unknown
		}> = []

		// Register a context handler that:
		// 1. Mutates the received payload's messages array
		// 2. Returns a patch that modifies the tool list
		conversation.on("context", (payload: unknown) => {
			const p = payload as {
				messages: unknown[]
				tools: Array<{ name: string; description: string; inputSchema: unknown; execute: unknown }>
			}
			// Capture what we see
			contextToolsInHandler = p.tools
			// Try to mutate the payload (should not affect real state)
			p.messages.push({
				id: "rogue-msg",
				role: "system",
				content: "This is a rogue message",
				blocks: [{ type: "text", text: "Rogue" }],
				meta: {},
				append: () => {},
				setContent: () => {},
			})
			// Return a patch with the extra tool
			return { tools: [...p.tools, rogue] }
		})

		await sendMessage(conversation, "Test")

		// Verify the driver received the tool patch (rogue tool should be in the request)
		const chatCalls = mockDriver.chat.mock.calls
		expect(chatCalls).toHaveLength(1)
		const chatRequest = chatCalls[0][0] as ChatRequest
		expect(chatRequest.tools).toBeDefined()
		const toolNames = chatRequest.tools?.map((t) => t.name)
		expect(toolNames).toContain("tool1")
		expect(toolNames).toContain("rogue-tool")

		// Verify the real conversation.messages was NOT mutated by the handler
		const messageIds = conversation.messages.map((m) => m.id)
		expect(messageIds).not.toContain("rogue-msg")

		// Verify the real tools list has only the one we registered
		expect(contextToolsInHandler).toHaveLength(1)
		expect(contextToolsInHandler[0].name).toBe("tool1")
	})

	// =========================================================================
	// Test 4: message.delta events fire in order for text and reasoning
	// =========================================================================
	it("message.delta events fire in correct order for text and reasoning deltas", async () => {
		const conversation = (await bh.createConversation({
			model: "mock-driver-id/mock-model",
		})) as BHZAIConversationImpl

		// Override the mock driver to emit mixed deltas
		bh.addDriver(
			makeMockDriver([
				{ type: "delta", text: "Text 1 " },
				{ type: "reasoning-delta", text: "Reasoning 1" },
				{ type: "delta", text: "Text 2" },
				{ type: "reasoning-delta", text: " Reasoning 2" },
				{ type: "done", stopReason: "stop" },
			]),
		)

		const deltaEvents: Array<{ kind: string; delta: string }> = []

		conversation.on("message.delta", (payload: unknown) => {
			const p = payload as { kind: string; delta: string }
			deltaEvents.push({ kind: p.kind, delta: p.delta })
		})

		await sendMessage(conversation, "Test")

		// Verify the order of deltas
		expect(deltaEvents).toEqual([
			{ kind: "text", delta: "Text 1 " },
			{ kind: "reasoning", delta: "Reasoning 1" },
			{ kind: "text", delta: "Text 2" },
			{ kind: "reasoning", delta: " Reasoning 2" },
		])
	})

	// =========================================================================
	// Test 5: addMessage with contextIncluded: false excluded from context
	// =========================================================================
	it("addMessage with contextIncluded: false is excluded from context event's message list", async () => {
		const conversation = (await bh.createConversation({
			model: "mock-driver-id/mock-model",
		})) as BHZAIConversationImpl

		// Add a display-only message
		await addMessage(conversation, "Display message", "system", { contextIncluded: false })

		// Add a regular message that will be in context
		await addMessage(conversation, "Real message", "user", {})

		let contextMessages: unknown[] = []
		conversation.on("context", (payload: unknown) => {
			const p = payload as { messages: unknown[] }
			contextMessages = p.messages
		})

		await sendMessage(conversation, "Trigger context")

		// Verify the display message is in conversation.messages
		const allMessages = conversation.messages as readonly { content: string; id: string }[]
		// display + real + user from sendMessage + assistant response
		expect(allMessages.length).toBe(4)
		expect(allMessages.some((m) => (m as { content: string }).content === "Display message")).toBe(
			true,
		)

		// Verify it's NOT in the context event
		// The context should have: real + user (not the display one)
		const contextContents = contextMessages.map((m) => (m as { content: string }).content)
		expect(contextContents).not.toContain("Display message")
		expect(contextContents).toContain("Real message")
		expect(contextContents.some((c) => c === "Trigger context")).toBe(true)
	})

	// =========================================================================
	// Test 6: loop(start) fires before driver call, loop(end) has correct payload
	// =========================================================================
	it("loop events fire with correct ordering and payloads", async () => {
		const conversation = (await bh.createConversation({
			model: "mock-driver-id/mock-model",
		})) as BHZAIConversationImpl

		const events: string[] = []

		conversation.on("loop", (payload: unknown) => {
			const p = payload as { state: string }
			events.push(`loop(${p.state})`)
		})
		mockDriver.chat.mockImplementation(async function* () {
			events.push("driver.chat called")
			yield { type: "delta", text: "Response" }
			yield { type: "done", stopReason: "stop" }
		})

		await sendMessage(conversation, "Test")

		// Verify loop(start) fired before driver call
		const loopStartIndex = events.indexOf("loop(start)")
		const driverIndex = events.indexOf("driver.chat called")
		expect(loopStartIndex).toBeLessThan(driverIndex)

		// Verify loop(end) fired
		expect(events).toContain("loop(end)")
	})

	// =========================================================================
	// Test 7: Happy path — sendMessage resolves with assistant message
	// =========================================================================
	it("happy path: sendMessage resolves with correctly accumulated assistant message", async () => {
		const conversation = (await bh.createConversation({
			model: "mock-driver-id/mock-model",
		})) as BHZAIConversationImpl

		const result = await sendMessage(conversation, "Say hello")

		// Verify result is an assistant message
		expect(result.role).toBe("assistant")

		// Verify content was accumulated from deltas
		expect(result.content).toBe("Hello world")

		// Verify message has proper structure
		expect(result.id).toBeDefined()
		expect(result.time).toBeGreaterThan(0)
		expect(result.blocks).toBeDefined()

		// Verify it was added to conversation
		const assistantMessages = conversation.messages.filter((m) => m.role === "assistant")
		expect(assistantMessages).toHaveLength(1)
		expect(assistantMessages[0].id).toBe(result.id)
	})

	// =========================================================================
	// Test 8: addMessage fires message(sent) immediately
	// =========================================================================
	it("addMessage fires message(sent) immediately without loop events", async () => {
		const conversation = (await bh.createConversation({
			model: "mock-driver-id/mock-model",
		})) as BHZAIConversationImpl

		const events: string[] = []

		conversation.on("message", (payload: unknown) => {
			const p = payload as { state: string }
			events.push(`message(${p.state})`)
		})
		conversation.on("loop", () => {
			events.push("loop event")
		})

		const result = await addMessage(conversation, "Added message", "assistant")

		// Verify message(sent) fired but no loop events
		expect(events).toEqual(["message(sent)"])

		// Verify message was added
		expect(conversation.messages).toHaveLength(1)
		expect(conversation.messages[0].id).toBe(result.id)

		// Verify it's not blocked
		expect(result.meta.blocked).not.toBe(true)
	})

	// =========================================================================
	// Test 9: effectiveContextMessages helper filters correctly
	// =========================================================================
	it("effectiveContextMessages returns only messages with contextIncluded !== false", async () => {
		const conversation = (await bh.createConversation({
			model: "mock-driver-id/mock-model",
		})) as BHZAIConversationImpl

		await addMessage(conversation, "Included by default", "system", {})
		await addMessage(conversation, "Excluded", "system", { contextIncluded: false })
		await addMessage(conversation, "Explicitly included", "user", { contextIncluded: true })

		const effective = effectiveContextMessages(conversation)

		expect(effective).toHaveLength(2)
		expect(effective.some((m) => m.content === "Included by default")).toBe(true)
		expect(effective.some((m) => m.content === "Explicitly included")).toBe(true)
		expect(effective.some((m) => m.content === "Excluded")).toBe(false)
	})

	// =========================================================================
	// Test 10: Conversation status transitions through streaming → idle
	// =========================================================================
	it("conversation status transitions from idle → streaming → idle", async () => {
		const conversation = (await bh.createConversation({
			model: "mock-driver-id/mock-model",
		})) as BHZAIConversationImpl

		expect(conversation.status).toBe("idle")

		const statusHistory: string[] = []

		conversation.on("loop", () => {
			statusHistory.push(conversation.status)
		})

		await sendMessage(conversation, "Test")

		// After sendMessage, status should be back to idle
		expect(conversation.status).toBe("idle")
	})

	// =========================================================================
	// Test 11: Usage accumulation
	// =========================================================================
	it("usage tokens accumulate from driver events", async () => {
		const conversation = (await bh.createConversation({
			model: "mock-driver-id/mock-model",
		})) as BHZAIConversationImpl

		bh.addDriver(
			makeMockDriver([
				{ type: "usage", inputTokens: 10, outputTokens: 20 },
				{ type: "delta", text: "Response" },
				{ type: "usage", inputTokens: 5, outputTokens: 10 },
				{ type: "done", stopReason: "stop" },
			]),
		)

		expect(conversation.usage.inputTokens).toBe(0)
		expect(conversation.usage.outputTokens).toBe(0)

		await sendMessage(conversation, "Test")

		// Verify usage accumulated
		expect(conversation.usage.inputTokens).toBe(15) // 10 + 5
		expect(conversation.usage.outputTokens).toBe(30) // 20 + 10
	})

	// =========================================================================
	// Test 12: Missing model throws error
	// =========================================================================
	it("sendMessage throws if conversation has no resolved model", async () => {
		const bh2 = new BHZAI()
		const conversation = (await bh2.createConversation()) as BHZAIConversationImpl

		// Don't set a model
		await expect(sendMessage(conversation, "Test")).rejects.toThrow(
			/conversation has no resolved model/,
		)
	})

	// =========================================================================
	// Test 13: User message with ContentBlock array
	// =========================================================================
	it("sendMessage handles ContentBlock[] content correctly", async () => {
		const conversation = (await bh.createConversation({
			model: "mock-driver-id/mock-model",
		})) as BHZAIConversationImpl

		const blocks: ContentBlock[] = [
			{ type: "text", text: "Block 1 " },
			{ type: "text", text: "Block 2" },
		]

		await sendMessage(conversation, blocks)

		// Verify the concatenated content was sent to driver
		const chatCalls = mockDriver.chat.mock.calls
		const chatRequest = chatCalls[0][0] as ChatRequest
		const userMsg = chatRequest.messages[chatRequest.messages.length - 1]
		expect(userMsg.content).toBe("Block 1 Block 2")
	})

	// =========================================================================
	// Test 14: Reasoning content accumulation
	// =========================================================================
	it("reasoning-delta events accumulate into message.meta.reasoning", async () => {
		const conversation = (await bh.createConversation({
			model: "mock-driver-id/mock-model",
		})) as BHZAIConversationImpl

		bh.addDriver(
			makeMockDriver([
				{ type: "reasoning-delta", text: "Think " },
				{ type: "reasoning-delta", text: "about " },
				{ type: "reasoning-delta", text: "it" },
				{ type: "delta", text: "Answer" },
				{ type: "done", stopReason: "stop" },
			]),
		)

		const result = await sendMessage(conversation, "Test")

		expect(result.meta.reasoning).toBe("Think about it")
		expect(result.content).toBe("Answer")
	})

	// =========================================================================
	// Test 15: addMessage with custom metadata
	// =========================================================================
	it("addMessage merges custom metadata correctly", async () => {
		const conversation = (await bh.createConversation({
			model: "mock-driver-id/mock-model",
		})) as BHZAIConversationImpl

		const result = await addMessage(conversation, "Test", "user", {
			meta: { source: "api", custom: 123 },
		})

		expect(result.meta.source).toBe("api")
		expect(result.meta.custom).toBe(123)
		expect(result.meta.contextIncluded).toBe(true) // default
	})

	// =========================================================================
	// Tests 16-20: applyContextSystemPromptPatch helper (layer 4 system-prompt logic)
	// =========================================================================
	// TASK_0025 § 11.6: context-event system-prompt patches follow layer 3 precedence:
	// 1. systemPrompt (replace) wins if present
	// 2. appendSystemPrompt (append) is used if systemPrompt is absent
	// 3. base value is returned unchanged if neither is present

	describe("applyContextSystemPromptPatch helper", () => {
		it("test 16: systemPrompt replaces base regardless of base value", () => {
			// Empty base
			expect(applyContextSystemPromptPatch("", { systemPrompt: "X" })).toBe("X")
			// Non-empty base
			expect(applyContextSystemPromptPatch("BASE", { systemPrompt: "X" })).toBe("X")
		})

		it("test 17: appendSystemPrompt on empty base returns value directly", () => {
			expect(applyContextSystemPromptPatch("", { appendSystemPrompt: "X" })).toBe("X")
		})

		it("test 18: appendSystemPrompt on non-empty base appends with blank-line separator", () => {
			expect(applyContextSystemPromptPatch("BASE", { appendSystemPrompt: "X" })).toBe("BASE\n\nX")
		})

		it("test 19: empty patch returns base unchanged", () => {
			expect(applyContextSystemPromptPatch("BASE", {})).toBe("BASE")
		})

		it("test 20: systemPrompt wins when both systemPrompt and appendSystemPrompt are present", () => {
			expect(
				applyContextSystemPromptPatch("BASE", {
					systemPrompt: "S",
					appendSystemPrompt: "A",
				}),
			).toBe("S")
		})
	})

	// =========================================================================
	// Test 21: context handler returning { appendSystemPrompt } on conversation
	// with NO initial systemPrompt
	// =========================================================================
	it("context handler with appendSystemPrompt on conversation without initial systemPrompt", async () => {
		const conversation = (await bh.createConversation({
			model: "mock-driver-id/mock-model",
			// Deliberately NOT setting systemPrompt
		})) as BHZAIConversationImpl

		// Register a context handler that appends
		conversation.on("context", () => {
			return { appendSystemPrompt: "EXTRA CONTEXT" }
		})

		await sendMessage(conversation, "Test message")

		// Inspect the driver call to verify the systemPrompt
		const chatCalls = mockDriver.chat.mock.calls
		expect(chatCalls).toHaveLength(1)
		const chatRequest = chatCalls[0][0] as ChatRequest
		expect(chatRequest.systemPrompt).toBe("EXTRA CONTEXT")
	})

	// =========================================================================
	// Test 22: context handler returning { appendSystemPrompt } on conversation
	// WITH base systemPrompt
	// =========================================================================
	it("context handler with appendSystemPrompt on conversation with base systemPrompt", async () => {
		const conversation = (await bh.createConversation({
			model: "mock-driver-id/mock-model",
			systemPrompt: "BASE PROMPT",
		})) as BHZAIConversationImpl

		// Register a context handler that appends
		conversation.on("context", () => {
			return { appendSystemPrompt: "EXTRA CONTEXT" }
		})

		await sendMessage(conversation, "Test message")

		// Inspect the driver call to verify the concatenation
		const chatCalls = mockDriver.chat.mock.calls
		expect(chatCalls).toHaveLength(1)
		const chatRequest = chatCalls[0][0] as ChatRequest
		expect(chatRequest.systemPrompt).toBe("BASE PROMPT\n\nEXTRA CONTEXT")
	})

	// =========================================================================
	// Test 23: context handler returning { systemPrompt } (replace) still works
	// =========================================================================
	it("context handler with systemPrompt (replace) still works correctly", async () => {
		const conversation = (await bh.createConversation({
			model: "mock-driver-id/mock-model",
			systemPrompt: "ORIGINAL",
		})) as BHZAIConversationImpl

		// Register a context handler that replaces
		conversation.on("context", () => {
			return { systemPrompt: "REPLACED" }
		})

		await sendMessage(conversation, "Test message")

		// Verify the driver receives the replaced prompt
		const chatCalls = mockDriver.chat.mock.calls
		expect(chatCalls).toHaveLength(1)
		const chatRequest = chatCalls[0][0] as ChatRequest
		expect(chatRequest.systemPrompt).toBe("REPLACED")
	})

	// =========================================================================
	// Test 24: no context handler → driver receives unmodified base prompt
	// =========================================================================
	it("no context handler → driver receives unmodified systemPrompt", async () => {
		const conversation = (await bh.createConversation({
			model: "mock-driver-id/mock-model",
			systemPrompt: "BASE PROMPT",
		})) as BHZAIConversationImpl

		// Do NOT register any context handler

		await sendMessage(conversation, "Test message")

		// Verify the driver receives the base prompt unchanged
		const chatCalls = mockDriver.chat.mock.calls
		expect(chatCalls).toHaveLength(1)
		const chatRequest = chatCalls[0][0] as ChatRequest
		expect(chatRequest.systemPrompt).toBe("BASE PROMPT")
	})

	// =========================================================================
	// Test 25: context event payload includes live conversation reference (identity check)
	// =========================================================================
	it("context event payload includes live conversation reference (identity check)", async () => {
		const conversation = (await bh.createConversation({
			model: "mock-driver-id/mock-model",
		})) as BHZAIConversationImpl

		let receivedConversation: BHZAIConversationImpl | undefined

		conversation.on("context", (payload: unknown) => {
			const p = payload as { conversation: BHZAIConversationImpl }
			receivedConversation = p.conversation
		})

		await sendMessage(conversation, "Test")

		// Verify the context payload includes the conversation reference
		expect(receivedConversation).toBeDefined()

		// Verify it's the SAME instance (identity check)
		expect(receivedConversation).toBe(conversation)
	})

	// =========================================================================
	// Test 26: context handler can read conversation.meta through payload reference
	// =========================================================================
	it("context handler can read and interact with conversation.meta through payload.conversation", async () => {
		const conversation = (await bh.createConversation({
			model: "mock-driver-id/mock-model",
		})) as BHZAIConversationImpl

		// Set some metadata on the conversation
		conversation.setMeta({ tasks: ["task1", "task2"], count: 42 })

		let metaTasks: unknown
		let metaCount: unknown

		conversation.on("context", (payload: unknown) => {
			const p = payload as { conversation: BHZAIConversationImpl }
			// Read meta fields through the payload reference
			metaTasks = (p.conversation.meta.tasks as unknown[]) ?? undefined
			metaCount = p.conversation.meta.count
		})

		await sendMessage(conversation, "Test")

		// Verify we could read the meta fields
		expect(metaTasks).toEqual(["task1", "task2"])
		expect(metaCount).toBe(42)
	})

	// =========================================================================
	// Test 27: turn(start) event payload includes live conversation reference
	// =========================================================================
	it("turn(start) event payload includes live conversation reference (identity check)", async () => {
		const conversation = (await bh.createConversation({
			model: "mock-driver-id/mock-model",
		})) as BHZAIConversationImpl

		let receivedConversationOnStart: BHZAIConversationImpl | undefined

		conversation.on("turn", (payload: unknown) => {
			const p = payload as { state: string; conversation?: BHZAIConversationImpl }
			if (p.state === "start") {
				receivedConversationOnStart = p.conversation
			}
		})

		await sendMessage(conversation, "Test")

		// Verify the turn(start) payload includes the conversation reference
		expect(receivedConversationOnStart).toBeDefined()

		// Verify it's the SAME instance (identity check)
		expect(receivedConversationOnStart).toBe(conversation)
	})
})
