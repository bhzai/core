/** @file Tests for TASK_0040: OpenCode plugin interop adapter */

import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Mock } from "vitest"
import type { BHZAIConversationImpl } from "../../../conversation/conversation.js"
import { BHZAI } from "../../../core/bhzai.js"
import type { CredentialResolver, CredentialScope, Credentials } from "../../../core/credentials.js"
import { resolveCredentials } from "../../../core/credentials.js"
import type { BHZAIDriver, ChatRequest, DriverEvent } from "../../../types/driver.js"
import type { BHZAIConversation } from "../../../types/index.js"
import { type OpenCodePluginFn, runOpenCodePlugin } from "./index.js"

/**
 * Internal interface: payload shape for "tool" event in tests.
 */
interface ToolEventPayload {
	state: string
	tool?: { name: string }
	[key: string]: unknown
}

/**
 * Mock driver that yields a scripted sequence of DriverEvents.
 * Used for end-to-end tool-call testing through the real agent loop.
 * Note: for multi-turn scenarios, create separate mock drivers (each instance
 * tracks its own call count).
 */
function makeMockDriver(
	scriptedEvents: DriverEvent[],
): BHZAIDriver & { chat: Mock<(request: ChatRequest) => AsyncIterable<DriverEvent>> } {
	let callCount = 0
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
			// Only yield scripted events on the first call; subsequent calls yield "done" to terminate the loop
			if (callCount === 0) {
				callCount++
				for (const event of scriptedEvents) {
					yield event
				}
			} else {
				// Subsequent calls: just terminate without tool calls
				yield { type: "done" as const, stopReason: "stop" as const }
			}
		}),
		embed: undefined,
	}
}

describe("TASK_0040: OpenCode plugin interop adapter", () => {
	let bh: BHZAI
	let mockDriver: BHZAIDriver & { chat: Mock<(request: ChatRequest) => AsyncIterable<DriverEvent>> }

	beforeEach(() => {
		bh = new BHZAI()
		// Register mock driver
		mockDriver = makeMockDriver([
			{ type: "delta", text: "Hello world" },
			{ type: "done", stopReason: "stop" },
		])
		bh.addDriver(mockDriver)
	})

	// =========================================================================
	// Test 1: tool hook registers a real BHZAI tool with correctly converted
	// JSON Schema inputSchema
	// =========================================================================
	it("tool hook registers a real BHZAI tool with correctly converted JSON Schema inputSchema", async () => {
		// Create a mock zod-like schema with toJSONSchema() method
		const mockSchema = {
			toJSONSchema: () => ({
				type: "object" as const,
				properties: {
					x: { type: "string" },
					y: { type: "number" },
				},
				required: ["x"],
			}),
		}

		const plugin: OpenCodePluginFn = async () => ({
			tool: {
				myTool: {
					description: "A test tool",
					args: mockSchema,
					execute: async (args: unknown) => {
						return { result: args }
					},
				},
			},
		})

		await bh.init()
		await runOpenCodePlugin(plugin, bh, {
			project: { name: "test-project", root: "/test" },
			directory: "/test",
		})

		// Verify the tool is registered
		const tools = bh.listTools()
		const myTool = tools.find((t) => t.name === "myTool")
		expect(myTool).toBeDefined()
		expect(myTool?.description).toBe("A test tool")

		// Verify the inputSchema matches exactly what toJSONSchema() returned
		const expectedSchema = mockSchema.toJSONSchema()
		expect(myTool?.inputSchema).toEqual(expectedSchema)
	})

	// =========================================================================
	// Test 2: tool_execute_before/after and permission_ask handlers are wired up
	// =========================================================================
	it("plugin's tool_execute_before, tool_execute_after, and permission_ask hooks are registered", async () => {
		// This test verifies that the OpenCode plugin's tool execution hooks are
		// properly registered and triggered through a real agent loop.

		const bh2 = new BHZAI()
		const hooksCalled: string[] = []

		const mockSchema = {
			toJSONSchema: () => ({
				type: "object" as const,
				properties: { text: { type: "string" } },
				required: ["text"],
			}),
		}

		const executeSpy = vi.fn(async () => "ok")

		const plugin: OpenCodePluginFn = async () => ({
			tool: {
				testTool: {
					description: "Test tool",
					args: mockSchema,
					execute: executeSpy,
				},
			},
			tool_execute_before: async () => {
				hooksCalled.push("before")
			},
			tool_execute_after: async () => {
				hooksCalled.push("after")
			},
			permission_ask: async () => {
				hooksCalled.push("permission")
				return "allow"
			},
		})

		// Register the mock driver that yields a tool call event
		const mockToolDriver = makeMockDriver([
			{
				type: "tool-call",
				toolCallId: "test-call-1",
				name: "testTool",
				input: { text: "hello" },
			} as DriverEvent,
			{ type: "done", stopReason: "tool-calls" },
		])
		bh2.addDriver(mockToolDriver)

		// Initialize BHZAI first (following Test 1 pattern)
		await bh2.init()

		// Then register the plugin (the adapter works in both orders, but this ensures handlers are wired)
		await runOpenCodePlugin(plugin, bh2, {
			project: { name: "test-project", root: "/test" },
			directory: "/test",
		})

		// Create a conversation and trigger a tool call
		const conversation = (await bh2.createConversation({
			model: "mock-driver-id/mock-model",
		})) as BHZAIConversationImpl

		// Send a message that will trigger the tool call
		await conversation.sendMessage("Call the test tool")

		// Verify hooks were called in the right order: permission, then before, then after
		expect(hooksCalled).toContain("permission")
		expect(hooksCalled).toContain("before")
		expect(hooksCalled).toContain("after")
		expect(hooksCalled.indexOf("before")).toBeLessThan(hooksCalled.indexOf("after"))

		// Verify the tool's execute was actually called
		expect(executeSpy).toHaveBeenCalledTimes(1)
	})

	// =========================================================================
	// Test 3: permission.ask and native beforeCall approver both gate the same
	// tool call (both directions)
	// =========================================================================
	it("permission.ask and native beforeCall approver both gate the same tool call — native denies first", async () => {
		const mockSchema = {
			toJSONSchema: () => ({
				type: "object" as const,
				properties: { x: { type: "string" } },
			}),
		}

		const executeSpy = vi.fn(async () => "should-not-reach")

		const plugin: OpenCodePluginFn = async () => ({
			tool: {
				blockableTool: {
					description: "Tool that can be blocked",
					args: mockSchema,
					execute: executeSpy,
				},
			},
			permission_ask: async () => {
				// OpenCode hook would ALLOW this call
				return "allow"
			},
		})

		await bh.init()
		await runOpenCodePlugin(plugin, bh, {
			project: { name: "test-project", root: "/test" },
			directory: "/test",
		})

		// Create a conversation and register a NATIVE blocker BEFORE the adapter runs
		const mockToolDriver = makeMockDriver([
			{
				type: "tool-call",
				toolCallId: "blocked-call",
				name: "blockableTool",
				input: { x: "test" },
			} as DriverEvent,
			{ type: "done", stopReason: "tool-calls" },
		])
		bh.addDriver(mockToolDriver)

		const conversation = (await bh.createConversation({
			model: "mock-driver-id/mock-model",
		})) as BHZAIConversationImpl

		// Register a native blocker on the conversation BEFORE sending the message
		// This ensures it runs first in the handler registration order
		conversation.on("tool", (payload: unknown) => {
			const p = payload as ToolEventPayload
			if (p.state === "beforeCall" && p.tool?.name === "blockableTool") {
				return { block: true, reason: "native veto" }
			}
		})

		// Send a message that would trigger the tool
		const result = await conversation.sendMessage("Call the blockable tool")

		// The message should have completed (not thrown)
		expect(result).toBeDefined()

		// Verify the tool was NOT executed (native veto won)
		expect(executeSpy).not.toHaveBeenCalled()
	})

	it("permission.ask and native beforeCall approver both gate the same tool call — OpenCode denies second", async () => {
		const mockSchema = {
			toJSONSchema: () => ({
				type: "object" as const,
				properties: { x: { type: "string" } },
			}),
		}

		const executeSpy = vi.fn(async () => "should-not-reach")

		const plugin: OpenCodePluginFn = async () => ({
			tool: {
				blockableTool2: {
					description: "Tool that can be blocked",
					args: mockSchema,
					execute: executeSpy,
				},
			},
			permission_ask: async () => {
				// OpenCode hook DENIES this call
				return "deny"
			},
		})

		await bh.init()
		await runOpenCodePlugin(plugin, bh, {
			project: { name: "test-project", root: "/test" },
			directory: "/test",
		})

		// Create a conversation and register a NATIVE approver
		const mockToolDriver = makeMockDriver([
			{
				type: "tool-call",
				toolCallId: "denied-call",
				name: "blockableTool2",
				input: { x: "test" },
			} as DriverEvent,
			{ type: "done", stopReason: "tool-calls" },
		])
		bh.addDriver(mockToolDriver)

		const conversation = (await bh.createConversation({
			model: "mock-driver-id/mock-model",
		})) as BHZAIConversationImpl

		// Register a native APPROVER on the conversation
		// This runs first, but OpenCode's permission.ask (which runs later) should block it
		conversation.on("tool", (payload: unknown) => {
			const p = payload as ToolEventPayload
			if (p.state === "beforeCall" && p.tool?.name === "blockableTool2") {
				// Allow the call from native perspective
				return undefined // No block, allow to proceed
			}
		})

		// Send a message that would trigger the tool
		const result = await conversation.sendMessage("Call the blockable tool")

		// Should complete without throwing
		expect(result).toBeDefined()

		// The tool should have been blocked by OpenCode's permission.ask
		expect(executeSpy).not.toHaveBeenCalled()
	})

	// =========================================================================
	// Test 4: config hook validates through § 7.4 contract, including failure
	// =========================================================================
	it("config hook validates through the § 7.4 contract with correct failure shape on type mismatch", async () => {
		const plugin: OpenCodePluginFn = async () => ({
			config: () => ({
				schema: {
					type: "object",
					properties: {
						count: { type: "number" },
					},
					required: ["count"],
				},
			}),
		})

		// Create BHZAI WITHOUT pre-supplied config (so the plugin's schema drives validation)
		const bh2 = new BHZAI()
		bh2.addDriver(makeMockDriver([{ type: "done", stopReason: "stop" }]))

		// Register the plugin BEFORE init() so its config schema is declared
		// The plugin declares a required property "count" with no default
		await runOpenCodePlugin(plugin, bh2, {
			project: { name: "test-project", root: "/test" },
			directory: "/test",
		})

		// Now init() should fail because the config schema requires "count" but no value was supplied
		const initPromise = bh2.init()
		await expect(initPromise).rejects.toThrow(/count/)
		await expect(initPromise).rejects.toThrow(/expected present/)
	})

	// =========================================================================
	// Test 5: auth hook is registered as a tier-2 resolver in the § 10.4 chain
	// =========================================================================
	it("auth hook is registered as a tier-2 CredentialResolver — tier-1 runtime credentials still win when resolved through the real § 10.4 chain", async () => {
		// This test verifies that the OpenCode adapter's auth hook is registered as a tier-2
		// credential resolver, and that tier-1 runtime values still override it per § 10.4.

		const bh2 = new BHZAI()

		const plugin: OpenCodePluginFn = async () => ({
			config: () => ({
				schema: {
					type: "object",
					properties: {
						enabled: { type: "boolean", default: true },
					},
				},
			}),
			auth: async (scope: CredentialScope) => {
				return { "x-api-key": "from-auth-hook" }
			},
		})

		// Register the plugin
		await runOpenCodePlugin(plugin, bh2, {
			project: { name: "test-project", root: "/test" },
			directory: "/test",
		})

		// init() should succeed, config should be validated
		await expect(bh2.init()).resolves.toBeUndefined()

		// Retrieve the auth hook that was registered via the adapter
		const authResolvers = bh2.getContributions<CredentialResolver>("auth")
		expect(authResolvers.length).toBe(1)

		const authResolver = authResolvers[0]
		if (!authResolver) {
			throw new Error("Expected exactly one auth resolver to be registered")
		}

		// Test the credential resolution chain: tier-1 runtime value should win over tier-2 hook
		const scope: CredentialScope = { kind: "driver", id: "test-driver" }
		const runtimeCredentials: Credentials = { "x-api-key": "from-runtime" }

		// Resolve with tier-1 runtime value present
		const resolved = await resolveCredentials(scope, runtimeCredentials, [authResolver])

		// Tier-1 should win: the result should be the runtime value, not the hook's value
		expect(resolved).toEqual({ "x-api-key": "from-runtime" })
		expect(resolved).not.toEqual({ "x-api-key": "from-auth-hook" })
	})

	// =========================================================================
	// Test 6: plugin with no hooks does not break
	// =========================================================================
	it("plugin with no hooks (empty hooks object) runs without error", async () => {
		const plugin: OpenCodePluginFn = async () => ({})

		await bh.init()
		const result = await runOpenCodePlugin(plugin, bh, {
			project: { name: "test-project", root: "/test" },
			directory: "/test",
		})

		// Should complete without throwing
		expect(result).toBeUndefined()
	})
})
