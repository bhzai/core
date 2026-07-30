import { describe, expect, it, vi } from "vitest"

import { BHZAI } from "./bhzai.js"

// TASK_0005 — plugin lifecycle (init/dispose ordering, § 7.3).
//
// These tests cover `bh.init()` and the partial `bh.dispose()`: hook execution
// order (registration order for init, reverse for dispose), the `initialize`/
// `dispose` framework events firing strictly after all hooks resolve, the
// documented double-init no-op decision, and safe skipping of plugins without
// hooks. Full teardown semantics are TASK_0035's job and are not exercised
// here.

describe("BHZAI.init — hook ordering (§ 7.3 step 2)", () => {
	it("runs initialize hooks in use()-registration order", async () => {
		const order: string[] = []
		const bh = new BHZAI()
		bh.use({
			name: "a",
			initialize: () => {
				order.push("A")
			},
		})
		bh.use({
			name: "b",
			initialize: () => {
				order.push("B")
			},
		})

		await bh.init()

		expect(order).toEqual(["A", "B"])
	})

	it("awaits each initialize hook fully before starting the next", async () => {
		const order: string[] = []
		const bh = new BHZAI()
		// Inverted delays so a non-awaiting implementation would reorder.
		bh.use({
			name: "a",
			initialize: async () => {
				await new Promise((r) => setTimeout(r, 30))
				order.push("A")
			},
		})
		bh.use({
			name: "b",
			initialize: async () => {
				await new Promise((r) => setTimeout(r, 10))
				order.push("B")
			},
		})

		await bh.init()

		expect(order).toEqual(["A", "B"])
	})
})

describe("BHZAI.init — initialize event fires once, strictly after all hooks", () => {
	it("records ['A', 'B', 'event'] — the event listener runs last", async () => {
		const order: string[] = []
		const bh = new BHZAI()
		bh.use({
			name: "a",
			initialize: () => {
				order.push("A")
			},
		})
		bh.use({
			name: "b",
			initialize: () => {
				order.push("B")
			},
		})
		bh.on("initialize", () => {
			order.push("event")
		})

		await bh.init()

		expect(order).toEqual(["A", "B", "event"])
	})
})

describe("BHZAI.dispose — hook reverse ordering (§ 7.3 step 4)", () => {
	it("runs dispose hooks in reverse registration order", async () => {
		const order: string[] = []
		const bh = new BHZAI()
		bh.use({
			name: "a",
			dispose: () => {
				order.push("A")
			},
		})
		bh.use({
			name: "b",
			dispose: () => {
				order.push("B")
			},
		})

		await bh.dispose()

		// Last-registered plugin's dispose runs first.
		expect(order).toEqual(["B", "A"])
	})

	it("fires the dispose framework event before dispose hooks run (§ 8.5)", async () => {
		const order: string[] = []
		const bh = new BHZAI()
		bh.use({
			name: "a",
			dispose: () => {
				order.push("A")
			},
		})
		bh.use({
			name: "b",
			dispose: () => {
				order.push("B")
			},
		})
		bh.on("dispose", () => {
			order.push("event")
		})

		await bh.dispose()

		// Per ARCHITECTURE.md § 8.5: "plugins' dispose hooks run in reverse order
		// after it" (after the dispose event). This corrects a prior assumption
		// that had hooks running first — the event must fire first.
		expect(order).toEqual(["event", "B", "A"])
	})
})

describe("BHZAI.init — double-init no-op (documented assumption)", () => {
	it("a second init() does not re-run hooks or re-fire the initialize event", async () => {
		const bh = new BHZAI()
		const initHook = vi.fn()
		bh.use({ name: "a", initialize: initHook })
		const eventListener = vi.fn()
		bh.on("initialize", eventListener)

		await bh.init()
		await bh.init()

		expect(initHook).toHaveBeenCalledTimes(1)
		expect(eventListener).toHaveBeenCalledTimes(1)
	})
})

describe("BHZAI.init/dispose — plugins without hooks are safely skipped", () => {
	it("a capability object with no initialize/dispose keys does not break ordering", async () => {
		const initOrder: string[] = []
		const disposeOrder: string[] = []
		const bh = new BHZAI()
		bh.use({
			name: "with-hooks",
			initialize: () => {
				initOrder.push("with-hooks")
			},
			dispose: () => {
				disposeOrder.push("with-hooks")
			},
		})
		bh.use({ name: "no-hooks", configSchema: { type: "object" } })
		bh.use({
			name: "also-with-hooks",
			initialize: () => {
				initOrder.push("also-with-hooks")
			},
			dispose: () => {
				disposeOrder.push("also-with-hooks")
			},
		})

		await bh.init()
		await bh.dispose()

		// The no-hooks plugin is simply skipped in both loops; the other two
		// plugins' ordering is unaffected.
		expect(initOrder).toEqual(["with-hooks", "also-with-hooks"])
		expect(disposeOrder).toEqual(["also-with-hooks", "with-hooks"])
	})

	it("a form-1 factory plugin (no capabilities) is safely skipped by init/dispose", async () => {
		const initOrder: string[] = []
		const bh = new BHZAI()
		bh.use(() => {
			/* form-1 factory: no initialize hook */
		})
		bh.use({
			name: "with-hook",
			initialize: () => {
				initOrder.push("with-hook")
			},
		})

		await expect(bh.init()).resolves.toBeUndefined()
		expect(initOrder).toEqual(["with-hook"])
	})
})

describe("BHZAI.init — capability-object tools registration (issue #6)", () => {
	it("registers tools declared in plugin.capabilities.tools via bh.addTool() at init() start", async () => {
		const bh = new BHZAI()
		bh.use({
			name: "tools-plugin",
			tools: [
				{
					name: "tool-1",
					description: "First tool",
					inputSchema: { type: "object" },
					execute: async () => "result-1",
				},
				{
					name: "tool-2",
					description: "Second tool",
					inputSchema: { type: "object" },
					execute: async () => "result-2",
				},
			],
		})

		await bh.init()

		// Verify both tools are now in the registry
		const tools = bh.listTools()
		expect(tools).toContainEqual(expect.objectContaining({ name: "tool-1" }))
		expect(tools).toContainEqual(expect.objectContaining({ name: "tool-2" }))
	})

	it("capability-object tools are visible to initialize hooks that run after tool registration", async () => {
		const visibleTools: string[] = []
		const bh = new BHZAI()
		bh.use({
			name: "tools-plugin",
			tools: [
				{
					name: "pre-registered-tool",
					description: "A tool",
					inputSchema: { type: "object" },
					execute: async () => "ok",
				},
			],
		})
		bh.use({
			name: "checker-plugin",
			initialize: () => {
				// This hook runs AFTER tools are registered, so it should see them
				const tools = bh.listTools()
				const names = tools.map((t) => t.name)
				visibleTools.push(...names)
			},
		})

		await bh.init()

		// The checker plugin's initialize hook should have seen the pre-registered tool
		expect(visibleTools).toContain("pre-registered-tool")
	})
})
