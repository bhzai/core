import { describe, expect, it, vi } from "vitest"
import {
	CircularPluginDependencyError,
	InvalidPluginConfigError,
	MissingPluginDependencyError,
	PluginNotFoundError,
	ServiceAlreadyClaimedError,
} from "./errors"
import { createHarness } from "./kernel"
import type { PluginDefinition } from "./types"

describe("Harness & Kernel Lifecycle", () => {
	it("initializes with empty context and event bus", async () => {
		const harness = await createHarness()
		expect(harness.ctx.events).toBeDefined()
		expect(harness.getLoadedPlugins()).toEqual([])
		await harness.dispose()
	})

	it("loads plugins and exposes claimed services to other plugins", async () => {
		interface MathService {
			add(a: number, b: number): number
		}

		const mathPlugin: PluginDefinition = {
			name: "math",
			setup(ctx) {
				const service: MathService = {
					add: (a, b) => a + b,
				}
				ctx.claim("math", service)
			},
		}

		let calculatedResult = 0
		const consumerPlugin: PluginDefinition = {
			name: "consumer",
			dependencies: ["math"],
			setup(ctx) {
				const math = ctx.math as MathService
				calculatedResult = math.add(10, 32)
			},
		}

		const harness = await createHarness({ plugins: [consumerPlugin, mathPlugin] })

		expect(harness.hasPlugin("math")).toBe(true)
		expect(harness.hasPlugin("consumer")).toBe(true)
		expect(calculatedResult).toBe(42)
		expect((harness.ctx.math as MathService).add(2, 3)).toBe(5)

		await harness.dispose()
	})

	it("prevents multiple claims of the same service key", async () => {
		const plugin1: PluginDefinition = {
			name: "provider1",
			setup(ctx) {
				ctx.claim("store", { v: 1 })
			},
		}

		const plugin2: PluginDefinition = {
			name: "provider2",
			setup(ctx) {
				ctx.claim("store", { v: 2 })
			},
		}

		const harness = await createHarness()
		await harness.load(plugin1)

		await expect(harness.load(plugin2)).rejects.toThrow(ServiceAlreadyClaimedError)
		await harness.dispose()
	})

	it("prevents claiming the reserved 'events' namespace", async () => {
		const badPlugin: PluginDefinition = {
			name: "bad",
			setup(ctx) {
				ctx.claim("events", {})
			},
		}

		const harness = await createHarness()
		await expect(harness.load(badPlugin)).rejects.toThrow(ServiceAlreadyClaimedError)
		await harness.dispose()
	})

	it("reverts all effects (services, events, teardown) when a plugin is unloaded", async () => {
		let eventFiredCount = 0
		let teardownCalled = false

		const testPlugin: PluginDefinition = {
			name: "reversible",
			setup(ctx) {
				ctx.claim("flag", { active: true })
				ctx.events.on("test/event", () => {
					eventFiredCount++
				})
				return () => {
					teardownCalled = true
				}
			},
		}

		const harness = await createHarness()
		await harness.load(testPlugin)

		expect(harness.ctx.flag).toEqual({ active: true })
		harness.ctx.events.emit("test/event", undefined)
		expect(eventFiredCount).toBe(1)

		await harness.unload("reversible")

		// 1. Service key is removed
		expect(harness.ctx.flag).toBeUndefined()
		// 2. Event listener is removed
		harness.ctx.events.emit("test/event", undefined)
		expect(eventFiredCount).toBe(1)
		// 3. Teardown hook was executed
		expect(teardownCalled).toBe(true)

		// 4. Service key can now be claimed by another plugin
		const replacementPlugin: PluginDefinition = {
			name: "replacement",
			setup(ctx) {
				ctx.claim("flag", { active: false })
			},
		}
		await harness.load(replacementPlugin)
		expect(harness.ctx.flag).toEqual({ active: false })

		await harness.dispose()
	})

	it("cascades unload to dependent plugins in reverse order", async () => {
		const unloadOrder: string[] = []

		const basePlugin: PluginDefinition = {
			name: "base",
			setup() {
				return () => {
					unloadOrder.push("base")
				}
			},
		}

		const dependentPlugin: PluginDefinition = {
			name: "dependent",
			dependencies: ["base"],
			setup() {
				return () => {
					unloadOrder.push("dependent")
				}
			},
		}

		const harness = await createHarness({ plugins: [basePlugin, dependentPlugin] })
		expect(harness.getLoadedPlugins()).toEqual(["base", "dependent"])

		await harness.unload("base")
		expect(unloadOrder).toEqual(["dependent", "base"])
		expect(harness.getLoadedPlugins()).toEqual([])

		await harness.dispose()
	})

	it("reloads a plugin by replacing its instance and effects", async () => {
		const harness = await createHarness()

		const v1: PluginDefinition = {
			name: "service-plugin",
			setup(ctx) {
				ctx.claim("version", "v1")
			},
		}
		const v2: PluginDefinition = {
			name: "service-plugin",
			setup(ctx) {
				ctx.claim("version", "v2")
			},
		}

		await harness.load(v1)
		expect(harness.ctx.version).toBe("v1")

		await harness.reload(v2)
		expect(harness.ctx.version).toBe("v2")

		await harness.dispose()
	})

	it("validates plugin configuration against configSchema", async () => {
		const schemaPlugin: PluginDefinition<{ port: number }> = {
			name: "server",
			configSchema: {
				type: "object",
				properties: { port: { type: "number", minimum: 1024 } },
				required: ["port"],
			},
			setup(_ctx, _config) {},
		}

		const harness = await createHarness()

		await expect(harness.load(schemaPlugin, { port: 80 })).rejects.toThrow(InvalidPluginConfigError)
		await expect(harness.load(schemaPlugin, { port: 8080 })).resolves.toBeUndefined()

		await harness.dispose()
	})

	it("fails on missing dependencies or dependency cycles", async () => {
		const harness = await createHarness()

		const brokenPlugin: PluginDefinition = {
			name: "orphan",
			dependencies: ["non-existent"],
			setup() {},
		}

		await expect(harness.load(brokenPlugin)).rejects.toThrow(MissingPluginDependencyError)

		const cycle1: PluginDefinition = { name: "c1", dependencies: ["c2"], setup() {} }
		const cycle2: PluginDefinition = { name: "c2", dependencies: ["c1"], setup() {} }

		await expect(createHarness({ plugins: [cycle1, cycle2] })).rejects.toThrow(
			CircularPluginDependencyError,
		)

		await harness.dispose()
	})

	it("throws PluginNotFoundError when unloading an unknown plugin", async () => {
		const harness = await createHarness()
		await expect(harness.unload("non-existent")).rejects.toThrow(PluginNotFoundError)
		await harness.dispose()
	})

	it("reverts plugin-registered waterfall and bail handlers on unload", async () => {
		const middlewarePlugin: PluginDefinition = {
			name: "mw",
			setup(ctx) {
				ctx.events.waterfall("pipeline", async (val: string, _c, next) => next(`[${val}]`))
				ctx.events.bail("check", () => "mw-handled")
			},
		}

		const harness = await createHarness()
		await harness.load(middlewarePlugin)

		expect(await harness.ctx.events.runWaterfall("pipeline", "hi", {})).toBe("[hi]")
		expect(await harness.ctx.events.runBail("check", {})).toBe("mw-handled")

		await harness.unload("mw")

		expect(await harness.ctx.events.runWaterfall("pipeline", "hi", {})).toBe("hi")
		expect(await harness.ctx.events.runBail("check", {})).toBeUndefined()

		await harness.dispose()
	})

	it("automatically unloads old version when load() is called for existing plugin", async () => {
		let v1Unloaded = false
		const v1: PluginDefinition = {
			name: "swap",
			setup(ctx) {
				ctx.claim("val", 1)
				return () => {
					v1Unloaded = true
				}
			},
		}
		const v2: PluginDefinition = {
			name: "swap",
			setup(ctx) {
				ctx.claim("val", 2)
			},
		}

		const harness = await createHarness()
		await harness.load(v1)
		expect(harness.ctx.val).toBe(1)

		await harness.load(v2)
		expect(v1Unloaded).toBe(true)
		expect(harness.ctx.val).toBe(2)

		await harness.dispose()
	})

	it("tolerates errors thrown during teardown or effect disposal", async () => {
		const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {})

		const noisyPlugin: PluginDefinition = {
			name: "noisy",
			setup(ctx) {
				ctx.claim("temp", "value")
				// Register a faulty disposable
				ctx.events.on("evt", () => {})
				return () => {
					throw new Error("teardown exploded")
				}
			},
		}

		const harness = await createHarness()
		await harness.load(noisyPlugin)

		// Unload should complete despite the error in teardown
		await expect(harness.unload("noisy")).resolves.toBeUndefined()
		expect(harness.hasPlugin("noisy")).toBe(false)
		expect(harness.ctx.temp).toBeUndefined()

		consoleSpy.mockRestore()
		await harness.dispose()
	})

	it("allows manual unclaiming via returned disposable before unload", async () => {
		let unclaimFn: (() => void) | undefined
		const manualPlugin: PluginDefinition = {
			name: "manual",
			setup(ctx) {
				unclaimFn = ctx.claim("ephemeral", 123)
			},
		}

		const harness = await createHarness()
		await harness.load(manualPlugin)
		expect(harness.ctx.ephemeral).toBe(123)

		unclaimFn?.()
		expect(harness.ctx.ephemeral).toBeUndefined()

		await harness.dispose()
	})

	it("throws when createSession or openSession is called without sessions service", async () => {
		const harness = await createHarness()
		await expect(harness.createSession()).rejects.toThrow(
			"Harness.createSession requires the sessions service",
		)
		await expect(harness.openSession("missing")).rejects.toThrow(
			"Harness.openSession requires the sessions service",
		)
		await harness.dispose()
	})

	it("throws errors when required services are missing from harness methods", async () => {
		const emptyHarness = await createHarness()
		await expect(emptyHarness.createSession()).rejects.toThrow("requires the sessions service")
		await expect(emptyHarness.openSession("any")).rejects.toThrow("requires the sessions service")
		await emptyHarness.dispose()

		const sessionPluginOnly: PluginDefinition = {
			name: "sessions",
			setup(ctx) {
				ctx.claim("sessions", {
					create: async () => ({
						id: "s1",
						metadata: {},
						events: [],
						getEvents: () => [],
						export: async () => ({
							version: 1 as const,
							sessionId: "s1",
							events: [],
						}),
					}),
					open: async () => {
						throw new Error("not found")
					},
				})
			},
		}
		const h = await createHarness({ plugins: [sessionPluginOnly] })
		const s = await h.createSession()
		await expect(s.sendMessage("hi")).rejects.toThrow("agentLoop service is not registered")
		await h.dispose()
	})
})
