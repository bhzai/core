// biome-ignore lint/nursery/noRestrictedImports: regression-guard test reads tsconfig.json to assert the legacy decorator flags are off; no web-standard equivalent exists for sync file reads in a test.
import { readFileSync } from "node:fs"
// biome-ignore lint/nursery/noRestrictedImports: regression-guard test reads tsconfig.json to assert the legacy decorator flags are off; no web-standard equivalent exists for sync file reads in a test.
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

import { BHZAI } from "./bhzai.js"
import {
	type BHPlugin,
	BHZAI_PLUGIN_META,
	On,
	Plugin,
	Tool,
	type ToolRegistrar,
} from "./decorators.js"

// TASK_0007 — decorator-based plugins (§ 7.2 form 3).
//
// These tests verify the decorator *mechanism*: any correctly decorated class
// passed to `bh.use()` normalizes into the canonical `{ name, setup(bh) }`
// shape and behaves as documented — `@On` methods subscribe to events, a
// `@On('initialize')` method fires during `bh.init()`, and `@Tool` methods
// register against the `ToolRegistrar` seam. The doc's specific example names
// (`MyPlugin`, `my-other-tool`, etc.) are illustrative only and are not
// reproduced verbatim — the deliverable is the mechanism, not a hardcoded
// match to that example.

describe("@On('initialize') fires during init()", () => {
	it("a @Plugin/@On('initialize')-decorated class instance runs its init method when bh.init() fires", async () => {
		@Plugin("test-plugin")
		class TestPlugin implements BHPlugin {
			called = false
			@On("initialize")
			async onInit(): Promise<void> {
				this.called = true
			}
		}

		const instance = new TestPlugin()
		const bh = new BHZAI()
		bh.use(instance)

		expect(instance.called).toBe(false)
		await bh.init()
		expect(instance.called).toBe(true)
	})
})

describe("@Tool registers against the ToolRegistrar seam", () => {
	it("registers { name, schema, execute } and the captured execute invokes the decorated method", async () => {
		const schema = { type: "object", properties: { say: { type: "boolean" } } }
		const calls: unknown[] = []

		@Plugin("tool-plugin")
		class ToolPlugin implements BHPlugin {
			@Tool("my-tool", schema)
			async myTool(invocation: unknown): Promise<string> {
				calls.push(invocation)
				return "tool-result"
			}
		}

		// Inject a recording stub registrar so the assertions are independent
		// of whatever concrete registrar BHZAI currently exposes — only the
		// registrar's identity/injection point would need to change once
		// TASK_0008's real registry replaces the stub, not the assertions'
		// shape.
		const registered: Array<{
			name: string
			schema: unknown
			execute: (...args: unknown[]) => unknown
		}> = []
		const stubRegistrar: ToolRegistrar = {
			register: (toolDef) => {
				registered.push(toolDef)
			},
		}

		const instance = new ToolPlugin()
		const bh = new BHZAI()
		// Replace the seam with the recording stub for this test.
		;(bh as unknown as { toolRegistrar: ToolRegistrar }).toolRegistrar = stubRegistrar
		bh.use(instance)

		expect(registered).toHaveLength(1)
		expect(registered[0].name).toBe("my-tool")
		expect(registered[0].schema).toBe(schema)
		expect(typeof registered[0].execute).toBe("function")

		const result = await registered[0].execute({ say: true })
		expect(result).toBe("tool-result")
		expect(calls).toEqual([{ say: true }])
	})
})

describe("Multiple @On methods on one class all subscribe", () => {
	it("each @On-decorated method subscribes to its own event and not the others", async () => {
		const seen: string[] = []

		@Plugin("multi-on-plugin")
		class MultiOnPlugin implements BHPlugin {
			@On("initialize")
			async onInit(): Promise<void> {
				seen.push("initialize")
			}

			@On("test.custom")
			async onCustom(): Promise<void> {
				seen.push("custom")
			}
		}

		const instance = new MultiOnPlugin()
		const bh = new BHZAI()
		bh.use(instance)

		await bh.init()
		// `initialize` fired by init(); the custom event has not yet.
		expect(seen).toEqual(["initialize"])

		await bh.emit("test.custom", {})
		expect(seen).toEqual(["initialize", "custom"])
	})
})

describe("Decorated instances normalize into the canonical plugin shape", () => {
	it("a decorated instance is registered under its @Plugin name and is idempotent", () => {
		@Plugin("dup-plugin")
		class DupPlugin implements BHPlugin {
			@On("initialize")
			async onInit(): Promise<void> {}
		}

		const bh = new BHZAI()
		bh.use(new DupPlugin())
		expect(bh.__testHasPlugin("dup-plugin")).toBe(true)
		expect(bh.__testPluginCount()).toBe(1)

		// Second use() with the same name is a silent no-op (§ 7.1).
		bh.use(new DupPlugin())
		expect(bh.__testPluginCount()).toBe(1)
	})

	it("getPluginMetadata reads the stamped metadata off a decorated instance", () => {
		@Plugin("meta-plugin")
		class MetaPlugin implements BHPlugin {
			@On("initialize")
			async onInit(): Promise<void> {}

			@Tool("meta-tool", { type: "object" })
			async metaTool(): Promise<void> {}
		}

		const instance = new MetaPlugin()
		const meta = (instance as unknown as { [BHZAI_PLUGIN_META]: unknown })[BHZAI_PLUGIN_META] as {
			name: string
			onHandlers: unknown[]
			tools: unknown[]
		}
		expect(meta.name).toBe("meta-plugin")
		expect(meta.onHandlers).toHaveLength(1)
		expect(meta.tools).toHaveLength(1)
	})
})

// Regression guard: assert the legacy `experimentalDecorators` /
// `emitDecoratorMetadata` flags are NOT enabled in tsconfig.json. This is a
// cross-check against TASK_0001's file — if a future change accidentally
// turns either flag on, this test fails. It is a regression guard, not a new-
// behavior test.
describe("tsconfig.json does not enable legacy decorator flags", () => {
	it("experimentalDecorators and emitDecoratorMetadata are both absent/false", () => {
		const tsconfigPath = fileURLToPath(new URL("../../tsconfig.json", import.meta.url))
		const raw = readFileSync(tsconfigPath, "utf8")
		// tsconfig.json is JSONC (has `//` comments); strip them before parse.
		const stripped = raw.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "")
		const tsconfig = JSON.parse(stripped) as {
			compilerOptions?: { experimentalDecorators?: boolean; emitDecoratorMetadata?: boolean }
		}
		const opts = tsconfig.compilerOptions ?? {}
		expect(opts.experimentalDecorators ?? false).toBe(false)
		expect(opts.emitDecoratorMetadata ?? false).toBe(false)
	})
})
