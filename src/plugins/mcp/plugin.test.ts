// mcpPlugin / createMcpPlugin tests — the kernel seam and its wiring.
//
// These run against the REAL `BHZAI` kernel (not a fake) because the whole
// point of this module is the kernel handshake: `use()` → `init()` →
// `registerMcpClientFactory` → `addMcp()`. A fake kernel would assert the
// mock's behavior instead of the contract. `fetch` is stubbed so the
// `McpClient` the factory builds performs a canned handshake without a
// network.

import { afterEach, describe, expect, it, vi } from "vitest"

import { BHZAI } from "../../core/bhzai.js"
import { createMcpPlugin, getMcpManager, mcpPlugin } from "./plugin.js"

// ---------------------------------------------------------------------------
// Mock transport: a minimal server that completes the handshake and answers
// `tools/list` with the given tools.
// ---------------------------------------------------------------------------

function stubMcpServer(tools: { name: string; description: string }[] = []): {
	fetch: ReturnType<typeof vi.fn>
	headersFor: (method: string) => Headers | undefined
} {
	const seen: { method: string; headers: Headers }[] = []
	const fetchMock = vi.fn(async (_url: string, init: RequestInit): Promise<Response> => {
		const body = init.body ? JSON.parse(init.body as string) : { method: "DELETE" }
		seen.push({ method: body.method, headers: new Headers(init.headers) })
		const json = (result: unknown): Response =>
			new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), {
				status: 200,
				headers: { "Content-Type": "application/json", "Mcp-Session-Id": "sess-1" },
			})

		switch (body.method) {
			case "initialize":
				return json({
					protocolVersion: "2025-11-25",
					capabilities: { tools: { listChanged: false } },
					serverInfo: { name: "stub", version: "1.0.0" },
				})
			case "notifications/initialized":
				return new Response(null, { status: 202 })
			case "tools/list":
				return json({
					tools: tools.map((t) => ({ ...t, inputSchema: { type: "object" } })),
				})
			default:
				return new Response(null, { status: 202 })
		}
	})
	vi.stubGlobal("fetch", fetchMock)
	return {
		fetch: fetchMock,
		headersFor: (method) => seen.find((s) => s.method === method)?.headers,
	}
}

afterEach(() => {
	vi.unstubAllGlobals()
	vi.restoreAllMocks()
})

// ---------------------------------------------------------------------------
// The seam.
// ---------------------------------------------------------------------------

describe("mcpPlugin — kernel seam", () => {
	it("bh.addMcp() refuses to attach when no MCP plugin is registered", async () => {
		const bh = new BHZAI()
		await bh.init()

		await expect(bh.addMcp({ url: "https://example.com/mcp" })).rejects.toThrow(
			/the MCP plugin is not registered/,
		)
	})

	it("registering mcpPlugin makes bh.addMcp() work and registers the discovered tools", async () => {
		stubMcpServer([{ name: "search", description: "Search things" }])
		const bh = new BHZAI()
		bh.use(mcpPlugin)
		await bh.init()

		const handle = await bh.addMcp({ url: "https://example.com/mcp", name: "srv" })

		expect(handle.serverName).toBe("srv")
		expect(bh.listTools().map((t) => t.name)).toContain("mcp__srv__search")
	})

	it("exposes a manager for the zero-config form via getMcpManager", async () => {
		stubMcpServer([{ name: "search", description: "Search things" }])
		const bh = new BHZAI()
		bh.use(mcpPlugin)
		await bh.init()

		const manager = getMcpManager(bh)
		expect(manager).toBeDefined()

		const state = await manager?.add({ url: "https://example.com/mcp", name: "srv" })
		expect(state?.status).toBe("connected")
		expect(state?.tools.map((t) => t.shortName)).toEqual(["search"])
	})

	it("does not leak manager state between kernels", async () => {
		stubMcpServer()
		const first = new BHZAI()
		const second = new BHZAI()
		first.use(mcpPlugin)
		second.use(mcpPlugin)
		await first.init()
		await second.init()

		expect(getMcpManager(first)).toBeDefined()
		expect(getMcpManager(first)).not.toBe(getMcpManager(second))
	})

	it("returns undefined from getMcpManager before init has run", () => {
		const bh = new BHZAI()
		bh.use(mcpPlugin)

		expect(getMcpManager(bh)).toBeUndefined()
	})
})

// ---------------------------------------------------------------------------
// createMcpPlugin.
// ---------------------------------------------------------------------------

describe("createMcpPlugin", () => {
	it("hands back a manager that works once the kernel is initialized", async () => {
		stubMcpServer([{ name: "a", description: "tool a" }])
		const bh = new BHZAI()
		const { plugin, manager } = createMcpPlugin()
		bh.use(plugin)
		await bh.init()

		const state = await manager.add({ url: "https://example.com/mcp", name: "srv" })

		expect(state.status).toBe("connected")
		expect(getMcpManager(bh)).toBe(manager)
	})

	it("gives an actionable error when the manager is used before init", async () => {
		const { manager } = createMcpPlugin()

		// The manager records the failure rather than rejecting (its documented
		// policy), so the actionable message surfaces in the error state.
		const state = await manager.add({ url: "https://example.com/mcp" })

		expect(state.status).toBe("error")
		expect(state.error?.message).toMatch(/has not been initialized yet/)
	})

	it("attaches `servers` declaratively during init via the getMcps hook", async () => {
		stubMcpServer([{ name: "declared", description: "from config" }])
		const bh = new BHZAI()
		const { plugin } = createMcpPlugin({
			servers: [{ url: "https://example.com/mcp", name: "preset" }],
		})
		bh.use(plugin)

		await bh.init()

		expect(bh.listTools().map((t) => t.name)).toContain("mcp__preset__declared")
	})

	it("forwards plugin-level clientOptions to every client it constructs", async () => {
		const stub = stubMcpServer()
		const bh = new BHZAI()
		const { plugin } = createMcpPlugin({
			clientOptions: { roots: { getRoots: () => [] } },
		})
		bh.use(plugin)
		await bh.init()
		await bh.addMcp({ url: "https://example.com/mcp", name: "srv" })

		// Capability opt-ins are advertised in the handshake, so the initialize
		// request body is where a forwarded option becomes observable.
		const initCall = stub.fetch.mock.calls.find(
			(call) => JSON.parse(call[1].body as string).method === "initialize",
		)
		const params = JSON.parse(initCall?.[1].body as string).params
		expect(params.capabilities).toHaveProperty("roots")
	})

	it("lets per-attach options override the plugin-level defaults", async () => {
		const bh = new BHZAI()
		const { plugin } = createMcpPlugin({ clientOptions: { callTimeoutMs: 60_000 } })
		bh.use(plugin)
		await bh.init()

		// A 1ms timeout passed per-attach must beat the plugin's 60s default:
		// the tools/call below can only time out if the override took effect.
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_url: string, init: RequestInit): Promise<Response> => {
				const body = JSON.parse(init.body as string)
				const json = (result: unknown): Response =>
					new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), {
						status: 200,
						headers: { "Content-Type": "application/json" },
					})
				if (body.method === "initialize") {
					return json({
						protocolVersion: "2025-11-25",
						capabilities: {},
						serverInfo: { name: "stub", version: "1" },
					})
				}
				if (body.method === "tools/list") {
					return json({
						tools: [{ name: "slow", description: "d", inputSchema: { type: "object" } }],
					})
				}
				if (body.method === "tools/call") {
					// Never settles on its own — only the timeout can end it.
					return new Promise<Response>(() => {})
				}
				return new Response(null, { status: 202 })
			}),
		)

		await bh.addMcp(
			{ url: "https://example.com/mcp", name: "srv" },
			{ callTimeoutMs: 1, autoApproveTools: true },
		)
		const tool = bh.listTools().find((t) => t.name === "mcp__srv__slow")

		await expect(
			tool?.execute({
				conversation: undefined,
				params: {},
				toolCallId: "tc1",
				signal: new AbortController().signal,
				progress: vi.fn(),
			}),
		).rejects.toThrow(/timed out after 1ms/)
	})

	it("honors a custom plugin name for activation toggles", async () => {
		stubMcpServer()
		const bh = new BHZAI()
		const { plugin } = createMcpPlugin({ name: "mcp-internal" })
		bh.use(plugin)
		await bh.init()

		expect(bh.listPlugins().map((p) => p.name)).toContain("mcp-internal")
	})

	it("refuses to bind one plugin instance to two kernels", async () => {
		stubMcpServer()
		const { plugin } = createMcpPlugin()
		const first = new BHZAI()
		const second = new BHZAI()
		first.use(plugin)
		await first.init()

		second.use(plugin)
		await expect(second.init()).rejects.toThrow(/already bound to a different BHZAI instance/)
	})
})

// ---------------------------------------------------------------------------
// End-to-end: manager detach against a real kernel.
// ---------------------------------------------------------------------------

describe("createMcpPlugin — detach through the real kernel", () => {
	it("removes the server's tools from bh.listTools() on manager.remove()", async () => {
		stubMcpServer([
			{ name: "a", description: "tool a" },
			{ name: "b", description: "tool b" },
		])
		const bh = new BHZAI()
		const { plugin, manager } = createMcpPlugin()
		bh.use(plugin)
		await bh.init()
		const state = await manager.add({ url: "https://example.com/mcp", name: "srv" })
		expect(bh.listTools()).toHaveLength(2)

		await manager.remove(state.id)

		expect(bh.listTools()).toHaveLength(0)
		expect(manager.list()).toEqual([])
	})
})
