// TASK_0010 — '/slash'-command registry tests (§ 6).
//
// These tests cover only the registry's storage + shadowing behavior and the
// `listCommands()` accessor. They do NOT parse raw user input, dispatch from
// any CLI/chat host loop, or wire the capability-object `commands:` key — all
// of that belongs to a future host-integration task and to TASK_0003/0005's
// `use()`/`init()` processing.

import { describe, expect, it, vi } from "vitest"

import type { BHZAICommandContext, BHZAICommandDefinition } from "../types/index.js"
import { CommandRegistry } from "./commands.js"

/** Build a minimal valid command definition with overridable fields. */
function makeCommand(overrides: Partial<BHZAICommandDefinition> = {}): BHZAICommandDefinition {
	return {
		description: "a test command",
		handler: async () => "ok",
		...overrides,
	}
}

/** A minimal `BHZAICommandContext` fixture for handler-invocation tests. */
const mockCtx: BHZAICommandContext = {}

describe("CommandRegistry.addCommand", () => {
	it("registers a command that is retrievable via listCommands()", () => {
		const registry = new CommandRegistry()
		const def = makeCommand({ description: "echoes" })
		registry.addCommand("foo", def)
		const listed = registry.listCommands()
		expect(listed).toHaveLength(1)
		expect(listed[0].name).toBe("foo")
		expect(listed[0].def).toBe(def) // exact reference + field match
	})

	it("the registered handler is invoked with (args, ctx) when run", async () => {
		const registry = new CommandRegistry()
		const handler = vi.fn(
			async (_args: string[], _ctx: BHZAICommandContext): Promise<unknown> => "ran",
		)
		registry.addCommand("foo", { description: "d", handler })
		// Simulated host dispatch: the test directly calls the stored handler
		// (no CLI/chat wiring exists yet to dispatch through).
		const entry = registry.listCommands().find((c) => c.name === "foo")
		expect(entry).toBeDefined()
		await entry?.def.handler(["bar", "baz"], mockCtx)
		expect(handler).toHaveBeenCalledTimes(1)
		expect(handler.mock.calls[0][0]).toEqual(["bar", "baz"])
		expect(handler.mock.calls[0][1]).toBe(mockCtx)
	})
})

describe("CommandRegistry.addCommand — complete hook", () => {
	it("complete(prefix) is callable and returns whatever the implementation returns", async () => {
		const registry = new CommandRegistry()
		const complete = vi.fn(async (_prefix: string): Promise<unknown> => ["bar", "baz"])
		registry.addCommand("foo", { description: "d", handler: async () => undefined, complete })
		const entry = registry.listCommands().find((c) => c.name === "foo")
		expect(entry?.def.complete).toBeDefined()
		const result = await entry?.def.complete?.("b")
		expect(complete).toHaveBeenCalledTimes(1)
		expect(complete.mock.calls[0][0]).toBe("b")
		expect(result).toEqual(["bar", "baz"])
	})

	it("omitting complete entirely does not throw and the stored def.complete is undefined", () => {
		const registry = new CommandRegistry()
		registry.addCommand("foo", { description: "d", handler: async () => undefined })
		expect(() => registry.listCommands()).not.toThrow()
		const entry = registry.listCommands().find((c) => c.name === "foo")
		expect(entry?.def.complete).toBeUndefined()
		// Callers must check for its presence before invoking it.
		expect(entry?.def.complete).toBeUndefined()
	})
})

describe("CommandRegistry shadowing (same name)", () => {
	it("registering a second command with the same name replaces the first (last-registration-wins)", () => {
		const registry = new CommandRegistry()
		const defA = makeCommand({ description: "first" })
		const defB = makeCommand({ description: "second" })
		registry.addCommand("foo", defA)
		registry.addCommand("foo", defB)
		const listed = registry.listCommands()
		expect(listed).toHaveLength(1)
		expect(listed[0].name).toBe("foo")
		expect(listed[0].def).toBe(defB) // later registration, not defA
		expect(listed[0].def.description).toBe("second")
	})
})

describe("CommandRegistry — async handler return", () => {
	it("a handler that returns a Promise resolves correctly when awaited", async () => {
		const registry = new CommandRegistry()
		registry.addCommand("async-cmd", {
			description: "async",
			handler: async () => 42,
		})
		const entry = registry.listCommands().find((c) => c.name === "async-cmd")
		const result = await entry?.def.handler([], mockCtx)
		expect(result).toBe(42)
	})
})

describe("CommandRegistry accessors", () => {
	it("get returns the stored def by name, undefined if absent", () => {
		const registry = new CommandRegistry()
		const def = makeCommand()
		registry.addCommand("foo", def)
		expect(registry.get("foo")).toBe(def)
		expect(registry.get("nope")).toBeUndefined()
	})

	it("size reports the number of registered commands and is unaffected by shadowing", () => {
		const registry = new CommandRegistry()
		expect(registry.size).toBe(0)
		registry.addCommand("a", makeCommand())
		registry.addCommand("b", makeCommand())
		expect(registry.size).toBe(2)
		// Shadowing does not increase size.
		registry.addCommand("a", makeCommand({ description: "replaced" }))
		expect(registry.size).toBe(2)
	})

	it("listCommands returns a fresh array each call so mutating it does not affect later calls", () => {
		const registry = new CommandRegistry()
		registry.addCommand("a", makeCommand())
		const first = registry.listCommands()
		first.push({ name: "injected", def: makeCommand() })
		const second = registry.listCommands()
		expect(second).toHaveLength(1)
		expect(second[0].name).toBe("a")
	})
})
