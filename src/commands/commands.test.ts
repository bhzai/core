import { describe, expect, it, vi } from "vitest"
import { createHarness } from "../kernel/kernel"
import { commandsPlugin } from "./plugin"
import { CommandRegistry, normalizeCommandName, normalizeCommandResult } from "./registry"
import type { CommandDefinition, CommandService } from "./types"

describe("normalizeCommandName", () => {
	it("strips leading slashes and trims whitespace", () => {
		expect(normalizeCommandName("/help")).toBe("help")
		expect(normalizeCommandName("///clear")).toBe("clear")
		expect(normalizeCommandName("  status  ")).toBe("status")
		expect(normalizeCommandName("/deep/nested")).toBe("deep/nested")
	})
})

describe("normalizeCommandResult", () => {
	it("normalizes string return into text field", () => {
		expect(normalizeCommandResult("done")).toEqual({ text: "done" })
	})

	it("normalizes void/undefined/null into empty object", () => {
		expect(normalizeCommandResult(undefined)).toEqual({})
		expect(normalizeCommandResult(null as unknown as undefined)).toEqual({})
	})

	it("preserves objects containing text, error, or data", () => {
		const res = { text: "Success", data: { id: 10 } }
		expect(normalizeCommandResult(res)).toBe(res)

		const errRes = { error: new Error("fail") }
		expect(normalizeCommandResult(errRes)).toBe(errRes)
	})

	it("wraps arbitrary objects into data field", () => {
		const payload = { foo: "bar", count: 42 }
		expect(normalizeCommandResult(payload)).toEqual({ data: payload })
	})

	it("stringifies primitives", () => {
		expect(normalizeCommandResult(123 as unknown as undefined)).toEqual({ text: "123" })
	})
})

describe("CommandRegistry", () => {
	it("registers, looks up, and lists commands", () => {
		const registry = new CommandRegistry()
		const cmd: CommandDefinition = {
			name: "status",
			description: "Shows runtime status",
			handler: vi.fn(),
		}

		expect(registry.has("status")).toBe(false)
		expect(registry.get("status")).toBeUndefined()
		expect(registry.list()).toEqual([])

		const dispose = registry.register(cmd)
		expect(registry.has("status")).toBe(true)
		expect(registry.has("/status")).toBe(true)
		expect(registry.get("status")).toBe(cmd)
		expect(registry.get("/status")).toBe(cmd)
		expect(registry.list()).toEqual([cmd])

		dispose()
		expect(registry.has("status")).toBe(false)
		expect(registry.get("status")).toBeUndefined()
		expect(registry.list()).toEqual([])

		// Safe redundant dispose
		dispose()
	})

	it("supports LIFO shadowing of duplicate command names", () => {
		const registry = new CommandRegistry()
		const cmd1: CommandDefinition = {
			name: "reset",
			description: "Version 1",
			handler: () => "v1",
		}
		const cmd2: CommandDefinition = {
			name: "/reset",
			description: "Version 2",
			handler: () => "v2",
		}

		const dispose1 = registry.register(cmd1)
		expect(registry.get("reset")?.description).toBe("Version 1")

		const dispose2 = registry.register(cmd2)
		expect(registry.get("reset")?.description).toBe("Version 2")
		expect(registry.list().length).toBe(1)

		dispose2()
		expect(registry.get("reset")?.description).toBe("Version 1")

		dispose1()
		expect(registry.has("reset")).toBe(false)
	})

	it("executes commands and handles different result types", async () => {
		const registry = new CommandRegistry()
		registry.register({
			name: "echo",
			description: "Echo arguments",
			handler: (args) => args.join(" "),
		})

		registry.register({
			name: "calculate",
			description: "Computes result",
			handler: () => ({ data: { sum: 42 } }),
		})

		registry.register({
			name: "noop",
			description: "Does nothing",
			handler: () => undefined,
		})

		const res1 = await registry.execute("echo", ["hello", "world"])
		expect(res1).toEqual({ text: "hello world" })

		const res2 = await registry.execute("/calculate", [])
		expect(res2).toEqual({ data: { sum: 42 } })

		const res3 = await registry.execute("noop", [])
		expect(res3).toEqual({})
	})

	it("returns error result for unknown commands", async () => {
		const registry = new CommandRegistry()
		const res = await registry.execute("unknown", ["arg"])

		expect(res.error).toBeInstanceOf(Error)
		expect(res.text).toBe('Command "unknown" not found.')
	})

	it("catches handler exceptions and returns error result", async () => {
		const registry = new CommandRegistry()
		registry.register({
			name: "crash",
			description: "Throws error",
			handler: () => {
				throw new Error("Out of memory")
			},
		})

		const res = await registry.execute("crash", [])
		expect(res.error).toBeInstanceOf(Error)
		expect(res.text).toBe("Out of memory")
	})

	it("respects abort signals passed in CommandContext", async () => {
		const registry = new CommandRegistry()
		registry.register({
			name: "long_task",
			description: "Long task",
			handler: () => "done",
		})

		const controller = new AbortController()
		controller.abort()

		const res = await registry.execute("long_task", [], { signal: controller.signal })
		expect(res.error).toBeInstanceOf(Error)
		expect(res.text).toBe("Command execution aborted.")
	})

	it("supports argument autocomplete", async () => {
		const registry = new CommandRegistry()
		registry.register({
			name: "theme",
			description: "Set theme",
			handler: vi.fn(),
			complete: (prefix) => {
				const themes = ["dark", "light", "dim", "dracula"]
				return themes.filter((t) => t.startsWith(prefix))
			},
		})

		registry.register({
			name: "simple",
			description: "No completer",
			handler: vi.fn(),
		})

		registry.register({
			name: "buggy",
			description: "Throwing completer",
			handler: vi.fn(),
			complete: () => {
				throw new Error("Completer crashed")
			},
		})

		expect(await registry.complete("theme", "d")).toEqual(["dark", "dim", "dracula"])
		expect(await registry.complete("/theme", "li")).toEqual(["light"])
		expect(await registry.complete("simple", "foo")).toEqual([])
		expect(await registry.complete("unknown", "foo")).toEqual([])
		expect(await registry.complete("buggy", "foo")).toEqual([])
	})
})

describe("commandsPlugin", () => {
	it("claims ctx.commands and integrates with harness lifecycle", async () => {
		const harness = await createHarness({ plugins: [commandsPlugin] })
		const commands = harness.ctx.commands as CommandService

		expect(commands).toBeDefined()
		expect(commands.list()).toEqual([])

		const unregister = commands.register({
			name: "ping",
			description: "Ping command",
			handler: () => "pong",
			complete: (prefix) => ["pong"].filter((p) => p.startsWith(prefix)),
		})

		expect(commands.has("ping")).toBe(true)
		expect(commands.get("ping")?.name).toBe("ping")

		const execResult = await commands.execute("ping", [])
		expect(execResult).toEqual({ text: "pong" })

		const completions = await commands.complete("ping", "p")
		expect(completions).toEqual(["pong"])

		unregister()
		expect(commands.has("ping")).toBe(false)
	})
})
