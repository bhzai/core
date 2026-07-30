// TASK_0008 — tool registry tests (§ 9).
//
// These tests cover only the registry's storage + registration-event behavior
// and the pure `normalizeToolResult` helper. They do NOT call `execute()`,
// validate arguments against `inputSchema`, or exercise the agent-loop
// tool-invocation pipeline (TASK_0026's scope).

import { describe, expect, it, vi } from "vitest"

import { EventBus } from "../core/event-bus.js"
import type { BHZAIToolDefinition, CallToolResult } from "../types/index.js"
import { TOOL_NAME_PATTERN, ToolRegistry, normalizeToolResult } from "./registry.js"

/** Build a minimal valid tool definition with overridable fields. */
function makeTool(overrides: Partial<BHZAIToolDefinition> = {}): BHZAIToolDefinition {
	return {
		name: "test-tool",
		description: "a test tool",
		inputSchema: { type: "object", properties: {} },
		execute: async () => "ok",
		...overrides,
	}
}

/** Fresh registry + bus pair per test, isolated from any other bus state. */
function freshRegistry(): { registry: ToolRegistry; bus: EventBus } {
	const bus = new EventBus()
	const registry = new ToolRegistry(bus)
	return { registry, bus }
}

/**
 * Flush the EventBus's microtask/FIFO chain. The registry fires
 * `tool.registered`/`tool.removed` via fire-and-forget `bus.dispatch(...)`
 * (the kernel bypass), which schedules onto the bus's global promise chain.
 * A single `await Promise.resolve()` only advances one microtask; a macrotask
 * boundary (`setTimeout(0)`) drains all pending microtasks so listeners have
 * run by the time the assertion executes.
 */
async function flush(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 0))
}

describe("ToolRegistry.addTool — object form", () => {
	it("registers a tool and it appears (by exact field match) in listTools()", () => {
		const { registry } = freshRegistry()
		const def = makeTool({
			name: "echo",
			description: "echoes",
			inputSchema: { type: "object" },
			tags: ["util"],
		})
		registry.addTool(def)
		const listed = registry.listTools()
		expect(listed).toHaveLength(1)
		expect(listed[0]).toBe(def) // exact reference + field match
	})
})

describe("ToolRegistry.addTool — sugar form", () => {
	it("stores inputSchema strictly equal to the schema passed in", () => {
		const { registry } = freshRegistry()
		const schema = { type: "object", properties: { x: { type: "number" } } }
		const execute = async () => "ok"
		registry.addTool("sugar-tool", schema, execute)
		const listed = registry.listTools()
		expect(listed).toHaveLength(1)
		expect(listed[0].name).toBe("sugar-tool")
		expect(listed[0].inputSchema).toBe(schema) // strict reference equality
	})

	it("defaults description to the empty string (sugar-form assumption)", () => {
		const { registry } = freshRegistry()
		registry.addTool("sugar-tool", { type: "object" }, async () => undefined)
		expect(registry.listTools()[0].description).toBe("")
	})
})

describe("ToolRegistry shadowing", () => {
	it("registering a second tool with the same name replaces the first", () => {
		const { registry } = freshRegistry()
		const first = makeTool({ name: "dup", description: "first" })
		const second = makeTool({ name: "dup", description: "second" })
		registry.addTool(first)
		registry.addTool(second)
		const listed = registry.listTools()
		expect(listed).toHaveLength(1)
		expect(listed[0].description).toBe("second")
	})

	it("shadowing does NOT fire tool.removed", async () => {
		const { registry, bus } = freshRegistry()
		const removed = vi.fn()
		bus.on("tool.removed", removed)
		registry.addTool(makeTool({ name: "dup", description: "first" }))
		// Drain the tool.registered dispatch from the first addTool before
		// shadowing, so the removed-listener assertion is not muddied by
		// pending dispatches.
		await flush()
		registry.addTool(makeTool({ name: "dup", description: "second" }))
		await flush()
		expect(removed).not.toHaveBeenCalled()
	})

	it("shadowing DOES fire tool.registered exactly once for the new registration", async () => {
		const { registry, bus } = freshRegistry()
		const registered = vi.fn()
		bus.on("tool.registered", registered)
		registry.addTool(makeTool({ name: "dup", description: "first" }))
		await flush()
		registered.mockClear()
		registry.addTool(makeTool({ name: "dup", description: "second" }))
		await flush()
		expect(registered).toHaveBeenCalledTimes(1)
		expect(registered.mock.calls[0][0]).toEqual({
			tool: expect.objectContaining({ description: "second" }),
		})
	})
})

describe("ToolRegistry.removeTool", () => {
	it("removes a previously-registered tool and fires tool.removed with { tool }", async () => {
		const { registry, bus } = freshRegistry()
		const def = makeTool({ name: "gone" })
		registry.addTool(def)
		await flush() // drain tool.registered
		const removed = vi.fn()
		bus.on("tool.removed", removed)
		registry.removeTool("gone")
		await flush()
		expect(registry.listTools()).toHaveLength(0)
		expect(removed).toHaveBeenCalledTimes(1)
		expect(removed.mock.calls[0][0].tool.name).toBe("gone")
		expect(removed.mock.calls[0][0].tool).toBe(def)
	})

	it("removeTool on a name that was never registered is a no-op (no throw, no event)", async () => {
		const { registry, bus } = freshRegistry()
		const removed = vi.fn()
		bus.on("tool.removed", removed)
		expect(() => registry.removeTool("never-there")).not.toThrow()
		await flush()
		expect(removed).not.toHaveBeenCalled()
	})
})

describe("ToolRegistry name validation", () => {
	it("rejects a name containing a space synchronously", () => {
		const { registry } = freshRegistry()
		expect(() => registry.addTool(makeTool({ name: "my tool" }))).toThrow()
	})

	it("rejects a name exceeding 128 characters synchronously", () => {
		const { registry } = freshRegistry()
		const longName = "a".repeat(129)
		expect(() => registry.addTool(makeTool({ name: longName }))).toThrow()
	})

	it("rejects an empty string name synchronously (lower bound of 1–128)", () => {
		const { registry } = freshRegistry()
		expect(() => registry.addTool(makeTool({ name: "" }))).toThrow()
	})

	it("accepts a 128-character name (upper bound inclusive)", () => {
		const { registry } = freshRegistry()
		const maxName = "a".repeat(128)
		registry.addTool(makeTool({ name: maxName }))
		expect(registry.listTools()).toHaveLength(1)
	})

	it("the validation regex is exactly /^[a-zA-Z0-9_.-]+$/", () => {
		expect(TOOL_NAME_PATTERN.source).toBe("^[a-zA-Z0-9_.-]+$")
	})

	it("rejects names with punctuation outside the allowed set", () => {
		const { registry } = freshRegistry()
		for (const bad of ["with/slash", "with:colon", "with(paren)", "with+plus"]) {
			expect(() => registry.addTool(makeTool({ name: bad }))).toThrow()
		}
	})
})

describe("normalizeToolResult", () => {
	it("wraps a string as { content: [{ type: 'text', text }] }", () => {
		expect(normalizeToolResult("hello")).toEqual({
			content: [{ type: "text", text: "hello" }],
		})
	})

	it("returns { content: [] } for undefined (documented empty-array choice)", () => {
		expect(normalizeToolResult(undefined)).toEqual({ content: [] })
	})

	it("returns the same CallToolResult object unchanged (reference equality)", () => {
		const result: CallToolResult = {
			content: [{ type: "text", text: "pre" }],
			isError: false,
		}
		expect(normalizeToolResult(result)).toBe(result) // reference, not a clone
	})
})

describe("ToolRegistry.listTools — snapshot freshness", () => {
	it("returns a fresh array each call so mutating it does not affect later calls", () => {
		const { registry } = freshRegistry()
		registry.addTool(makeTool({ name: "a" }))
		const first = registry.listTools()
		first.push(makeTool({ name: "injected" }))
		const second = registry.listTools()
		expect(second).toHaveLength(1)
		expect(second[0].name).toBe("a")
	})
})

describe("ToolRegistry.listTools — minimal filter subset", () => {
	it("no filter returns everything", () => {
		const { registry } = freshRegistry()
		registry.addTool(makeTool({ name: "a", tags: ["x"] }))
		registry.addTool(makeTool({ name: "b", tags: ["y"] }))
		expect(registry.listTools()).toHaveLength(2)
	})

	it("allow-list keeps only listed names", () => {
		const { registry } = freshRegistry()
		registry.addTool(makeTool({ name: "a" }))
		registry.addTool(makeTool({ name: "b" }))
		registry.addTool(makeTool({ name: "c" }))
		const listed = registry.listTools({ allow: ["a", "c"] })
		expect(listed.map((t) => t.name).sort()).toEqual(["a", "c"])
	})

	it("deny-list drops listed names", () => {
		const { registry } = freshRegistry()
		registry.addTool(makeTool({ name: "a" }))
		registry.addTool(makeTool({ name: "b" }))
		const listed = registry.listTools({ deny: ["a"] })
		expect(listed.map((t) => t.name)).toEqual(["b"])
	})

	it("tags filter keeps only tools with at least one matching tag", () => {
		const { registry } = freshRegistry()
		registry.addTool(makeTool({ name: "a", tags: ["util", "safe"] }))
		registry.addTool(makeTool({ name: "b", tags: ["unsafe"] }))
		const listed = registry.listTools({ tags: ["util"] })
		expect(listed.map((t) => t.name)).toEqual(["a"])
	})

	it("excludeTags drops tools with any matching tag", () => {
		const { registry } = freshRegistry()
		registry.addTool(makeTool({ name: "a", tags: ["safe"] }))
		registry.addTool(makeTool({ name: "b", tags: ["unsafe"] }))
		const listed = registry.listTools({ excludeTags: ["unsafe"] })
		expect(listed.map((t) => t.name)).toEqual(["a"])
	})
})

describe("ToolRegistry.register (ToolRegistrar seam)", () => {
	it("maps the decorator { name, schema, execute } shape onto addTool sugar form", () => {
		const { registry } = freshRegistry()
		const schema = { type: "object" }
		const exec = (..._args: unknown[]) => "decorated"
		registry.register({ name: "decorated-tool", schema, execute: exec })
		const listed = registry.listTools()
		expect(listed).toHaveLength(1)
		expect(listed[0].name).toBe("decorated-tool")
		expect(listed[0].inputSchema).toBe(schema)
		expect(listed[0].description).toBe("") // sugar-form default
	})
})

describe("ToolRegistry.get / size accessors", () => {
	it("get returns the stored definition by name, undefined if absent", () => {
		const { registry } = freshRegistry()
		const def = makeTool({ name: "lookup" })
		registry.addTool(def)
		expect(registry.get("lookup")).toBe(def)
		expect(registry.get("nope")).toBeUndefined()
	})

	it("size reports the number of registered tools", () => {
		const { registry } = freshRegistry()
		expect(registry.size).toBe(0)
		registry.addTool(makeTool({ name: "a" }))
		registry.addTool(makeTool({ name: "b" }))
		expect(registry.size).toBe(2)
		registry.removeTool("a")
		expect(registry.size).toBe(1)
	})
})
