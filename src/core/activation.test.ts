import { describe, expect, it } from "vitest"

import type { ToolRegistry } from "../tools/registry.js"
import type {
	BHZAIDriver,
	DriverCapabilities,
	JSONSchema,
	McpServerConfig,
	ModelInfo,
} from "../types/index.js"
import { BHZAI } from "./bhzai.js"
import type { McpClientFactory, McpClientLike } from "./mcp-integration.js"

// Plugin activation — the ownership ledger that attributes every registration
// to a plugin, and the enable/disable switch that gates those contributions.
//
// The invariant these tests exist to protect: a plugin nobody ever toggles
// behaves exactly as it did before activation existed, and anything registered
// outside a plugin can never be switched off at all.

// ---------------------------------------------------------------------------
// Fixtures.
// ---------------------------------------------------------------------------

const SCHEMA: JSONSchema = { type: "object" }

const CAPS: DriverCapabilities = { streaming: true, toolCalls: true, reasoning: false }

function modelFor(driver: string, id: string): ModelInfo {
	return { ref: `${driver}/${id}`, driver, id, capabilities: { ...CAPS }, availability: "ready" }
}

function mockDriver(id: string, models: ModelInfo[]): BHZAIDriver {
	return {
		id,
		listModels: async () => models,
		capabilities: () => CAPS,
		async *chat() {
			// no-op stub; the agent loop is not exercised here
		},
	}
}

function tool(name: string) {
	return { name, description: "", inputSchema: SCHEMA, execute: async () => "" }
}

function toolNames(bh: BHZAI): string[] {
	return bh.listTools().map((t) => t.name)
}

/**
 * Register a form-1 factory and return the name the kernel assigned it.
 *
 * Form-1 factories never carry a caller-chosen name — `normalizeFactory` always
 * mints `plugin-<n>-<uuid>` and ignores `fn.name` — so a test that wants to
 * toggle a factory plugin has to ask the kernel what it ended up called.
 */
function useFactory(bh: BHZAI, fn: (b: BHZAI) => void | Promise<void>): string {
	bh.use(fn)
	const plugins = bh.listPlugins()
	return plugins[plugins.length - 1].name
}

/** A mock MCP client that registers one namespaced tool during connect(). */
class MockMcpClient implements McpClientLike {
	readonly serverName: string
	private readonly toolRegistry: ToolRegistry
	constructor(config: McpServerConfig, toolRegistry: ToolRegistry) {
		this.serverName = config.name ?? "mock-server"
		this.toolRegistry = toolRegistry
	}
	async connect(): Promise<void> {
		this.toolRegistry.addTool({
			name: `mcp__${this.serverName}__t1`,
			description: "d",
			inputSchema: SCHEMA,
			execute: async () => ({ content: [] }),
		})
	}
}

const mockFactory: McpClientFactory = (config, toolRegistry) =>
	new MockMcpClient(config, toolRegistry)

// ---------------------------------------------------------------------------
// Attribution.
// ---------------------------------------------------------------------------

describe("plugin attribution", () => {
	it("attributes a form-1 factory's synchronous registrations to it", () => {
		const bh = new BHZAI()
		const name = useFactory(bh, (b) => {
			b.addTool(tool("get_weather"))
		})
		const [status] = bh.listPlugins()
		expect(status.name).toBe(name)
		expect(status.contributions.tools).toEqual(["get_weather"])
	})

	it("attributes a form-2 plugin's initialize-time registrations to it", async () => {
		const bh = new BHZAI()
		bh.use({
			name: "kitchen-sink",
			initialize: ({ bh: b }) => {
				b.addTool(tool("t"))
				b.addCommand("c", { description: "", handler: async () => {} })
				b.addDriver(mockDriver("d", []))
				b.on("kitchen-sink.ping", () => {})
			},
		})
		await bh.init()
		expect(bh.listPlugins()[0].contributions).toEqual({
			tools: ["t"],
			commands: ["c"],
			drivers: ["d"],
			mcpServers: [],
			eventHandlers: 1,
		})
	})

	it("attributes registrations made across an await inside an initialize hook", async () => {
		// `init()` awaits hooks strictly sequentially, so the attribution window
		// covers the hook's entire async body — not just its synchronous head.
		const bh = new BHZAI()
		bh.use({
			name: "slow",
			initialize: async ({ bh: b }) => {
				await Promise.resolve()
				b.addTool(tool("late"))
			},
		})
		await bh.init()
		expect(bh.listPlugins()[0].contributions.tools).toEqual(["late"])
	})

	it("leaves host-level registrations unowned and therefore never gatable", () => {
		const bh = new BHZAI()
		bh.use({ name: "p" })
		bh.addTool(tool("host_tool"))
		expect(bh.listPlugins()[0].contributions.tools).toEqual([])
		bh.disablePlugin("p")
		expect(toolNames(bh)).toEqual(["host_tool"])
	})

	it("does not attribute a form-1 factory's registrations made after its first await", async () => {
		// Documented gap: `use()` does not await `setup()`, so the ambient
		// attribution window closes when the factory suspends. Such a
		// registration is host-owned and therefore always active. Changing this
		// behavior should be a deliberate decision, so it is pinned here.
		const bh = new BHZAI()
		let registered!: () => void
		const done = new Promise<void>((resolve) => {
			registered = resolve
		})
		const name = useFactory(bh, async (b) => {
			await Promise.resolve()
			b.addTool(tool("async_tool"))
			registered()
		})
		await done
		expect(bh.listPlugins()[0].contributions.tools).toEqual([])
		bh.disablePlugin(name)
		expect(toolNames(bh)).toEqual(["async_tool"])
	})

	it("recovers the async case when the plugin wraps its registration in runAs()", async () => {
		const bh = new BHZAI()
		let registered!: () => void
		const done = new Promise<void>((resolve) => {
			registered = resolve
		})
		// The factory needs its own name to call `runAs`, which it cannot know
		// before `use()` returns — so resolve it from the kernel and hand it in.
		let assigned = ""
		const name = useFactory(bh, async (b) => {
			await Promise.resolve()
			b.runAs(assigned, () => {
				b.addTool(tool("async_tool"))
			})
			registered()
		})
		assigned = name
		await done
		expect(bh.listPlugins()[0].contributions.tools).toEqual(["async_tool"])
		bh.disablePlugin(name)
		expect(toolNames(bh)).toEqual([])
	})

	it("attributes tools registered through the decorator toolRegistrar seam", () => {
		const bh = new BHZAI()
		const name = useFactory(bh, (b) => {
			b.toolRegistrar.register({ name: "decorated_tool", schema: SCHEMA, execute: () => "" })
		})
		expect(bh.listPlugins()[0].contributions.tools).toEqual(["decorated_tool"])
		bh.disablePlugin(name)
		expect(toolNames(bh)).toEqual([])
	})

	it("attributes tools declared via the capability-object `tools:` key", async () => {
		// TASK_0040 (issue #6) made `init()` register `capabilities.tools`. That
		// path bypasses both `setup()` and the `initialize` hook, so it needs its
		// own attribution scope — otherwise `tools:` would be the one registration
		// form producing permanently ungatable tools.
		const bh = new BHZAI()
		bh.use({ name: "declarative", tools: [tool("declared_tool")] })
		await bh.init()
		expect(bh.listPlugins()[0].contributions.tools).toEqual(["declared_tool"])
		bh.disablePlugin("declarative")
		expect(toolNames(bh)).toEqual([])
		bh.enablePlugin("declarative")
		expect(toolNames(bh)).toEqual(["declared_tool"])
	})

	it("attributes MCP servers and their discovered tools to the declaring plugin", async () => {
		const bh = new BHZAI()
		bh.registerMcpClientFactory(mockFactory)
		bh.use({
			name: "mcp-host",
			getMcps: async () => [{ url: "https://example.com/mcp", name: "srv" }],
		})
		await bh.init()
		const [status] = bh.listPlugins()
		expect(status.contributions.mcpServers).toEqual(["srv"])
		expect(status.contributions.tools).toEqual(["mcp__srv__t1"])
	})

	it("releases a tool's attribution when it is removed", () => {
		const bh = new BHZAI()
		const name = useFactory(bh, (b) => {
			b.addTool(tool("t"))
		})
		bh.removeTool("t")
		// Re-registered at host level, the name must not inherit the old owner.
		bh.addTool(tool("t"))
		bh.disablePlugin(name)
		expect(toolNames(bh)).toEqual(["t"])
	})
})

// ---------------------------------------------------------------------------
// Global activation.
// ---------------------------------------------------------------------------

describe("BHZAI plugin activation", () => {
	it("reports plugins as enabled by default", () => {
		const bh = new BHZAI()
		bh.use({ name: "p" })
		expect(bh.isPluginEnabled("p")).toBe(true)
		expect(bh.listPlugins()[0].enabled).toBe(true)
	})

	it("reports an unregistered name as not enabled without throwing", () => {
		expect(new BHZAI().isPluginEnabled("nope")).toBe(false)
	})

	it("hides and restores a disabled plugin's tools", () => {
		const bh = new BHZAI()
		bh.use({
			name: "p",
			initialize: ({ bh: b }) => {
				b.addTool(tool("t"))
			},
		})
		return bh.init().then(() => {
			expect(toolNames(bh)).toEqual(["t"])
			expect(bh.listTools({ allow: ["t"] })).toHaveLength(1)

			bh.disablePlugin("p")
			expect(toolNames(bh)).toEqual([])
			expect(bh.listTools({ allow: ["t"] })).toEqual([])
			expect(bh.isPluginEnabled("p")).toBe(false)
			expect(bh.listPlugins()[0].enabled).toBe(false)

			bh.enablePlugin("p")
			expect(toolNames(bh)).toEqual(["t"])
		})
	})

	it("hides a disabled plugin's commands", async () => {
		const bh = new BHZAI()
		bh.use({
			name: "p",
			initialize: ({ bh: b }) => {
				b.addCommand("greet", { description: "", handler: async () => {} })
			},
		})
		await bh.init()
		expect(bh.listCommands().map((c) => c.name)).toEqual(["greet"])
		bh.disablePlugin("p")
		expect(bh.listCommands()).toEqual([])
	})

	it("hides a disabled plugin's driver models", async () => {
		const bh = new BHZAI()
		bh.use({
			name: "p",
			initialize: ({ bh: b }) => {
				b.addDriver(mockDriver("d", [modelFor("d", "m1")]))
			},
		})
		await bh.init()
		expect(await bh.listModels()).toHaveLength(1)
		bh.disablePlugin("p")
		expect(await bh.listModels()).toEqual([])
	})

	it("hides a disabled plugin's modelSource hook results", async () => {
		const bh = new BHZAI()
		bh.use({ name: "catalogue", modelSource: async () => [modelFor("remote", "m1")] })
		await bh.init()
		expect(await bh.listModels()).toHaveLength(1)
		bh.disablePlugin("catalogue")
		expect(await bh.listModels()).toEqual([])
	})

	it("hides a disabled plugin's MCP-discovered tools without detaching the server", async () => {
		const bh = new BHZAI()
		bh.registerMcpClientFactory(mockFactory)
		bh.use({
			name: "mcp-host",
			getMcps: async () => [{ url: "https://example.com/mcp", name: "srv" }],
		})
		await bh.init()
		expect(toolNames(bh)).toEqual(["mcp__srv__t1"])

		bh.disablePlugin("mcp-host")
		expect(toolNames(bh)).toEqual([])

		// Deliberate: deactivation is registration-preserving, so the handle and
		// its live connection survive — which is why re-enabling restores the
		// tool synchronously, with no reconnect and no chance of failure.
		bh.enablePlugin("mcp-host")
		expect(toolNames(bh)).toEqual(["mcp__srv__t1"])
	})

	it("skips a disabled plugin's event handlers and excludes them from handled", async () => {
		const bh = new BHZAI()
		const seen: string[] = []
		bh.use({
			name: "a",
			initialize: ({ bh: b }) => {
				b.on("test.ping", () => {
					seen.push("a")
				})
			},
		})
		bh.use({
			name: "c",
			initialize: ({ bh: b }) => {
				b.on("test.ping", () => {
					seen.push("c")
				})
			},
		})
		await bh.init()

		const first = await bh.emit("test.ping", {})
		expect(seen).toEqual(["a", "c"])
		expect(first.handled).toBe(2)

		bh.disablePlugin("a")
		seen.length = 0
		const second = await bh.emit("test.ping", {})
		expect(seen).toEqual(["c"])
		expect(second.handled).toBe(1)

		bh.enablePlugin("a")
		seen.length = 0
		const third = await bh.emit("test.ping", {})
		expect(seen).toEqual(["a", "c"])
		expect(third.handled).toBe(2)
	})

	it("leaves other plugins' contributions untouched", () => {
		const bh = new BHZAI()
		const a = useFactory(bh, (b) => {
			b.addTool(tool("a_tool"))
		})
		useFactory(bh, (b) => {
			b.addTool(tool("c_tool"))
		})
		bh.disablePlugin(a)
		expect(toolNames(bh)).toEqual(["c_tool"])
	})

	it("round-trips disable/enable back to the exact starting catalogue", () => {
		const bh = new BHZAI()
		const name = useFactory(bh, (b) => {
			b.addTool(tool("t1"))
			b.addTool(tool("t2"))
		})
		const before = toolNames(bh)
		bh.disablePlugin(name).enablePlugin(name)
		expect(toolNames(bh)).toEqual(before)
	})

	it("is idempotent in both directions", () => {
		const bh = new BHZAI()
		bh.use({ name: "p" })
		bh.disablePlugin("p").disablePlugin("p")
		expect(bh.isPluginEnabled("p")).toBe(false)
		bh.enablePlugin("p").enablePlugin("p")
		expect(bh.isPluginEnabled("p")).toBe(true)
	})

	it("returns this for chaining", () => {
		const bh = new BHZAI()
		bh.use({ name: "p" })
		expect(bh.disablePlugin("p")).toBe(bh)
		expect(bh.enablePlugin("p")).toBe(bh)
	})

	it("throws when toggling a name that was never registered", () => {
		const bh = new BHZAI()
		expect(() => bh.disablePlugin("ghost")).toThrow(/no plugin named "ghost" is registered/)
		expect(() => bh.enablePlugin("ghost")).toThrow(/no plugin named "ghost" is registered/)
	})

	it("lists plugins in registration order", () => {
		const bh = new BHZAI()
		bh.use({ name: "first" })
		bh.use({ name: "second" })
		expect(bh.listPlugins().map((p) => p.name)).toEqual(["first", "second"])
	})

	it("reports empty contributions for a plugin that registered nothing", () => {
		const bh = new BHZAI()
		bh.use({ name: "inert" })
		expect(bh.listPlugins()[0].contributions).toEqual({
			tools: [],
			commands: [],
			drivers: [],
			mcpServers: [],
			eventHandlers: 0,
		})
	})

	it("keeps activation state independent per BHZAI instance", () => {
		const a = new BHZAI()
		const c = new BHZAI()
		a.use({ name: "p" })
		c.use({ name: "p" })
		a.disablePlugin("p")
		expect(a.isPluginEnabled("p")).toBe(false)
		expect(c.isPluginEnabled("p")).toBe(true)
	})
})
