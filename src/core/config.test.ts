import { describe, expect, it, vi } from "vitest"

import { BHZAI, type ConfigChangedPayload } from "./bhzai.js"

// TASK_0006 — plugin configuration contract (§ 7.4).
//
// These tests cover the four-pronged contract: declaration via `configSchema`
// (capability key) or `declareConfig()` (imperative), supply via constructor
// `config` option or `setConfig()`, validation-with-defaulting at `init()`
// time (fail-fast, path-naming error), retrieval via `getConfig<T>()`, and
// the `config.changed` framework event for live edits. The kernel stays
// storage-free — no persistence is tested here, only the in-memory contract.

const topKSchema = {
	type: "object",
	properties: {
		topK: { type: "number", default: 5 },
	},
}

describe("BHZAI config — defaulting (§ 7.4)", () => {
	it("applies schema `default` keywords when the host supplies no value", async () => {
		const bh = new BHZAI()
		bh.use({ name: "my-plugin", configSchema: topKSchema })

		await bh.init()

		expect(bh.getConfig("my-plugin")).toEqual({ topK: 5 })
	})
})

describe("BHZAI config — validation failure at init() time", () => {
	it("rejects init() with a path-qualified message naming the offending property", async () => {
		const bh = new BHZAI({
			config: { "my-plugin": { topK: "not-a-number" } },
		})
		bh.use({ name: "my-plugin", configSchema: topKSchema })

		const p = bh.init()
		// The message must name the offending path AND mention the type mismatch.
		await expect(p).rejects.toThrow(/my-plugin\.config\.topK/)
		await expect(p).rejects.toThrow(/expected number.*got string/)
	})
})

describe("BHZAI config — getConfig returns validated + defaulted values", () => {
	it("merges a host-supplied value with a schema default for another property", async () => {
		const schema = {
			type: "object",
			properties: {
				topK: { type: "number", default: 5 },
				label: { type: "string", default: "default-label" },
			},
		}
		const bh = new BHZAI({
			config: { "my-plugin": { topK: 10 } },
		})
		bh.use({ name: "my-plugin", configSchema: schema })

		await bh.init()

		// Host-supplied topK wins; absent label gets its default.
		expect(bh.getConfig("my-plugin")).toEqual({ topK: 10, label: "default-label" })
	})
})

describe("BHZAI config — config.changed event (live edits)", () => {
	it("fires config.changed on a post-init setConfig() with the new merged values", async () => {
		const bh = new BHZAI()
		bh.use({ name: "my-plugin", configSchema: topKSchema })
		const spy = vi.fn()
		bh.on<ConfigChangedPayload>("config.changed", spy)

		await bh.init()
		bh.setConfig("my-plugin", { topK: 10 })
		// `config.changed` is dispatched asynchronously through the bus's
		// serialized queue; flush one microtask so the handler runs before we
		// assert.
		await new Promise((resolve) => setTimeout(resolve, 0))

		expect(spy).toHaveBeenCalledTimes(1)
		const payload = spy.mock.calls[0][0] as ConfigChangedPayload
		expect(payload.pluginName).toBe("my-plugin")
		expect(payload.values).toEqual(expect.objectContaining({ topK: 10 }))
	})

	it("does NOT fire config.changed on a pre-init setConfig() call", async () => {
		const bh = new BHZAI()
		bh.use({ name: "my-plugin", configSchema: topKSchema })
		const spy = vi.fn()
		bh.on<ConfigChangedPayload>("config.changed", spy)

		// Pre-init accumulation — not a "change" to a live config.
		bh.setConfig("my-plugin", { topK: 1 })
		expect(spy).not.toHaveBeenCalled()

		// init() itself must also not fire config.changed (it validates, but
		// that is initial resolution, not a live edit).
		await bh.init()
		expect(spy).not.toHaveBeenCalled()
	})
})

describe("BHZAI config — getConfig for an undeclared plugin", () => {
	it("returns undefined for a plugin with no configSchema", async () => {
		const bh = new BHZAI()
		bh.use({ name: "no-config-plugin", initialize: () => {} })

		await bh.init()

		expect(bh.getConfig("no-config-plugin")).toBeUndefined()
	})
})

describe("BHZAI config — declareConfig() imperative form (form-1 plugins)", () => {
	it("lets a factory-function plugin declare its schema and reads defaulted config", async () => {
		const bh = new BHZAI()
		bh.use((innerBh) => {
			innerBh.declareConfig("factory-plugin", {
				type: "object",
				properties: { x: { type: "number", default: 1 } },
			})
		})

		await bh.init()

		expect(bh.getConfig("factory-plugin")).toEqual({ x: 1 })
	})
})

describe("BHZAI config — getConfig precondition", () => {
	it("throws if called before init() has completed", () => {
		const bh = new BHZAI()
		bh.use({ name: "my-plugin", configSchema: topKSchema })

		expect(() => bh.getConfig("my-plugin")).toThrow(/before bh\.init\(\) completed/)
	})
})

describe("BHZAI config — setConfig merge semantics", () => {
	it("shallow-merges new values into previously-supplied values at the top level", async () => {
		const schema = {
			type: "object",
			properties: {
				topK: { type: "number", default: 5 },
				label: { type: "string", default: "x" },
			},
		}
		const bh = new BHZAI({
			config: { "my-plugin": { topK: 10 } },
		})
		bh.use({ name: "my-plugin", configSchema: schema })

		await bh.init()
		// Update only `label`; `topK` should be retained from the constructor.
		bh.setConfig("my-plugin", { label: "y" })

		expect(bh.getConfig("my-plugin")).toEqual({ topK: 10, label: "y" })
	})
})
