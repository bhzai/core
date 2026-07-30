// TASK_0009 — driver registry tests (§ 10.1).
//
// These tests cover only the registry's storage + registration-event behavior
// and the `listModels()` driver-only merge. They do NOT implement any concrete
// driver (TASK_0019/0020), resolve `modelSource` hooks (TASK_0015), or route
// MCP sampling (TASK_0014).

import { describe, expect, it, vi } from "vitest"

import type { BHZAIDriver, DriverCapabilities, ModelInfo } from "../types/index.js"
import { DriverRegistry } from "./drivers.js"
import { EventBus } from "./event-bus.js"

/** A minimal capability fixture for a streaming, tool-calling, non-reasoning model. */
const CAPS: DriverCapabilities = {
	streaming: true,
	toolCalls: true,
	reasoning: false,
}

/** Build a ModelInfo fixture for `driver/id`. */
function modelFor(driver: string, id: string): ModelInfo {
	return {
		ref: `${driver}/${id}`,
		driver,
		id,
		capabilities: { ...CAPS },
		availability: "ready",
	}
}

/** Build a mock driver with a fixed model list and a `capabilities()` stub. */
function mockDriver(id: string, models: ModelInfo[], caps: DriverCapabilities = CAPS): BHZAIDriver {
	return {
		id,
		listModels: async () => models,
		capabilities: (_model: string) => caps,
		// `chat` is part of the interface but not exercised by these tests; the
		// agent loop (TASK_0026) consumes it. Provide a stub that returns an
		// empty async iterable so the driver satisfies the interface.
		async *chat() {
			// no-op stub
		},
	}
}

/** Fresh registry + bus pair per test. */
function freshRegistry(): { registry: DriverRegistry; bus: EventBus } {
	const bus = new EventBus()
	const registry = new DriverRegistry(bus)
	return { registry, bus }
}

/**
 * Flush the EventBus's microtask/FIFO chain. The registry fires
 * `driver.registered` via fire-and-forget `bus.dispatch(...)` (the kernel
 * bypass), which schedules onto the bus's global promise chain. A single
 * `await Promise.resolve()` only advances one microtask; a macrotask boundary
 * (`setTimeout(0)`) drains all pending microtasks so listeners have run by the
 * time the assertion executes.
 */
async function flush(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 0))
}

describe("DriverRegistry.addDriver", () => {
	it("registers a driver and listModels() reflects its contribution", async () => {
		const { registry } = freshRegistry()
		const models = [modelFor("test-driver", "m1")]
		registry.addDriver(mockDriver("test-driver", models))
		expect(await registry.listModels()).toEqual(models)
	})

	it("fires driver.registered with { driver } (driver instance in payload)", async () => {
		const { registry, bus } = freshRegistry()
		const registered = vi.fn()
		bus.on("driver.registered", registered)
		const driver = mockDriver("test-driver", [modelFor("test-driver", "m1")])
		registry.addDriver(driver)
		await flush() // drain the dispatch
		expect(registered).toHaveBeenCalledTimes(1)
		expect(registered.mock.calls[0][0].driver).toBe(driver)
	})
})

describe("DriverRegistry.listModels — merge", () => {
	it("aggregates results from two registered drivers in registration order", async () => {
		const { registry } = freshRegistry()
		const a = [modelFor("driver-a", "a1"), modelFor("driver-a", "a2")]
		const b = [modelFor("driver-b", "b1")]
		registry.addDriver(mockDriver("driver-a", a))
		registry.addDriver(mockDriver("driver-b", b))
		const merged = await registry.listModels()
		expect(merged).toEqual([...a, ...b])
	})

	it("returns an empty array when no drivers are registered", async () => {
		const { registry } = freshRegistry()
		expect(await registry.listModels()).toEqual([])
	})

	it("does not deduplicate models across drivers with overlapping ids", async () => {
		const { registry } = freshRegistry()
		// Two drivers exposing the same model id — both entries should appear.
		const a = [modelFor("driver-a", "llama3")]
		const b = [modelFor("driver-b", "llama3")]
		registry.addDriver(mockDriver("driver-a", a))
		registry.addDriver(mockDriver("driver-b", b))
		const merged = await registry.listModels()
		expect(merged).toHaveLength(2)
		expect(merged.map((m) => m.driver)).toEqual(["driver-a", "driver-b"])
	})

	it("rejects if any one driver's listModels() rejects (no silent swallow)", async () => {
		const { registry } = freshRegistry()
		registry.addDriver(mockDriver("good", [modelFor("good", "g1")]))
		const bad: BHZAIDriver = {
			id: "bad",
			listModels: async () => {
				throw new Error("boom")
			},
			capabilities: () => CAPS,
			async *chat() {},
		}
		registry.addDriver(bad)
		await expect(registry.listModels()).rejects.toThrow("boom")
	})
})

describe("DriverRegistry shadowing (same id)", () => {
	it("registering a second driver with the same id replaces the first", async () => {
		const { registry } = freshRegistry()
		const firstModels = [modelFor("test-driver", "old")]
		const secondModels = [modelFor("test-driver", "new1"), modelFor("test-driver", "new2")]
		registry.addDriver(mockDriver("test-driver", firstModels))
		registry.addDriver(mockDriver("test-driver", secondModels))
		const merged = await registry.listModels()
		// Only the second (later) driver's models appear for that id.
		expect(merged).toEqual(secondModels)
	})

	it("shadowing fires driver.registered for the new instance only", async () => {
		const { registry, bus } = freshRegistry()
		const registered = vi.fn()
		bus.on("driver.registered", registered)
		registry.addDriver(mockDriver("test-driver", [modelFor("test-driver", "old")]))
		await flush()
		registered.mockClear()
		const second = mockDriver("test-driver", [modelFor("test-driver", "new")])
		registry.addDriver(second)
		await flush()
		expect(registered).toHaveBeenCalledTimes(1)
		expect(registered.mock.calls[0][0].driver).toBe(second)
	})
})

describe("DriverRegistry.get / size accessors", () => {
	it("get returns the stored driver by id, undefined if absent", () => {
		const { registry } = freshRegistry()
		const driver = mockDriver("d", [])
		registry.addDriver(driver)
		expect(registry.get("d")).toBe(driver)
		expect(registry.get("nope")).toBeUndefined()
	})

	it("size reports the number of registered drivers", () => {
		const { registry } = freshRegistry()
		expect(registry.size).toBe(0)
		registry.addDriver(mockDriver("a", []))
		registry.addDriver(mockDriver("b", []))
		expect(registry.size).toBe(2)
		// Shadowing does not increase size.
		registry.addDriver(mockDriver("a", [modelFor("a", "x")]))
		expect(registry.size).toBe(2)
	})

	it("a driver's capabilities(model) is reachable via the get accessor", () => {
		const { registry } = freshRegistry()
		const caps: DriverCapabilities = {
			streaming: false,
			toolCalls: true,
			reasoning: true,
			embeddings: true,
			contextWindow: 8192,
		}
		registry.addDriver(mockDriver("d", [modelFor("d", "m")], caps))
		const driver = registry.get("d")
		expect(driver).toBeDefined()
		expect(driver?.capabilities("d/m")).toEqual(caps)
	})
})

describe("BHZAIDriver interface conformance", () => {
	it("a driver without embed() satisfies the interface (embed is optional)", () => {
		const driver: BHZAIDriver = {
			id: "no-embed",
			listModels: async () => [],
			capabilities: () => CAPS,
			async *chat() {},
		}
		const { registry } = freshRegistry()
		expect(() => registry.addDriver(driver)).not.toThrow()
	})

	it("a driver with embed() satisfies the interface", () => {
		const driver: BHZAIDriver = {
			id: "with-embed",
			listModels: async () => [],
			capabilities: () => ({ ...CAPS, embeddings: true }),
			async *chat() {},
			embed: async () => ({ embeddings: [[0.1, 0.2]] }),
		}
		const { registry } = freshRegistry()
		expect(() => registry.addDriver(driver)).not.toThrow()
	})
})
