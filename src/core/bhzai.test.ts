import { describe, expect, it, vi } from "vitest"

import type { BHZAIDriver, ModelInfo } from "../types/index.js"
import { BHZAI, type BHZAIPluginCapabilities } from "./bhzai.js"

// TASK_0003 — BHZAI kernel class + use() normalization (plugin forms 1 & 2).
//
// These tests cover only the constructor and `use()` behavior described in
// the task spec. Every other § 6 method is a stub that throws; those are
// exercised by their owning tasks.

describe("BHZAI constructor", () => {
	it("constructs with no options without throwing", () => {
		expect(() => new BHZAI()).not.toThrow()
	})

	it("constructs with host options and stores them verbatim", () => {
		const bh = new BHZAI({ defaultModel: "ollama/llama3.3" })
		expect(bh.__testOption("defaultModel")).toBe("ollama/llama3.3")
	})

	it("does not validate or transform option values (deferred to TASK_0006+)", () => {
		const config = { "my-plugin": { flag: true } }
		const bh = new BHZAI({ config, systemPrompt: "you are a robot" })
		// Stored verbatim — same reference, no cloning/validation.
		expect(bh.__testOption("config")).toBe(config)
		expect(bh.__testOption("systemPrompt")).toBe("you are a robot")
	})
})

describe("BHZAI.use — form 1 (bare factory function)", () => {
	it("invokes the factory exactly once, passing the BHZAI instance", () => {
		const bh = new BHZAI()
		const fn = vi.fn()
		bh.use(fn)
		expect(fn).toHaveBeenCalledTimes(1)
		expect(fn).toHaveBeenCalledWith(bh)
	})

	it("returns this for chaining", () => {
		const bh = new BHZAI()
		const fn = vi.fn()
		expect(bh.use(fn)).toBe(bh)
	})

	it("registers two unnamed factories as distinct plugins", () => {
		const bh = new BHZAI()
		bh.use(() => {})
		bh.use(() => {})
		expect(bh.__testPluginCount()).toBe(2)
	})

	it("treats the same function used twice as two distinct plugins (no name to dedupe on)", () => {
		const bh = new BHZAI()
		const fn = vi.fn()
		bh.use(fn)
		bh.use(fn)
		// Form-1 idempotency is keyed on explicit name; unnamed factories are
		// never duplicates of each other (TASK_0003 spec, idempotency rule).
		expect(bh.__testPluginCount()).toBe(2)
		expect(fn).toHaveBeenCalledTimes(2)
	})
})

describe("BHZAI.use — form 2 (capability object)", () => {
	it("accepts an object with only recognized keys without throwing", () => {
		const bh = new BHZAI()
		const cap: BHZAIPluginCapabilities = {
			name: "ok",
			initialize: vi.fn(),
			dispose: vi.fn(),
			configSchema: { type: "object" },
		}
		expect(() => bh.use(cap)).not.toThrow()
		expect(bh.__testPluginCount()).toBe(1)
		expect(bh.__testHasPlugin("ok")).toBe(true)
	})

	it("does NOT prematurely invoke the initialize hook at use() time", () => {
		const bh = new BHZAI()
		const initialize = vi.fn()
		bh.use({ name: "no-early-init", initialize })
		// init() does not exist yet (TASK_0005); we only assert use() itself
		// did not call initialize. The hook must run later, at bh.init() time.
		expect(initialize).not.toHaveBeenCalled()
	})

	it("does NOT prematurely invoke the dispose hook at use() time", () => {
		const bh = new BHZAI()
		const dispose = vi.fn()
		bh.use({ name: "no-early-dispose", dispose })
		expect(dispose).not.toHaveBeenCalled()
	})

	it("auto-generates a name when none is supplied", () => {
		const bh = new BHZAI()
		bh.use({ configSchema: { type: "object" } })
		expect(bh.__testPluginCount()).toBe(1)
	})

	it("returns this for chaining", () => {
		const bh = new BHZAI()
		expect(bh.use({ name: "a" })).toBe(bh)
	})

	it("throws synchronously on an unrecognized capability key, naming the bad key", () => {
		const bh = new BHZAI()
		expect(() => bh.use({ foo: 1 } as unknown as BHZAIPluginCapabilities)).toThrow(/foo/)
		expect(() => bh.use({ foo: 1 } as unknown as BHZAIPluginCapabilities)).toThrow(
			/unrecognized plugin capability key "foo"/,
		)
	})

	it("rejects a misspelled initialize key (initalize) fast", () => {
		const bh = new BHZAI()
		expect(() => bh.use({ initalize: vi.fn() } as unknown as BHZAIPluginCapabilities)).toThrow(
			/initalize/,
		)
	})

	it("rejects an unknown key even when valid keys are also present", () => {
		const bh = new BHZAI()
		expect(() =>
			bh.use({
				name: "mixed",
				initialize: vi.fn(),
				bogus: true,
			} as unknown as BHZAIPluginCapabilities),
		).toThrow(/bogus/)
		// Nothing should have been registered.
		expect(bh.__testPluginCount()).toBe(0)
		expect(bh.__testHasPlugin("mixed")).toBe(false)
	})
})

describe("BHZAI.use — idempotency by explicit name", () => {
	it("ignores a second use() with the same explicit name (no re-registration)", () => {
		const bh = new BHZAI()
		bh.use({ name: "dup", configSchema: { type: "object", properties: { a: {} } } })
		bh.use({ name: "dup", configSchema: { type: "object", properties: { b: {} } } })
		expect(bh.__testPluginCount()).toBe(1)
		expect(bh.__testHasPlugin("dup")).toBe(true)
	})

	it("does not merge/adopt the second capability object's keys", () => {
		const bh = new BHZAI()
		const firstInit = vi.fn()
		const secondInit = vi.fn()
		bh.use({ name: "dup", initialize: firstInit, configSchema: { a: 1 } })
		bh.use({ name: "dup", initialize: secondInit, configSchema: { b: 2 } })
		// Only the first registration's hooks exist; the second's were dropped.
		expect(firstInit).not.toHaveBeenCalled() // still not called at use() time
		expect(secondInit).not.toHaveBeenCalled()
		expect(bh.__testPluginCount()).toBe(1)
	})

	it("does not run a duplicate form-1 factory's body when wrapped to share a name", () => {
		// Form 1 has no name, so true dedupe-by-name isn't expressible for it.
		// Instead, verify the rule via the capability path: two capability
		// objects sharing a name keep only the first.
		const bh = new BHZAI()
		const a = vi.fn()
		const b = vi.fn()
		bh.use({ name: "shared", initialize: a })
		bh.use({ name: "shared", initialize: b })
		expect(bh.__testPluginCount()).toBe(1)
		expect(a).not.toHaveBeenCalled()
		expect(b).not.toHaveBeenCalled()
	})
})

describe("BHZAI.use — form rejection", () => {
	it("throws on null", () => {
		const bh = new BHZAI()
		expect(() => bh.use(null as unknown as never)).toThrow(
			/must be a function, a capability object, or a @Plugin-decorated instance/,
		)
	})

	it("throws on a primitive", () => {
		const bh = new BHZAI()
		expect(() => bh.use(42 as unknown as never)).toThrow(
			/must be a function, a capability object, or a @Plugin-decorated instance/,
		)
	})
})

describe("BHZAI.use — chaining order", () => {
	it("preserves registration order across mixed forms", () => {
		const bh = new BHZAI()
		bh.use(() => {})
		bh.use({ name: "cap" })
		bh.use(() => {})
		expect(bh.__testPluginCount()).toBe(3)
		expect(bh.__testHasPlugin("cap")).toBe(true)
	})
})

// ---------------------------------------------------------------------------
// Model lifecycle events
// ---------------------------------------------------------------------------

/** Default capabilities used by test fixtures. */
const TEST_CAPS: ModelInfo["capabilities"] = {
	streaming: true,
	toolCalls: false,
	reasoning: false,
}

/** Build a ModelInfo fixture from a qualified ref. */
function testModel(ref: string, overrides: Partial<ModelInfo> = {}): ModelInfo {
	const [driver, id] = ref.split("/")
	return {
		ref,
		driver,
		id,
		capabilities: { ...TEST_CAPS },
		availability: "ready",
		...overrides,
	}
}

/** Build a mock BHZAIDriver with a fixed list of models. */
function testDriver(id: string, models: ModelInfo[]): BHZAIDriver {
	return {
		id,
		listModels: async () => models,
		capabilities: () => TEST_CAPS,
		async *chat() {},
	}
}

/** Drain the bus FIFO chain. */
async function flush(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 0))
}

describe("BHZAI model lifecycle events", () => {
	it("emits model.added and models.changed when a driver is added", async () => {
		const bh = new BHZAI()
		const added = vi.fn()
		const batch = vi.fn()
		bh.on("model.added", added)
		bh.on("models.changed", batch)

		const m1 = testModel("webllm/m1")
		bh.addDriver(testDriver("webllm", [m1]))
		await flush()

		expect(added).toHaveBeenCalledTimes(1)
		expect(added).toHaveBeenCalledWith({ driver: "webllm", model: m1 })
		expect(batch).toHaveBeenCalledTimes(1)
		expect(batch.mock.calls[0][0].added).toEqual([m1])
		expect(batch.mock.calls[0][0].removed).toEqual([])
		expect(batch.mock.calls[0][0].changed).toEqual([])
	})

	it("emits model.removed when a driver is shadowed", async () => {
		const bh = new BHZAI()
		const removed = vi.fn()
		const added = vi.fn()
		const batch = vi.fn()
		bh.on("model.removed", removed)
		bh.on("model.added", added)
		bh.on("models.changed", batch)

		const m1 = testModel("webllm/m1")
		const m2 = testModel("webllm/m2")
		bh.addDriver(testDriver("webllm", [m1]))
		await flush()

		bh.addDriver(testDriver("webllm", [m2]))
		await flush()

		expect(removed).toHaveBeenCalledTimes(1)
		expect(removed).toHaveBeenCalledWith({ driver: "webllm", model: m1 })
		expect(added).toHaveBeenCalledTimes(2)
		expect(batch).toHaveBeenCalledTimes(2)
		expect(batch.mock.calls[1][0].removed).toEqual([m1])
		expect(batch.mock.calls[1][0].added).toEqual([m2])
	})

	it("emits model.changed when capabilities or availability change", async () => {
		const bh = new BHZAI()
		const changed = vi.fn()
		const batch = vi.fn()
		bh.on("model.changed", changed)
		bh.on("models.changed", batch)

		const m1 = testModel("webllm/m1")
		bh.addDriver(testDriver("webllm", [m1]))
		await flush()

		const m1Updated = testModel("webllm/m1", { availability: "downloadable" })
		bh.addDriver(testDriver("webllm", [m1Updated]))
		await flush()

		expect(changed).toHaveBeenCalledTimes(1)
		expect(changed.mock.calls[0][0].driver).toBe("webllm")
		expect(changed.mock.calls[0][0].model).toEqual(m1Updated)
		expect(changed.mock.calls[0][0].previous).toEqual(m1)
		expect(batch.mock.calls[1][0].changed).toHaveLength(1)
	})

	// REGRESSION: drivers dispatch 'connect' from inside listModels(), and a host
	// that refreshes its catalogue on that event re-enters bh.listModels(). Before
	// the guard spanned the driver poll, each refresh polled every driver and each
	// poll triggered another refresh — an unbounded request storm (observed as
	// 5000+ requests against an OpenAI-compatible gateway).
	it("does not re-poll drivers when a driver event re-enters listModels()", async () => {
		const bh = new BHZAI()
		let polls = 0
		const driver = Object.assign(new EventTarget(), {
			id: "loopy",
			listModels: async () => {
				polls++
				if (polls > 100) throw new Error(`runaway: ${polls} polls`)
				const models = [testModel("loopy/m1")]
				driver.dispatchEvent(new CustomEvent("connect", { detail: { models } }))
				return models
			},
			capabilities: () => ({ streaming: true, toolCalls: false, reasoning: false }),
			chat: async function* () {},
		})
		// The host refreshes its picker whenever the provider connects.
		driver.addEventListener("connect", () => {
			void bh.listModels()
		})

		bh.addDriver(driver as unknown as BHZAIDriver)
		await bh.listModels()
		await new Promise((resolve) => setTimeout(resolve, 50))

		// Bounded: the re-entrant calls read the snapshot instead of polling.
		expect(polls).toBeLessThanOrEqual(3)
	})

	it("still returns the fresh catalogue to the outer caller after re-entry", async () => {
		const bh = new BHZAI()
		const m1 = testModel("loopy/m1")
		const driver = Object.assign(new EventTarget(), {
			id: "loopy",
			listModels: async () => {
				driver.dispatchEvent(new CustomEvent("connect", { detail: { models: [m1] } }))
				return [m1]
			},
			capabilities: () => ({ streaming: true, toolCalls: false, reasoning: false }),
			chat: async function* () {},
		})
		driver.addEventListener("connect", () => {
			void bh.listModels()
		})
		bh.addDriver(driver as unknown as BHZAIDriver)

		expect(await bh.listModels()).toEqual([m1])
	})

	it("emits model.added for modelSource hook contributions", async () => {
		const bh = new BHZAI()
		const added = vi.fn()
		bh.on("model.added", added)

		const m1 = testModel("custom/m1")
		bh.use({
			name: "source",
			modelSource: async () => [m1],
		})
		await bh.init()

		expect(added).toHaveBeenCalledWith({ driver: "custom", model: m1 })
	})
})
