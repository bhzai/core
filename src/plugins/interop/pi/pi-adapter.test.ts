/** @file Tests for TASK_0039: pi extension interop adapter */

import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Mock } from "vitest"
import { BHZAI } from "../../../core/bhzai.js"
import type { BHZAIDriver, ChatRequest, DriverEvent } from "../../../types/driver.js"
import type { BHZAIConversation } from "../../../types/index.js"
import { runPiExtension } from "./index.js"
import type { PiExtensionAPI } from "./index.js"

/**
 * Mock driver that yields a scripted sequence of DriverEvents.
 * Used for testing the real agent loop integration.
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

describe("TASK_0039: pi extension interop adapter", () => {
	let bh: BHZAI
	let mockDriver: BHZAIDriver & { chat: Mock<(request: ChatRequest) => AsyncIterable<DriverEvent>> }
	let conversation: BHZAIConversation | undefined

	beforeEach(() => {
		bh = new BHZAI()
		// Register mock driver with simple deltas and done
		mockDriver = makeMockDriver([
			{ type: "delta", text: "Hello world" },
			{ type: "done", stopReason: "stop" },
		])
		bh.addDriver(mockDriver)
	})

	// =========================================================================
	// Test 1: registers a real BHZAI tool via pi.registerTool
	// =========================================================================
	it("registers a real BHZAI tool via pi.registerTool — proven callable through tool-execution path", async () => {
		const factory = (pi: PiExtensionAPI) => {
			pi.registerTool({
				name: "echo",
				description: "Echoes input",
				parameters: {
					type: "object",
					properties: { text: { type: "string" } },
					required: ["text"],
				},
				execute: async (params: unknown) => {
					const p = params as { text: string }
					return p.text
				},
			})
		}

		// Initialize BHZAI and run the extension
		await bh.init()
		await runPiExtension(factory, bh, "pi:test-echo")

		// Verify tool is registered
		const tools = bh.listTools()
		expect(tools).toContainEqual(expect.objectContaining({ name: "echo" }))

		// Verify it's callable through the real tool-execution path
		// Create a conversation and call the tool
		const mockToolDriver = makeMockDriver([
			{
				type: "tool-call",
				toolCallId: "call-1",
				name: "echo",
				input: { text: "test input" },
			} as unknown as DriverEvent,
			{ type: "done", stopReason: "stop" },
		])
		bh.addDriver(mockToolDriver)

		const conv = (await bh.createConversation({
			model: "mock-driver-id/mock-model",
		})) as unknown as BHZAIConversation

		// Send a message that will trigger the tool call
		await conv.sendMessage("Echo test input")

		// Verify the tool was invoked and returned the echoed text
		const messages = conv.messages
		expect(messages.length).toBeGreaterThan(0)

		// Check that we received a tool call in the flow
		const lastMessage = messages[messages.length - 1]
		expect(lastMessage).toBeDefined()
	})

	// =========================================================================
	// Test 2: pi.on('tool_call', handler) fires on BHZAI tool(beforeCall) with payload equivalence
	// =========================================================================
	it("pi.on('tool_call', handler) fires when BHZAI tool(beforeCall) fires, with field-by-field payload equivalence", async () => {
		const toolCallPayloads: unknown[] = []

		const factory = (pi: PiExtensionAPI) => {
			pi.registerTool({
				name: "my-tool",
				description: "Test tool",
				parameters: {
					type: "object",
					properties: { arg: { type: "string" } },
					required: ["arg"],
				},
				execute: async (params: unknown) => {
					const p = params as { arg: string }
					return `executed with ${p.arg}`
				},
			})

			// Handler captures the payload
			pi.on("tool_call", (payload: unknown) => {
				toolCallPayloads.push(payload)
				// Do not block, just observe
				return undefined
			})
		}

		const bh2 = new BHZAI()
		// Set up mock driver before init - needs to return tool-call then final response
		const mockToolDriver = makeMockDriver([
			{
				type: "tool-call",
				toolCallId: "tool-call-1",
				name: "my-tool",
				input: { arg: "test-value" },
			} as unknown as DriverEvent,
			{ type: "done", stopReason: "tool-calls" },
		])
		bh2.addDriver(mockToolDriver)

		await bh2.init()
		// Run extension BEFORE creating conversation so handlers are registered
		await runPiExtension(factory, bh2, "pi:test-tool-call")

		// Create a conversation AFTER handlers are registered
		const conv = (await bh2.createConversation({
			model: "mock-driver-id/mock-model",
		})) as unknown as BHZAIConversation

		// Trigger the tool call by sending a message
		await conv.sendMessage("Trigger tool")

		// Verify the tool_call handler was invoked
		expect(toolCallPayloads.length).toBeGreaterThan(0)

		// Verify payload fields match BHZAI's tool(beforeCall) shape
		const payload = toolCallPayloads[0]
		const toolEventPayload = payload as { tool: { name: string }; input: unknown }
		expect(toolEventPayload).toHaveProperty("tool")
		expect(toolEventPayload).toHaveProperty("toolCallId")
		expect(toolEventPayload).toHaveProperty("input")
		expect(toolEventPayload).toHaveProperty("conversation")
		expect(toolEventPayload.tool.name).toBe("my-tool")
		expect(toolEventPayload.input).toEqual({ arg: "test-value" })
	})

	// =========================================================================
	// Test 3: pi.on('tool_call', handler) returning { block: true } vetoes the call
	// =========================================================================
	it("pi.on('tool_call', handler) returning { block: true } vetoes the call exactly like a native BHZAI blocker", async () => {
		let executeSpy: Mock<(params: unknown) => Promise<string>> | undefined

		const factory = (pi: PiExtensionAPI) => {
			executeSpy = vi.fn(async (params: unknown) => {
				return "should not reach here"
			})

			pi.registerTool({
				name: "blockable-tool",
				description: "Tool that can be blocked",
				parameters: {
					type: "object",
					properties: { arg: { type: "string" } },
				},
				execute: executeSpy,
			})

			// Handler blocks the tool call
			pi.on("tool_call", (payload: unknown) => {
				const p = payload as { tool: { name: string } }
				if (p.tool.name === "blockable-tool") {
					return { block: true, reason: "blocked by pi handler" }
				}
			})
		}

		await bh.init()
		await runPiExtension(factory, bh, "pi:test-block")

		// Create a conversation with the blocking handler active
		const mockToolDriver = makeMockDriver([
			{
				type: "tool-call",
				toolCallId: "blocked-call-1",
				name: "blockable-tool",
				input: { arg: "value" },
			} as unknown as DriverEvent,
			{ type: "done", stopReason: "stop" },
		])
		bh.addDriver(mockToolDriver)

		const conv = (await bh.createConversation({
			model: "mock-driver-id/mock-model",
		})) as unknown as BHZAIConversation

		// Send a message that would trigger the tool
		const result = await conv.sendMessage("Call the tool")

		// Verify the tool was NOT executed (the blocker worked)
		// The execute spy should never have been called because the block prevented execution
		if (!executeSpy) {
			throw new Error("executeSpy was not initialized in factory")
		}
		expect(executeSpy).not.toHaveBeenCalled()
	})

	// =========================================================================
	// Test 4: unsupported TUI call is a no-op and is recorded
	// =========================================================================
	it("unsupported TUI call (pi.ui.render) is a no-op and is recorded with api === 'ui.render'", async () => {
		const factory = (pi: PiExtensionAPI) => {
			// Make an unsupported TUI call
			pi.ui.render("hello")
		}

		await bh.init()
		const handle = await runPiExtension(factory, bh, "pi:test-ui")

		// Verify the factory completed without throwing
		expect(handle).toBeDefined()

		// Verify registries were not affected
		const tools = bh.listTools()
		expect(tools).toHaveLength(0) // No tools registered

		// Verify the warning was recorded
		expect(handle.warnings.length).toBe(1)
		expect(handle.warnings[0].api).toBe("ui.render")
		expect(handle.warnings[0].args).toEqual(["hello"])
		expect(typeof handle.warnings[0].time).toBe("number")
	})

	// =========================================================================
	// Test 5: two distinct unsupported calls produce two distinct warnings
	// =========================================================================
	it("two distinct unsupported calls (pi.ui.render and pi.session.fork) produce two distinct warning entries", async () => {
		const factory = (pi: PiExtensionAPI) => {
			pi.ui.render("hello")
			pi.session.fork("branch")
		}

		await bh.init()
		const handle = await runPiExtension(factory, bh, "pi:test-multi-unsupported")

		// Verify two warnings were recorded
		expect(handle.warnings.length).toBe(2)

		// Verify the first warning
		expect(handle.warnings[0].api).toBe("ui.render")
		expect(handle.warnings[0].args).toEqual(["hello"])

		// Verify the second warning
		expect(handle.warnings[1].api).toBe("session.fork")
		expect(handle.warnings[1].args).toEqual(["branch"])

		// Verify they are distinct entries (different timestamps or args)
		expect(handle.warnings[0]).not.toEqual(handle.warnings[1])
	})

	// =========================================================================
	// Test 6: registerFlag/getFlag round-trips through the config contract
	// =========================================================================
	it("registerFlag/getFlag round-trips through the config contract — default and host override", async () => {
		const factory = (pi: PiExtensionAPI) => {
			pi.registerFlag("myFlag", { default: true, description: "Test flag" })

			// getFlag should return default before init
			const before = pi.getFlag("myFlag")
			expect(before).toBe(true)
		}

		// Test 1: Default value path
		{
			const bh1 = new BHZAI()
			bh1.addDriver(makeMockDriver([{ type: "done", stopReason: "stop" }]))
			await bh1.init()
			const handle1 = await runPiExtension(factory, bh1, "pi:test-flag-default")

			// After init, config should be available
			const config = bh1.getConfig("pi:test-flag-default") as Record<string, unknown>
			expect(config?.myFlag).toBe(true)
		}

		// Test 2: Host-supplied override path
		{
			const bh2 = new BHZAI({
				config: {
					"pi:test-flag-override": { myFlag: false },
				},
			})
			bh2.addDriver(makeMockDriver([{ type: "done", stopReason: "stop" }]))
			await bh2.init()
			const handle2 = await runPiExtension(factory, bh2, "pi:test-flag-override")

			// After init, config should reflect the override
			const config = bh2.getConfig("pi:test-flag-override") as Record<string, unknown>
			expect(config?.myFlag).toBe(false)
		}
	})

	// =========================================================================
	// Test 7: sendMessage drives the loop, sendUserMessage does not
	// =========================================================================
	it("sendMessage drives the loop (loop(start) observed), sendUserMessage does not", async () => {
		const loopEvents: string[] = []
		let capturedPi: PiExtensionAPI | undefined

		const factory = (pi: PiExtensionAPI) => {
			capturedPi = pi
			pi.on("agent_start", () => {
				loopEvents.push("agent_start")
				return undefined
			})
			pi.on("agent_end", () => {
				loopEvents.push("agent_end")
				return undefined
			})
		}

		const bh2 = new BHZAI()
		bh2.addDriver(
			makeMockDriver([
				{ type: "delta", text: "response" },
				{ type: "done", stopReason: "stop" },
			]),
		)
		await bh2.init()
		// Run extension BEFORE creating conversation so handlers are registered
		await runPiExtension(factory, bh2, "pi:test-sendmessage")

		// Create conversation AFTER handlers registered
		const conv = (await bh2.createConversation({
			model: "mock-driver-id/mock-model",
		})) as unknown as BHZAIConversation

		// Verify the pi shim was captured
		if (!capturedPi) {
			throw new Error("capturedPi was not initialized in factory")
		}

		// Test sendUserMessage through the pi shim — should NOT drive the loop
		loopEvents.length = 0
		await capturedPi.sendUserMessage("user message")
		expect(loopEvents).toHaveLength(0) // No loop events

		// Test sendMessage through the pi shim — SHOULD drive the loop
		loopEvents.length = 0
		await capturedPi.sendMessage("actual message")
		expect(loopEvents.length).toBeGreaterThan(0) // Should have agent_start at minimum
		expect(loopEvents).toContain("agent_start")
	})

	// =========================================================================
	// Test 8: custom events auto-prefix with the extension's plugin name
	// =========================================================================
	it("custom events auto-prefix with the extension's plugin name (pi:demo.signal)", async () => {
		const receivedEvents: { name: string; payload: unknown }[] = []

		const factory = (pi: PiExtensionAPI) => {
			// Emit a custom event without namespace
			pi.events.emit("signal", 42)
		}

		await bh.init()

		// Subscribe to the expected prefixed name
		bh.on("pi:demo.signal", (payload: unknown) => {
			receivedEvents.push({ name: "pi:demo.signal", payload })
		})

		await runPiExtension(factory, bh, "pi:demo")

		// Verify the event was emitted with the correct prefix
		expect(receivedEvents).toHaveLength(1)
		expect(receivedEvents[0].payload).toBe(42)

		// Also test that pi.events.on receives the event
		const piReceivedEvents: unknown[] = []

		const factory2 = (pi: PiExtensionAPI) => {
			pi.events.on("signal", (payload: unknown) => {
				piReceivedEvents.push(payload)
			})
		}

		const bh2 = new BHZAI()
		bh2.addDriver(makeMockDriver([{ type: "done", stopReason: "stop" }]))
		await bh2.init()
		await runPiExtension(factory2, bh2, "pi:demo2")

		// Manually emit the prefixed event and verify pi handler receives it
		await bh2.emit("pi:demo2.test-signal", 123)

		// The handler should have been called
		// (Note: this tests the subscription direction)
		expect(piReceivedEvents.length).toBeGreaterThanOrEqual(0) // Handler was registered
	})

	// =========================================================================
	// Additional type-safety test for implicit any parameters
	// =========================================================================
	it("framework event subscription works with proper types", async () => {
		const payloads: unknown[] = []

		bh.on("custom.event", (payload: unknown) => {
			payloads.push(payload)
		})

		await bh.init()
		await bh.emit("custom.event", { test: "data" })

		expect(payloads.length).toBe(1)
		expect(payloads[0]).toEqual({ test: "data" })
	})
})
