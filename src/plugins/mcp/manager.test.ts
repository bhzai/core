// McpManager tests — observable lifecycle over `bh.addMcp()`.
//
// The manager is deliberately host-agnostic (it takes an `McpManagerHost`
// interface, not a `BHZAI`), so these tests drive it with a fake host built on
// the REAL `ToolRegistry`. That keeps `listTools`/`removeTool` honest — tool
// derivation and detach cleanup are asserted against actual registry state
// rather than a spy's call log — while letting each test decide exactly how
// `addMcp` behaves (resolve, reject, register tools, hang).

import { describe, expect, it, vi } from "vitest"

import { EventBus } from "../../core/event-bus.js"
import type { McpHandle } from "../../core/mcp-integration.js"
import { ToolRegistry } from "../../tools/registry.js"
import type { CallToolResult, McpServerConfig } from "../../types/index.js"
import { McpManager, type McpManagerHost, type McpServerState } from "./manager.js"

// ---------------------------------------------------------------------------
// Fake host.
// ---------------------------------------------------------------------------

/** A stand-in `McpClient`: records `close()` calls and `pollToolsList()` calls. */
interface FakeClient {
	serverName: string
	close: ReturnType<typeof vi.fn>
	pollToolsList: ReturnType<typeof vi.fn>
}

interface FakeHost extends McpManagerHost {
	registry: ToolRegistry
	/** Registers `tools` under `mcp__<name>__` on the next `addMcp`, like discovery would. */
	willConnect(opts?: { serverName?: string; tools?: string[] }): FakeClient
	/** Makes the next `addMcp` reject with `error`. */
	willFail(error: unknown): void
	/** The clients handed out so far, in attach order. */
	clients: FakeClient[]
}

function fakeHost(): FakeHost {
	const registry = new ToolRegistry(new EventBus())
	const clients: FakeClient[] = []
	let next: { serverName?: string; tools?: string[] } | undefined
	let failure: { error: unknown } | undefined

	function registerTool(namespacedName: string, description: string): void {
		registry.addTool({
			name: namespacedName,
			description,
			inputSchema: { type: "object" },
			execute: async (): Promise<CallToolResult> => ({ content: [], isError: false }),
		})
	}

	const host: FakeHost = {
		registry,
		clients,
		willConnect(opts) {
			next = opts ?? {}
			const client: FakeClient = {
				serverName: opts?.serverName ?? "",
				close: vi.fn(async () => undefined),
				pollToolsList: vi.fn(async () => ({ added: [], removed: [], updated: [] })),
			}
			clients.push(client)
			return client
		},
		willFail(error) {
			failure = { error }
		},
		async addMcp(config: McpServerConfig): Promise<McpHandle> {
			if (failure) {
				const { error } = failure
				failure = undefined
				throw error
			}
			const serverName = next?.serverName ?? config.name ?? "fake"
			const client = clients[clients.length - 1]
			if (!client) throw new Error("test fake: call willConnect() before addMcp()")
			client.serverName = serverName
			for (const tool of next?.tools ?? []) {
				registerTool(`mcp__${serverName}__${tool}`, `${tool} description`)
			}
			next = undefined
			return { serverName, client: client as unknown as McpHandle["client"] }
		},
		listTools: (filter) => registry.listTools(filter),
		removeTool: (name) => registry.removeTool(name),
	}
	return host
}

// ---------------------------------------------------------------------------
// add() — the happy path and its notification ordering.
// ---------------------------------------------------------------------------

describe("McpManager.add", () => {
	it("reaches connected and derives the server's tools from the registry prefix", async () => {
		const host = fakeHost()
		host.willConnect({ serverName: "github", tools: ["search_issues", "create_pr"] })
		const manager = new McpManager(host)

		const state = await manager.add({ url: "https://example.com/mcp", name: "github" })

		expect(state.status).toBe("connected")
		expect(state.serverName).toBe("github")
		expect(state.connectedAt).toBeTypeOf("number")
		expect(state.error).toBeUndefined()
		expect(state.tools).toEqual([
			{
				name: "mcp__github__search_issues",
				shortName: "search_issues",
				description: "search_issues description",
			},
			{
				name: "mcp__github__create_pr",
				shortName: "create_pr",
				description: "create_pr description",
			},
		])
	})

	it("notifies with a connecting state BEFORE the handshake settles", async () => {
		const host = fakeHost()
		host.willConnect({ serverName: "slow" })
		const manager = new McpManager(host)
		const seen: McpServerState["status"][] = []
		manager.subscribe((states) => {
			for (const s of states) seen.push(s.status)
		})

		await manager.add({ url: "https://example.com/mcp", name: "slow" })

		// The `connecting` notification is the whole point of the ordering: a UI
		// that only saw the terminal state could never render an in-flight card.
		expect(seen).toEqual(["connecting", "connected"])
	})

	it("ignores other tools in the registry that do not carry this server's prefix", async () => {
		const host = fakeHost()
		host.registry.addTool({
			name: "local_tool",
			description: "not an MCP tool",
			inputSchema: { type: "object" },
			execute: async (): Promise<CallToolResult> => ({ content: [], isError: false }),
		})
		host.willConnect({ serverName: "srv", tools: ["remote"] })
		const manager = new McpManager(host)

		const state = await manager.add({ url: "https://example.com/mcp", name: "srv" })

		expect(state.tools.map((t) => t.name)).toEqual(["mcp__srv__remote"])
	})

	it("records a failed connect as an error state instead of rejecting", async () => {
		const host = fakeHost()
		const boom = new Error("handshake exploded")
		boom.name = "McpHandshakeError"
		host.willFail(boom)
		const manager = new McpManager(host)

		const state = await manager.add({ url: "https://bad.example/mcp", name: "bad" })

		expect(state.status).toBe("error")
		expect(state.error).toMatchObject({
			name: "McpHandshakeError",
			message: "handshake exploded",
			url: "https://bad.example/mcp",
			phase: "connect",
		})
		expect(state.error?.stack).toBeTypeOf("string")
		expect(state.error?.at).toBeTypeOf("number")
	})

	it("normalizes a non-Error rejection so the UI always has a message", async () => {
		const host = fakeHost()
		host.willFail("just a string")
		const manager = new McpManager(host)

		const state = await manager.add({ url: "https://bad.example/mcp", name: "bad" })

		expect(state.error).toMatchObject({ name: "Error", message: "just a string" })
	})

	it("derives the server name from the URL hostname when config.name is omitted", async () => {
		const host = fakeHost()
		host.willConnect({ serverName: "example.com", tools: ["t"] })
		const manager = new McpManager(host)

		const state = await manager.add({ url: "https://example.com/mcp" })

		expect(state.serverName).toBe("example.com")
		expect(state.tools[0]?.name).toBe("mcp__example.com__t")
	})

	it("refuses a duplicate server name rather than shadowing the existing attach", async () => {
		const host = fakeHost()
		host.willConnect({ serverName: "dup", tools: ["a"] })
		const manager = new McpManager(host)
		await manager.add({ url: "https://one.example/mcp", name: "dup" })

		const second = await manager.add({ url: "https://two.example/mcp", name: "dup" })

		expect(second.status).toBe("error")
		expect(second.error?.name).toBe("McpDuplicateServerError")
		// The refusal is recorded, not dropped — otherwise the add would look
		// like a card that never appeared.
		expect(manager.list()).toHaveLength(2)
		// ...and the original attach is untouched.
		expect(manager.list()[0]?.status).toBe("connected")
	})
})

// ---------------------------------------------------------------------------
// retry().
// ---------------------------------------------------------------------------

describe("McpManager.retry", () => {
	it("recovers an errored entry to connected, keeping its id", async () => {
		const host = fakeHost()
		host.willFail(new Error("nope"))
		const manager = new McpManager(host)
		const failed = await manager.add({ url: "https://example.com/mcp", name: "srv" })
		expect(failed.status).toBe("error")

		host.willConnect({ serverName: "srv", tools: ["t"] })
		const retried = await manager.retry(failed.id)

		expect(retried.id).toBe(failed.id)
		expect(retried.status).toBe("connected")
		expect(retried.error).toBeUndefined()
		expect(retried.tools).toHaveLength(1)
		expect(manager.list()).toHaveLength(1)
	})

	it("is a no-op for an already-connected server", async () => {
		const host = fakeHost()
		host.willConnect({ serverName: "srv" })
		const manager = new McpManager(host)
		const state = await manager.add({ url: "https://example.com/mcp", name: "srv" })

		const again = await manager.retry(state.id)

		expect(again).toBe(state)
	})

	it("throws on an unknown id — that is a caller bug, not a server condition", async () => {
		const manager = new McpManager(fakeHost())
		await expect(manager.retry("nope")).rejects.toThrow(/no MCP server with id/)
	})
})

// ---------------------------------------------------------------------------
// refresh() — the manual stand-in for list_changed push.
// ---------------------------------------------------------------------------

describe("McpManager.refresh", () => {
	it("polls the client and picks up tools registered since the attach", async () => {
		const host = fakeHost()
		const client = host.willConnect({ serverName: "srv", tools: ["first"] })
		const manager = new McpManager(host)
		const state = await manager.add({ url: "https://example.com/mcp", name: "srv" })
		expect(state.tools).toHaveLength(1)

		// Simulate what a real `pollToolsList()` does: register the new tool.
		client.pollToolsList.mockImplementationOnce(async () => {
			host.registry.addTool({
				name: "mcp__srv__second",
				description: "second description",
				inputSchema: { type: "object" },
				execute: async (): Promise<CallToolResult> => ({ content: [], isError: false }),
			})
			return { added: ["mcp__srv__second"], removed: [], updated: [] }
		})

		const refreshed = await manager.refresh(state.id)

		expect(client.pollToolsList).toHaveBeenCalledTimes(1)
		expect(refreshed.tools.map((t) => t.shortName)).toEqual(["first", "second"])
	})

	it("records a poll failure as a refresh-phase error", async () => {
		const host = fakeHost()
		const client = host.willConnect({ serverName: "srv", tools: ["t"] })
		const manager = new McpManager(host)
		const state = await manager.add({ url: "https://example.com/mcp", name: "srv" })
		client.pollToolsList.mockRejectedValueOnce(new Error("connection dropped"))

		const refreshed = await manager.refresh(state.id)

		expect(refreshed.status).toBe("error")
		expect(refreshed.error).toMatchObject({ phase: "refresh", message: "connection dropped" })
	})

	it("does nothing for a server that is not connected", async () => {
		const host = fakeHost()
		host.willFail(new Error("nope"))
		const manager = new McpManager(host)
		const failed = await manager.add({ url: "https://example.com/mcp", name: "srv" })

		const refreshed = await manager.refresh(failed.id)

		expect(refreshed).toBe(failed)
	})
})

// ---------------------------------------------------------------------------
// remove() — detach.
// ---------------------------------------------------------------------------

describe("McpManager.remove", () => {
	it("closes the session, unregisters every namespaced tool, and drops the entry", async () => {
		const host = fakeHost()
		const client = host.willConnect({ serverName: "srv", tools: ["a", "b"] })
		const manager = new McpManager(host)
		host.registry.addTool({
			name: "local_tool",
			description: "unrelated",
			inputSchema: { type: "object" },
			execute: async (): Promise<CallToolResult> => ({ content: [], isError: false }),
		})
		const state = await manager.add({ url: "https://example.com/mcp", name: "srv" })

		await manager.remove(state.id)

		expect(client.close).toHaveBeenCalledTimes(1)
		expect(manager.list()).toEqual([])
		// The server's tools are gone; unrelated tools survive.
		expect(host.registry.listTools().map((t) => t.name)).toEqual(["local_tool"])
	})

	it("removes tools registered after the attach snapshot was taken (deferred loading)", async () => {
		const host = fakeHost()
		host.willConnect({ serverName: "srv", tools: ["list_tools"] })
		const manager = new McpManager(host)
		const state = await manager.add({ url: "https://example.com/mcp", name: "srv" })
		// A deferred attach registers its real tools lazily, long after `add()`.
		host.registry.addTool({
			name: "mcp__srv__real_tool",
			description: "registered lazily",
			inputSchema: { type: "object" },
			execute: async (): Promise<CallToolResult> => ({ content: [], isError: false }),
		})
		expect(state.tools).toHaveLength(1)

		await manager.remove(state.id)

		expect(host.registry.listTools()).toEqual([])
	})

	it("completes the local teardown even when close() rejects", async () => {
		const host = fakeHost()
		const client = host.willConnect({ serverName: "srv", tools: ["a"] })
		const manager = new McpManager(host)
		const state = await manager.add({ url: "https://example.com/mcp", name: "srv" })
		client.close.mockRejectedValueOnce(new Error("already gone"))

		await expect(manager.remove(state.id)).resolves.toBeUndefined()

		expect(manager.list()).toEqual([])
		expect(host.registry.listTools()).toEqual([])
	})

	it("throws on an unknown id", async () => {
		const manager = new McpManager(fakeHost())
		await expect(manager.remove("nope")).rejects.toThrow(/no MCP server with id/)
	})
})

// ---------------------------------------------------------------------------
// subscribe().
// ---------------------------------------------------------------------------

describe("McpManager.subscribe", () => {
	it("does not fire on subscribe, then fires on every transition", async () => {
		const host = fakeHost()
		host.willConnect({ serverName: "srv" })
		const manager = new McpManager(host)
		const listener = vi.fn()

		manager.subscribe(listener)
		expect(listener).not.toHaveBeenCalled()

		await manager.add({ url: "https://example.com/mcp", name: "srv" })

		expect(listener).toHaveBeenCalledTimes(2) // connecting, connected
	})

	it("stops notifying after unsubscribe", async () => {
		const host = fakeHost()
		host.willConnect({ serverName: "a" })
		const manager = new McpManager(host)
		const listener = vi.fn()
		const unsubscribe = manager.subscribe(listener)

		await manager.add({ url: "https://a.example/mcp", name: "a" })
		const countAfterFirst = listener.mock.calls.length
		unsubscribe()

		host.willConnect({ serverName: "b" })
		await manager.add({ url: "https://b.example/mcp", name: "b" })

		expect(listener).toHaveBeenCalledTimes(countAfterFirst)
	})

	it("isolates a throwing subscriber from the others and from the caller", async () => {
		const host = fakeHost()
		host.willConnect({ serverName: "srv" })
		const manager = new McpManager(host)
		const healthy = vi.fn()
		manager.subscribe(() => {
			throw new Error("subscriber bug")
		})
		manager.subscribe(healthy)

		const state = await manager.add({ url: "https://example.com/mcp", name: "srv" })

		expect(state.status).toBe("connected")
		expect(healthy).toHaveBeenCalledTimes(2)
	})

	it("hands every listener the full list, in insertion order", async () => {
		const host = fakeHost()
		host.willConnect({ serverName: "a" })
		const manager = new McpManager(host)
		await manager.add({ url: "https://a.example/mcp", name: "a" })

		let latest: McpServerState[] = []
		manager.subscribe((states) => {
			latest = states
		})
		host.willConnect({ serverName: "b" })
		await manager.add({ url: "https://b.example/mcp", name: "b" })

		expect(latest.map((s) => s.serverName)).toEqual(["a", "b"])
	})
})
