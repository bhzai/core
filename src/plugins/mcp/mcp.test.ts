import { afterEach, describe, expect, it, vi } from "vitest"
import { createHarness } from "../../kernel"
import type { PluginContext } from "../../kernel/types"
import { toolsPlugin } from "../../tools/plugin"
import type { ToolService } from "../../tools/types"
import { mcpPlugin } from "./plugin"
import type { McpServerConfig, McpService } from "./types"

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: {
			"Content-Type": "application/json",
			"Mcp-Session-Id": "test-session-id",
		},
	})
}

function acceptedResponse(): Response {
	return new Response(null, { status: 202 })
}

function initSuccessResponse(): unknown {
	return {
		jsonrpc: "2.0",
		id: 1,
		result: {
			protocolVersion: "2025-11-25",
			capabilities: { tools: { listChanged: false } },
			serverInfo: { name: "test-mcp-server", version: "1.0.0" },
		},
	}
}

function toolsListSuccessResponse(): unknown {
	return {
		jsonrpc: "2.0",
		id: 2,
		result: {
			tools: [
				{
					name: "echo",
					description: "Echoes message back",
					inputSchema: {
						type: "object",
						properties: { message: { type: "string" } },
						required: ["message"],
					},
				},
			],
		},
	}
}

function toolCallSuccessResponse(): unknown {
	return {
		jsonrpc: "2.0",
		id: 3,
		result: {
			content: [{ type: "text", text: "echo: test" }],
			isError: false,
		},
	}
}

afterEach(() => {
	vi.unstubAllGlobals()
	vi.restoreAllMocks()
})

describe("mcpPlugin", () => {
	it("throws if tools dependency is missing", async () => {
		await expect(createHarness({ plugins: [mcpPlugin] })).rejects.toThrow(
			'Plugin "mcp" requires missing dependency "tools".',
		)
	})

	it("throws if setup is invoked without claimed tools service", async () => {
		const fakeCtx = {
			tools: undefined,
			events: { emit: vi.fn() },
			claim: vi.fn(),
		} as unknown as PluginContext
		await expect(mcpPlugin.setup(fakeCtx)).rejects.toThrow(
			"McpService requires the tools service to be registered.",
		)
	})

	it("attaches server, projects tools, executes tool, and unregisters on detach", async () => {
		let callCount = 0
		const mockFetch = vi.fn().mockImplementation(async () => {
			callCount++
			if (callCount === 1) {
				// initialize
				return jsonResponse(initSuccessResponse())
			}
			if (callCount === 2) {
				// notifications/initialized
				return acceptedResponse()
			}
			if (callCount === 3) {
				// tools/list
				return jsonResponse(toolsListSuccessResponse())
			}
			if (callCount === 4) {
				// tools/call
				return jsonResponse(toolCallSuccessResponse())
			}
			return acceptedResponse()
		})
		vi.stubGlobal("fetch", mockFetch)

		const harness = await createHarness({
			plugins: [
				toolsPlugin,
				{
					...mcpPlugin,
					setup(ctx) {
						return mcpPlugin.setup(ctx, {
							clientOptions: { autoApproveTools: true },
						})
					},
				},
			],
		})

		const mcp = harness.ctx.mcp as McpService
		const tools = harness.ctx.tools as ToolService
		expect(mcp).toBeDefined()
		expect(tools).toBeDefined()

		const serverConfig: McpServerConfig = {
			name: "server1",
			url: "https://example.com/mcp",
		}

		const state = await mcp.attach(serverConfig)
		expect(state.status).toBe("connected")
		expect(state.serverName).toBe("server1")
		expect(state.tools).toHaveLength(1)
		expect(state.tools[0].shortName).toBe("echo")
		expect(state.tools[0].name).toBe("mcp__server1__echo")

		// Tool should be in ctx.tools
		expect(tools.has("mcp__server1__echo")).toBe(true)

		// Execute tool through ctx.tools
		const execResult = await tools.execute({
			callId: "call-1",
			toolName: "mcp__server1__echo",
			arguments: { message: "test" },
		})
		expect(execResult.isError).toBe(false)
		expect(execResult.content).toEqual([{ type: "text", text: "echo: test" }])

		// Detach server
		await mcp.detach(state.id)
		expect(tools.has("mcp__server1__echo")).toBe(false)
		expect(mcp.list()).toHaveLength(0)

		await harness.dispose()
	})

	it("handles duplicate server attachment gracefully", async () => {
		let callCount = 0
		vi.stubGlobal(
			"fetch",
			vi.fn().mockImplementation(async () => {
				callCount++
				if (callCount === 1) return jsonResponse(initSuccessResponse())
				if (callCount === 2) return acceptedResponse()
				if (callCount === 3) return jsonResponse(toolsListSuccessResponse())
				return acceptedResponse()
			}),
		)

		const harness = await createHarness({
			plugins: [
				toolsPlugin,
				{
					...mcpPlugin,
					setup(ctx) {
						return mcpPlugin.setup(ctx, {
							clientOptions: { autoApproveTools: true },
						})
					},
				},
			],
		})

		const mcp = harness.ctx.mcp as McpService
		const serverConfig: McpServerConfig = {
			name: "dup-server",
			url: "https://dup.com/mcp",
		}

		const first = await mcp.attach(serverConfig)
		expect(first.status).toBe("connected")

		const second = await mcp.attach(serverConfig)
		expect(second.status).toBe("error")
		expect(second.error?.name).toBe("McpDuplicateServerError")

		await harness.dispose()
	})

	it("captures connection errors and allows retry", async () => {
		let callCount = 0
		vi.stubGlobal(
			"fetch",
			vi.fn().mockImplementation(async () => {
				callCount++
				// First connection fails
				if (callCount === 1) {
					return new Response("Internal Server Error", { status: 500 })
				}
				// Retry connection succeeds
				if (callCount === 2) return jsonResponse(initSuccessResponse())
				if (callCount === 3) return acceptedResponse()
				if (callCount === 4) return jsonResponse(toolsListSuccessResponse())
				return acceptedResponse()
			}),
		)

		const harness = await createHarness({
			plugins: [
				toolsPlugin,
				{
					...mcpPlugin,
					setup(ctx) {
						return mcpPlugin.setup(ctx, {
							clientOptions: { autoApproveTools: true },
						})
					},
				},
			],
		})

		const mcp = harness.ctx.mcp as McpService
		const serverConfig: McpServerConfig = {
			name: "retry-server",
			url: "https://retry.com/mcp",
		}

		const failedState = await mcp.attach(serverConfig)
		expect(failedState.status).toBe("error")
		expect(failedState.error?.message).toContain("500")

		// Retry
		const retryState = await mcp.retry(failedState.id)
		expect(retryState.status).toBe("connected")
		expect(retryState.tools).toHaveLength(1)

		// Calling retry on connected server is no-op
		const againState = await mcp.retry(failedState.id)
		expect(againState.status).toBe("connected")

		await expect(mcp.retry("nonexistent")).rejects.toThrow("not found")
		await harness.dispose()
	})

	it("supports declarative servers in plugin options and subscription listener", async () => {
		let callCount = 0
		vi.stubGlobal(
			"fetch",
			vi.fn().mockImplementation(async () => {
				callCount++
				if (callCount === 1) return jsonResponse(initSuccessResponse())
				if (callCount === 2) return acceptedResponse()
				if (callCount === 3) return jsonResponse(toolsListSuccessResponse())
				return acceptedResponse()
			}),
		)

		const harness = await createHarness({
			plugins: [
				toolsPlugin,
				{
					...mcpPlugin,
					setup(ctx) {
						return mcpPlugin.setup(ctx, {
							servers: [{ name: "startup-server", url: "https://startup.com/mcp" }],
							clientOptions: { autoApproveTools: true },
						})
					},
				},
			],
		})

		const mcp = harness.ctx.mcp as McpService
		const servers = mcp.list()
		expect(servers).toHaveLength(1)
		expect(servers[0].serverName).toBe("startup-server")
		expect(mcp.get(servers[0].id)).toBeDefined()

		let notified = false
		const unsub = mcp.subscribe(() => {
			notified = true
		})
		await mcp.detach(servers[0].id)
		expect(notified).toBe(true)
		unsub()

		await harness.dispose()
	})
})
