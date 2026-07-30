// TASK_0015 — `bh.addMcp()` + `getMcps`/`modelSource` hook resolution tests.
//
// These tests exercise:
//  - `McpRegistry.addMcp()` — factory injection, connect, handle storage,
//    `mcp.attached` event firing with `{ server, tools }`.
//  - `McpRegistry.registerClientFactory()` — the seam the MCP plugin uses.
//  - `resolveGetMcpsHooks()` — hook resolution order, multi-config hooks,
//    partial-failure rejection.
//  - `resolveModelSourceHooks()` — hook resolution order, concatenation,
//    no de-duplication, partial-failure rejection.
//  - `BHZAI.addMcp()` — the public kernel method delegating to the registry.
//  - `BHZAI.init()` — the `getMcps`/`modelSource` resolution seam firing
//    after `initialize` hooks and before the `initialize` event.
//  - `BHZAI.listModels()` — the merged driver + modelSource catalogue.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { ToolRegistry } from "../tools/registry.js"
import type { McpServerConfig, ModelInfo } from "../types/index.js"
import { BHZAI } from "./bhzai.js"
import { EventBus } from "./event-bus.js"
import {
	type McpClientFactory,
	type McpClientLike,
	McpRegistry,
	type ResolvedGetMcpsHook,
	type ResolvedModelSourceHook,
	resolveGetMcpsHooks,
	resolveModelSourceHooks,
} from "./mcp-integration.js"

// ---------------------------------------------------------------------------
// Mock McpClient factory + client.
// ---------------------------------------------------------------------------

/** A mock McpClient that records its construction args and tracks connect(). */
class MockMcpClient implements McpClientLike {
	static instances: MockMcpClient[] = []
	static reset(): void {
		MockMcpClient.instances = []
	}
	readonly serverName: string
	readonly config: McpServerConfig
	readonly options: unknown
	readonly toolRegistry: ToolRegistry
	connectSpy = vi.fn(async () => {})
	constructor(config: McpServerConfig, toolRegistry: ToolRegistry, options?: unknown) {
		this.config = config
		this.toolRegistry = toolRegistry
		this.options = options
		this.serverName = config.name ?? "mock-server"
		MockMcpClient.instances.push(this)
	}
	async connect(): Promise<void> {
		await this.connectSpy()
		// Simulate discovery: register one tool under the namespaced name.
		this.toolRegistry.addTool({
			name: `mcp__${this.serverName}__t1`,
			description: "d",
			inputSchema: { type: "object" },
			execute: async () => ({ content: [] }),
		})
	}
}

function mockFactory(): McpClientFactory {
	return (config, toolRegistry, options) => new MockMcpClient(config, toolRegistry, options)
}

beforeEach(() => {
	MockMcpClient.reset()
})
afterEach(() => {
	vi.restoreAllMocks()
})

// ---------------------------------------------------------------------------
// McpRegistry — addMcp, factory injection, mcp.attached event.
// ---------------------------------------------------------------------------

describe("McpRegistry", () => {
	it("addMcp() throws if no factory has been registered", async () => {
		const bus = new EventBus()
		const registry = new ToolRegistry(bus)
		const mcpRegistry = new McpRegistry(bus, registry)
		await expect(mcpRegistry.addMcp({ url: "https://example.com/mcp" })).rejects.toThrow(
			/MCP plugin is not registered/,
		)
	})

	it("registerClientFactory() enables addMcp()", async () => {
		const bus = new EventBus()
		const registry = new ToolRegistry(bus)
		const mcpRegistry = new McpRegistry(bus, registry)
		mcpRegistry.registerClientFactory(mockFactory())
		const handle = await mcpRegistry.addMcp({ url: "https://example.com/mcp", name: "srv" })
		expect(handle.serverName).toBe("srv")
		expect(handle.client).toBeInstanceOf(MockMcpClient)
		expect(MockMcpClient.instances).toHaveLength(1)
		expect(MockMcpClient.instances[0]?.config.url).toBe("https://example.com/mcp")
	})

	it("addMcp() awaits connect() before returning the handle", async () => {
		const bus = new EventBus()
		const registry = new ToolRegistry(bus)
		const mcpRegistry = new McpRegistry(bus, registry)
		mcpRegistry.registerClientFactory(mockFactory())
		const handle = await mcpRegistry.addMcp({ url: "https://example.com/mcp", name: "srv" })
		expect((handle.client as MockMcpClient).connectSpy).toHaveBeenCalledTimes(1)
	})

	it("addMcp() fires mcp.attached with { server, tools }", async () => {
		const bus = new EventBus()
		const registry = new ToolRegistry(bus)
		const mcpRegistry = new McpRegistry(bus, registry)
		mcpRegistry.registerClientFactory(mockFactory())
		const events: Array<{ event: string; payload: unknown }> = []
		bus.on("mcp.attached", (payload) => {
			events.push({ event: "mcp.attached", payload })
		})
		await mcpRegistry.addMcp({ url: "https://example.com/mcp", name: "srv" })
		// Flush the bus's microtask chain.
		await new Promise((r) => setTimeout(r, 0))
		expect(events).toHaveLength(1)
		expect(events[0]?.payload).toMatchObject({
			server: "srv",
			tools: ["mcp__srv__t1"],
		})
	})

	it("addMcp() forwards options to the factory opaquely", async () => {
		const bus = new EventBus()
		const registry = new ToolRegistry(bus)
		const mcpRegistry = new McpRegistry(bus, registry)
		mcpRegistry.registerClientFactory(mockFactory())
		const opts = { autoApproveTools: true, custom: "thing" }
		const handle = await mcpRegistry.addMcp({ url: "https://example.com/mcp", name: "srv" }, opts)
		expect((handle.client as MockMcpClient).options).toEqual(opts)
	})

	it("get() and list() return handles by name / in attach order", async () => {
		const bus = new EventBus()
		const registry = new ToolRegistry(bus)
		const mcpRegistry = new McpRegistry(bus, registry)
		mcpRegistry.registerClientFactory(mockFactory())
		await mcpRegistry.addMcp({ url: "https://a.com/mcp", name: "a" })
		await mcpRegistry.addMcp({ url: "https://b.com/mcp", name: "b" })
		expect(mcpRegistry.get("a")?.serverName).toBe("a")
		expect(mcpRegistry.get("b")?.serverName).toBe("b")
		expect(mcpRegistry.get("missing")).toBeUndefined()
		expect(mcpRegistry.list().map((h) => h.serverName)).toEqual(["a", "b"])
		expect(mcpRegistry.size).toBe(2)
	})

	it("shadowing: re-attaching the same server name replaces the handle", async () => {
		const bus = new EventBus()
		const registry = new ToolRegistry(bus)
		const mcpRegistry = new McpRegistry(bus, registry)
		mcpRegistry.registerClientFactory(mockFactory())
		await mcpRegistry.addMcp({ url: "https://a.com/mcp", name: "a" })
		const first = mcpRegistry.get("a")
		await mcpRegistry.addMcp({ url: "https://a.com/mcp", name: "a" })
		const second = mcpRegistry.get("a")
		expect(first).not.toBe(second)
		expect(mcpRegistry.size).toBe(1)
	})
})

// ---------------------------------------------------------------------------
// resolveGetMcpsHooks — hook resolution order, multi-config, partial-failure.
// ---------------------------------------------------------------------------

describe("resolveGetMcpsHooks", () => {
	it("resolves hooks in registration order and attaches all returned configs", async () => {
		const bus = new EventBus()
		const registry = new ToolRegistry(bus)
		const mcpRegistry = new McpRegistry(bus, registry)
		mcpRegistry.registerClientFactory(mockFactory())
		const order: string[] = []
		const hooks: ResolvedGetMcpsHook[] = [
			{
				getMcps: async () => {
					order.push("hook1")
					return [
						{ url: "https://a.com/mcp", name: "a" },
						{ url: "https://b.com/mcp", name: "b" },
					]
				},
			},
			{
				getMcps: async () => {
					order.push("hook2")
					return [{ url: "https://c.com/mcp", name: "c" }]
				},
			},
		]
		const handles = await resolveGetMcpsHooks(hooks, mcpRegistry)
		expect(order).toEqual(["hook1", "hook2"])
		expect(handles.map((h) => h.serverName)).toEqual(["a", "b", "c"])
		expect(mcpRegistry.size).toBe(3)
	})

	it("rejects if any hook throws (partial-failure)", async () => {
		const bus = new EventBus()
		const registry = new ToolRegistry(bus)
		const mcpRegistry = new McpRegistry(bus, registry)
		mcpRegistry.registerClientFactory(mockFactory())
		const hooks: ResolvedGetMcpsHook[] = [
			{ getMcps: async () => [{ url: "https://a.com/mcp", name: "a" }] },
			{
				getMcps: async () => {
					throw new Error("hook2 failed")
				},
			},
		]
		await expect(resolveGetMcpsHooks(hooks, mcpRegistry)).rejects.toThrow(/hook2 failed/)
	})

	it("rejects if any addMcp() rejects (partial-failure)", async () => {
		const bus = new EventBus()
		const registry = new ToolRegistry(bus)
		const mcpRegistry = new McpRegistry(bus, registry)
		// Register a factory whose connect() throws.
		mcpRegistry.registerClientFactory((config, toolRegistry) => {
			const c = new MockMcpClient(config, toolRegistry)
			c.connectSpy = vi.fn(async () => {
				throw new Error("connect failed")
			})
			return c
		})
		const hooks: ResolvedGetMcpsHook[] = [
			{ getMcps: async () => [{ url: "https://a.com/mcp", name: "a" }] },
		]
		await expect(resolveGetMcpsHooks(hooks, mcpRegistry)).rejects.toThrow(/connect failed/)
	})

	it("forwards options to every addMcp() call", async () => {
		const bus = new EventBus()
		const registry = new ToolRegistry(bus)
		const mcpRegistry = new McpRegistry(bus, registry)
		mcpRegistry.registerClientFactory(mockFactory())
		const opts = { autoApproveTools: true }
		const hooks: ResolvedGetMcpsHook[] = [
			{ getMcps: async () => [{ url: "https://a.com/mcp", name: "a" }] },
		]
		await resolveGetMcpsHooks(hooks, mcpRegistry, opts)
		expect((mcpRegistry.get("a")?.client as MockMcpClient).options).toEqual(opts)
	})
})

// ---------------------------------------------------------------------------
// resolveModelSourceHooks — concatenation, no de-dup, partial-failure.
// ---------------------------------------------------------------------------

function mockModel(ref: string): ModelInfo {
	return {
		ref,
		driver: ref.split("/")[0] ?? "d",
		id: ref.split("/")[1] ?? "m",
		capabilities: { streaming: true, toolCalls: false, reasoning: false },
		availability: "ready",
	}
}

describe("resolveModelSourceHooks", () => {
	it("concatenates hook results in registration order", async () => {
		const hooks: ResolvedModelSourceHook[] = [
			{ modelSource: async () => [mockModel("d1/a"), mockModel("d1/b")] },
			{ modelSource: async () => [mockModel("d2/c")] },
		]
		const merged = await resolveModelSourceHooks(hooks)
		expect(merged.map((m) => m.ref)).toEqual(["d1/a", "d1/b", "d2/c"])
	})

	it("does NOT de-duplicate across hooks", async () => {
		const hooks: ResolvedModelSourceHook[] = [
			{ modelSource: async () => [mockModel("d/a")] },
			{ modelSource: async () => [mockModel("d/a")] }, // duplicate ref
		]
		const merged = await resolveModelSourceHooks(hooks)
		expect(merged).toHaveLength(2)
		expect(merged.map((m) => m.ref)).toEqual(["d/a", "d/a"])
	})

	it("returns an empty array when no hooks are supplied", async () => {
		const merged = await resolveModelSourceHooks([])
		expect(merged).toEqual([])
	})

	it("rejects if any hook throws (partial-failure)", async () => {
		const hooks: ResolvedModelSourceHook[] = [
			{ modelSource: async () => [mockModel("d/a")] },
			{
				modelSource: async () => {
					throw new Error("modelSource failed")
				},
			},
		]
		await expect(resolveModelSourceHooks(hooks)).rejects.toThrow(/modelSource failed/)
	})
})

// ---------------------------------------------------------------------------
// BHZAI.addMcp() — public kernel method.
// ---------------------------------------------------------------------------

describe("BHZAI.addMcp()", () => {
	it("throws if the MCP plugin is not registered", async () => {
		const bh = new BHZAI()
		await expect(bh.addMcp({ url: "https://example.com/mcp" })).rejects.toThrow(
			/MCP plugin is not registered/,
		)
	})

	it("delegates to the registry after registerMcpClientFactory()", async () => {
		const bh = new BHZAI()
		bh.registerMcpClientFactory(mockFactory())
		const handle = await bh.addMcp({ url: "https://example.com/mcp", name: "srv" })
		expect(handle.serverName).toBe("srv")
	})

	it("forwards options opaquely", async () => {
		const bh = new BHZAI()
		bh.registerMcpClientFactory(mockFactory())
		const opts = { autoApproveTools: true }
		const handle = await bh.addMcp({ url: "https://example.com/mcp", name: "srv" }, opts)
		expect((handle.client as MockMcpClient).options).toEqual(opts)
	})
})

// ---------------------------------------------------------------------------
// BHZAI.init() — getMcps/modelSource resolution seam.
// ---------------------------------------------------------------------------

describe("BHZAI.init() — getMcps/modelSource resolution", () => {
	it("resolves getMcps hooks after initialize hooks and before the initialize event", async () => {
		const order: string[] = []
		const bh = new BHZAI()
		bh.registerMcpClientFactory(mockFactory())
		bh.use({
			name: "p1",
			initialize: async () => {
				order.push("initialize-hook")
			},
			getMcps: async () => {
				order.push("getMcps-hook")
				return [{ url: "https://a.com/mcp", name: "a" }]
			},
		})
		bh.on("initialize", () => {
			order.push("initialize-event")
		})
		await bh.init()
		// Flush the bus's microtask chain for the initialize event.
		await new Promise((r) => setTimeout(r, 0))
		expect(order).toEqual(["initialize-hook", "getMcps-hook", "initialize-event"])
	})

	it("resolves modelSource hooks and merges into listModels()", async () => {
		const bh = new BHZAI()
		bh.use({
			name: "p1",
			modelSource: async () => [mockModel("custom/x")],
		})
		await bh.init()
		const models = await bh.listModels()
		expect(models.map((m) => m.ref)).toContain("custom/x")
	})

	it("listModels() returns only driver models before init() runs", async () => {
		const bh = new BHZAI()
		bh.use({
			name: "p1",
			modelSource: async () => [mockModel("custom/x")],
		})
		// Before init(), modelSource hooks have not been resolved.
		const models = await bh.listModels()
		expect(models.map((m) => m.ref)).not.toContain("custom/x")
	})

	it("merges driver models AND modelSource hook results after init()", async () => {
		const bh = new BHZAI()
		// Register a mock driver.
		bh.addDriver({
			id: "mock-driver",
			listModels: async () => [mockModel("mock-driver/m1")],
			capabilities: () => ({ streaming: true, toolCalls: false, reasoning: false }),
			chat: async function* () {
				yield { type: "done", stopReason: "stop" }
			},
		})
		bh.use({
			name: "p1",
			modelSource: async () => [mockModel("custom/x"), mockModel("custom/y")],
		})
		await bh.init()
		const refs = (await bh.listModels()).map((m) => m.ref)
		expect(refs).toContain("mock-driver/m1")
		expect(refs).toContain("custom/x")
		expect(refs).toContain("custom/y")
	})

	it("init() rejects if a getMcps hook throws (partial-failure)", async () => {
		const bh = new BHZAI()
		bh.registerMcpClientFactory(mockFactory())
		bh.use({
			name: "p1",
			getMcps: async () => {
				throw new Error("getMcps failed")
			},
		})
		await expect(bh.init()).rejects.toThrow(/getMcps failed/)
	})

	it("init() rejects if a modelSource hook throws (partial-failure)", async () => {
		const bh = new BHZAI()
		bh.use({
			name: "p1",
			modelSource: async () => {
				throw new Error("modelSource failed")
			},
		})
		await expect(bh.init()).rejects.toThrow(/modelSource failed/)
	})

	it("init() is idempotent — getMcps/modelSource hooks do not re-resolve on second init()", async () => {
		const bh = new BHZAI()
		bh.registerMcpClientFactory(mockFactory())
		let getMcpsCalls = 0
		let modelSourceCalls = 0
		bh.use({
			name: "p1",
			getMcps: async () => {
				getMcpsCalls++
				return []
			},
			modelSource: async () => {
				modelSourceCalls++
				return []
			},
		})
		await bh.init()
		await bh.init() // no-op
		expect(getMcpsCalls).toBe(1)
		expect(modelSourceCalls).toBe(1)
	})
})
