import { describe, expect, it, vi } from "vitest"
import { createHarness } from "../kernel/kernel"
import type { CallToolResult } from "../types/content"
import {
	executeTool,
	normalizeToolResult,
	parseToolArguments,
	runWithAbort,
	validateToolParams,
} from "./execution"
import { toolsPlugin } from "./plugin"
import { ToolRegistry } from "./registry"
import type {
	ToolDefinition,
	ToolPostExecuteContext,
	ToolPreExecuteContext,
	ToolPreExecutePayload,
	ToolService,
} from "./types"

function getBlockText(block: unknown): string {
	return (block as { text: string }).text
}

describe("ToolRegistry", () => {
	it("registers, retrieves, and checks existence of tools", () => {
		const registry = new ToolRegistry()
		const tool: ToolDefinition = {
			name: "calculator",
			description: "Calculates numbers",
			inputSchema: { type: "object", properties: { expr: { type: "string" } } },
			execute: vi.fn(),
		}

		expect(registry.has("calculator")).toBe(false)
		expect(registry.get("calculator")).toBeUndefined()

		const dispose = registry.register(tool)
		expect(registry.has("calculator")).toBe(true)
		expect(registry.get("calculator")).toBe(tool)
		expect(registry.list()).toEqual([tool])

		dispose()
		expect(registry.has("calculator")).toBe(false)
		expect(registry.get("calculator")).toBeUndefined()
		expect(registry.list()).toEqual([])

		// Redundant dispose call is a safe no-op
		dispose()
	})

	it("supports LIFO shadowing of tools with the same name", () => {
		const registry = new ToolRegistry()
		const tool1: ToolDefinition = {
			name: "search",
			description: "Version 1",
			inputSchema: { type: "object" },
			execute: vi.fn(),
		}
		const tool2: ToolDefinition = {
			name: "search",
			description: "Version 2",
			inputSchema: { type: "object" },
			execute: vi.fn(),
		}

		const dispose1 = registry.register(tool1)
		expect(registry.get("search")?.description).toBe("Version 1")

		const dispose2 = registry.register(tool2)
		expect(registry.get("search")?.description).toBe("Version 2")
		expect(registry.list().length).toBe(1)

		// Disposing shadowed tool restores the original
		dispose2()
		expect(registry.get("search")?.description).toBe("Version 1")

		dispose1()
		expect(registry.has("search")).toBe(false)
	})

	it("filters tools by allow, deny, tags, and excludeTags", () => {
		const registry = new ToolRegistry()
		const toolA: ToolDefinition = {
			name: "read_file",
			description: "Read",
			inputSchema: { type: "object" },
			tags: ["fs", "readonly"],
			execute: vi.fn(),
		}
		const toolB: ToolDefinition = {
			name: "write_file",
			description: "Write",
			inputSchema: { type: "object" },
			tags: ["fs", "destructive"],
			execute: vi.fn(),
		}
		const toolC: ToolDefinition = {
			name: "web_search",
			description: "Search",
			inputSchema: { type: "object" },
			tags: ["net"],
			execute: vi.fn(),
		}

		registry.register(toolA)
		registry.register(toolB)
		registry.register(toolC)

		expect(registry.list({ allow: ["read_file", "web_search"] }).map((t) => t.name)).toEqual([
			"read_file",
			"web_search",
		])

		expect(registry.list({ deny: ["write_file"] }).map((t) => t.name)).toEqual([
			"read_file",
			"web_search",
		])

		expect(registry.list({ tags: ["fs"] }).map((t) => t.name)).toEqual(["read_file", "write_file"])

		expect(registry.list({ excludeTags: ["destructive"] }).map((t) => t.name)).toEqual([
			"read_file",
			"web_search",
		])
	})

	it("projects tools to wire format for model drivers", () => {
		const registry = new ToolRegistry()
		registry.register({
			name: "echo",
			description: "Echo message",
			inputSchema: { type: "object", properties: { text: { type: "string" } } },
			execute: vi.fn(),
			serial: true,
			tags: ["utility"],
		})

		const wire = registry.projectWireTools()
		expect(wire).toEqual([
			{
				name: "echo",
				description: "Echo message",
				inputSchema: { type: "object", properties: { text: { type: "string" } } },
			},
		])
	})
})

describe("normalizeToolResult", () => {
	it("normalizes strings into text content blocks", () => {
		expect(normalizeToolResult("hello world")).toEqual({
			content: [{ type: "text", text: "hello world" }],
		})
	})

	it("normalizes undefined or null into empty content array", () => {
		expect(normalizeToolResult(undefined)).toEqual({ content: [] })
		expect(normalizeToolResult(null as unknown as undefined)).toEqual({ content: [] })
	})

	it("preserves already-valid CallToolResult objects", () => {
		const original = { content: [{ type: "text" as const, text: "ok" }], isError: false }
		expect(normalizeToolResult(original)).toBe(original)
	})

	it("stringifies other types as text content", () => {
		expect(normalizeToolResult(42 as unknown as undefined)).toEqual({
			content: [{ type: "text", text: "42" }],
		})
	})
})

describe("parseToolArguments", () => {
	it("parses valid JSON string into an object", () => {
		const res = parseToolArguments("test", '{"query":"vitest"}')
		expect(res.params).toEqual({ query: "vitest" })
		expect(res.error).toBeUndefined()
	})

	it("handles object input and undefined/null input", () => {
		expect(parseToolArguments("test", { a: 1 }).params).toEqual({ a: 1 })
		expect(parseToolArguments("test", undefined).params).toEqual({})
		expect(parseToolArguments("test", null).params).toEqual({})
	})

	it("rejects non-object JSON and malformed JSON", () => {
		expect(parseToolArguments("test", "invalid-json").error).toContain(
			'Invalid JSON arguments for tool "test"',
		)
		expect(parseToolArguments("test", "[1, 2, 3]").error).toContain(
			'Invalid arguments for tool "test": expected JSON object, got array',
		)
		expect(parseToolArguments("test", 123).error).toContain(
			'Invalid arguments type for tool "test"',
		)
	})
})

describe("validateToolParams", () => {
	it("validates parameters against JSON schema", () => {
		const schema = {
			type: "object",
			properties: { age: { type: "number", minimum: 0 } },
			required: ["age"],
		}

		expect(validateToolParams(schema, { age: 25 })).toBeUndefined()
		expect(validateToolParams(schema, { age: -5 })).toContain("must be >= 0")
		expect(validateToolParams(schema, {})).toContain("required")
		expect(validateToolParams(undefined, { whatever: true })).toBeUndefined()
	})
})

describe("runWithAbort", () => {
	it("runs immediately if no signal provided", async () => {
		const res = await runWithAbort(() => "ok")
		expect(res).toBe("ok")
	})

	it("throws if signal is already aborted", async () => {
		const controller = new AbortController()
		controller.abort()
		await expect(runWithAbort(() => "ok", controller.signal)).rejects.toThrow(
			"Tool execution aborted.",
		)
	})

	it("aborts when signal is triggered while running", async () => {
		const controller = new AbortController()
		const longTask = () =>
			new Promise<string>((resolve) => {
				setTimeout(() => resolve("done"), 100)
			})

		const promise = runWithAbort(longTask, controller.signal)
		controller.abort()

		await expect(promise).rejects.toThrow("Tool execution aborted.")
	})
})

describe("executeTool pipeline", () => {
	it("returns error result when tool is not found", async () => {
		const harness = await createHarness()
		const registry = new ToolRegistry()
		const res = await executeTool(registry, harness.ctx.events, {
			callId: "c1",
			toolName: "nonexistent",
			arguments: {},
		})

		expect(res.isError).toBe(true)
		expect(res.content[0]).toEqual({
			type: "text",
			text: 'Tool "nonexistent" not found.',
		})
	})

	it("returns error result on schema validation failure", async () => {
		const harness = await createHarness()
		const registry = new ToolRegistry()
		registry.register({
			name: "add",
			description: "Add two numbers",
			inputSchema: {
				type: "object",
				properties: { a: { type: "number" }, b: { type: "number" } },
				required: ["a", "b"],
			},
			execute: vi.fn(),
		})

		const res = await executeTool(registry, harness.ctx.events, {
			callId: "c2",
			toolName: "add",
			arguments: { a: "not-a-number" },
		})

		expect(res.isError).toBe(true)
		expect(getBlockText(res.content[0])).toContain('Schema validation failed for tool "add"')
	})

	it("executes successfully and transforms through waterfalls", async () => {
		const harness = await createHarness()
		const registry = new ToolRegistry()
		registry.register({
			name: "greet",
			description: "Greets a person",
			inputSchema: {
				type: "object",
				properties: { name: { type: "string" } },
			},
			execute: ({ params }) => `Hello, ${(params as { name: string }).name}!`,
		})

		// Pre-execute middleware rewrites argument
		harness.ctx.events.waterfall<ToolPreExecutePayload, ToolPreExecuteContext>(
			"tool/pre-execute",
			async (payload, _ctx, next) => {
				const updated = {
					...payload,
					params: { name: (payload.params.name as string).toUpperCase() },
				}
				return await next(updated)
			},
		)

		// Post-execute middleware adds banner
		harness.ctx.events.waterfall<CallToolResult, ToolPostExecuteContext>(
			"tool/post-execute",
			async (result, _ctx, next) => {
				const text = getBlockText(result.content[0])
				return await next({
					content: [{ type: "text", text: `[BANNER] ${text}` }],
				})
			},
		)

		const res = await executeTool(registry, harness.ctx.events, {
			callId: "c3",
			toolName: "greet",
			arguments: '{"name":"lucas"}',
		})

		expect(res.isError).toBeUndefined()
		expect(res.content[0]).toEqual({
			type: "text",
			text: "[BANNER] Hello, LUCAS!",
		})
	})

	it("supports blocking in tool/pre-execute waterfall", async () => {
		const harness = await createHarness()
		const registry = new ToolRegistry()
		const executeFn = vi.fn()
		registry.register({
			name: "delete_database",
			description: "Dangerous",
			inputSchema: { type: "object" },
			execute: executeFn,
		})

		harness.ctx.events.waterfall<ToolPreExecutePayload, ToolPreExecuteContext>(
			"tool/pre-execute",
			async (payload) => {
				return {
					...payload,
					block: true,
					reason: "Policy violation: database deletion not allowed.",
				}
			},
		)

		const res = await executeTool(registry, harness.ctx.events, {
			callId: "c4",
			toolName: "delete_database",
			arguments: {},
		})

		expect(res.isError).toBe(true)
		expect(getBlockText(res.content[0])).toContain("Policy violation")
		expect(executeFn).not.toHaveBeenCalled()
	})

	it("catches executor errors and handles abort signal", async () => {
		const harness = await createHarness()
		const registry = new ToolRegistry()
		registry.register({
			name: "thrower",
			description: "Throws",
			inputSchema: { type: "object" },
			execute: () => {
				throw new Error("Disk full")
			},
		})

		const res = await executeTool(registry, harness.ctx.events, {
			callId: "c5",
			toolName: "thrower",
			arguments: {},
		})

		expect(res.isError).toBe(true)
		expect(getBlockText(res.content[0])).toContain("Tool error: Disk full")

		// Pre-aborted signal
		const controller = new AbortController()
		controller.abort()
		const abortRes = await executeTool(registry, harness.ctx.events, {
			callId: "c6",
			toolName: "thrower",
			arguments: {},
			signal: controller.signal,
		})

		expect(abortRes.isError).toBe(true)
		expect(getBlockText(abortRes.content[0])).toBe("Tool execution aborted.")

		// Malformed JSON arguments
		const malformedRes = await executeTool(registry, harness.ctx.events, {
			callId: "c7",
			toolName: "thrower",
			arguments: "{not-valid-json",
		})
		expect(malformedRes.isError).toBe(true)
		expect(getBlockText(malformedRes.content[0])).toContain("Invalid JSON arguments")

		// Async rejection while signal is provided but not aborted
		const activeSignalController = new AbortController()
		const rejectedRes = await executeTool(registry, harness.ctx.events, {
			callId: "c8",
			toolName: "thrower",
			arguments: {},
			signal: activeSignalController.signal,
		})
		expect(rejectedRes.isError).toBe(true)
		expect(getBlockText(rejectedRes.content[0])).toContain("Tool error: Disk full")
	})
})

describe("toolsPlugin", () => {
	it("claims ctx.tools and integrates with harness lifecycle", async () => {
		const harness = await createHarness({ plugins: [toolsPlugin] })
		const tools = harness.ctx.tools as ToolService

		expect(tools).toBeDefined()
		expect(tools.list()).toEqual([])

		const unregister = tools.register({
			name: "ping",
			description: "Ping",
			inputSchema: { type: "object" },
			execute: () => "pong",
		})

		expect(tools.has("ping")).toBe(true)
		expect(tools.get("ping")?.name).toBe("ping")
		expect(tools.projectWireTools()).toEqual([
			{
				name: "ping",
				description: "Ping",
				inputSchema: { type: "object" },
			},
		])

		const res = await tools.execute({
			callId: "p1",
			toolName: "ping",
			arguments: {},
		})

		expect(res.content[0]).toEqual({ type: "text", text: "pong" })

		unregister()
		expect(tools.has("ping")).toBe(false)
	})
})
