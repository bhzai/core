import { describe, expect, it, vi } from "vitest"
import { createEventBus } from "./event-bus"

describe("EventBus", () => {
	it("dispatches notifications via on() and runSerial() in order", async () => {
		const bus = createEventBus()
		const callOrder: string[] = []

		bus.on("item/created", async (payload: { name: string }) => {
			callOrder.push(`first:${payload.name}`)
		})
		bus.on("item/created", async (payload: { name: string }) => {
			callOrder.push(`second:${payload.name}`)
		})

		await bus.runSerial("item/created", { name: "alpha" })
		expect(callOrder).toEqual(["first:alpha", "second:alpha"])
	})

	it("unsubscribes notification listeners via returned disposable", async () => {
		const bus = createEventBus()
		let count = 0

		const dispose = bus.on("ping", () => {
			count++
		})
		await bus.runSerial("ping", undefined)
		expect(count).toBe(1)

		dispose()
		await bus.runSerial("ping", undefined)
		expect(count).toBe(1)
	})

	it("dispatches fire-and-forget notifications via emit() without blocking", () => {
		const bus = createEventBus()
		let received = ""

		bus.on("log", (msg: string) => {
			received = msg
		})
		bus.emit("log", "stream-delta-1")
		expect(received).toBe("stream-delta-1")
	})

	it("catches sync and async handler errors in emit() without crashing", async () => {
		const bus = createEventBus()
		const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {})

		bus.on("error/sync", () => {
			throw new Error("sync failure")
		})
		bus.on("error/async", async () => {
			throw new Error("async failure")
		})

		bus.emit("error/sync", undefined)
		bus.emit("error/async", undefined)

		expect(consoleSpy).toHaveBeenCalled()
		consoleSpy.mockRestore()
	})

	it("executes waterfall middleware pipelines in sequence", async () => {
		const bus = createEventBus()

		bus.waterfall("text/transform", async (val: string, _ctx: unknown, next) => {
			return await next(`[${val}]`)
		})
		bus.waterfall("text/transform", async (val: string, _ctx: unknown, next) => {
			return await next(`*${val}*`)
		})

		const result = await bus.runWaterfall("text/transform", "hello", {})
		expect(result).toBe("*[hello]*")
	})

	it("unsubscribes waterfall middleware via returned disposable", async () => {
		const bus = createEventBus()

		const dispose = bus.waterfall("calc", async (val: number, _ctx: unknown, next) => {
			return await next(val * 2)
		})

		const result1 = await bus.runWaterfall("calc", 5, {})
		expect(result1).toBe(10)

		dispose()
		const result2 = await bus.runWaterfall("calc", 5, {})
		expect(result2).toBe(5)
	})

	it("stops bail dispatch at the first defined result", async () => {
		const bus = createEventBus()
		const callLog: string[] = []

		bus.bail("check/permission", (role: string) => {
			callLog.push("first")
			if (role === "admin") return "ALLOW"
			return undefined
		})
		bus.bail("check/permission", (role: string) => {
			callLog.push("second")
			if (role === "user") return "READ_ONLY"
			return undefined
		})

		const resultAdmin = await bus.runBail("check/permission", "admin")
		expect(resultAdmin).toBe("ALLOW")
		expect(callLog).toEqual(["first"])

		callLog.length = 0
		const resultUser = await bus.runBail("check/permission", "user")
		expect(resultUser).toBe("READ_ONLY")
		expect(callLog).toEqual(["first", "second"])

		callLog.length = 0
		const resultGuest = await bus.runBail("check/permission", "guest")
		expect(resultGuest).toBeUndefined()
		expect(callLog).toEqual(["first", "second"])
	})

	it("unsubscribes bail handlers via returned disposable", async () => {
		const bus = createEventBus()

		const dispose = bus.bail("query", () => "handled")
		expect(await bus.runBail("query", {})).toBe("handled")

		dispose()
		expect(await bus.runBail("query", {})).toBeUndefined()
	})

	it("clears all handlers with clear()", async () => {
		const bus = createEventBus()
		let called = false

		bus.on("test", () => {
			called = true
		})
		bus.waterfall("test", async (v, _c, next) => await next(v))
		bus.bail("test", () => "yes")

		bus.clear()
		await bus.runSerial("test", undefined)
		expect(called).toBe(false)
		expect(await bus.runBail("test", undefined)).toBeUndefined()
		expect(await bus.runWaterfall("test", "default", undefined)).toBe("default")
	})
})
