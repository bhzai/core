import { describe, expect, it, vi } from "vitest"

import { EventBus } from "./event-bus.js"

// TASK_0004 — framework event bus (§§ 8.2, 8.4).
//
// These tests exercise the standalone `EventBus` class directly (not through
// `BHZAI`), since `EventBus` must be independently reusable — TASK_0023 will
// instantiate one per `Conversation`. Each test maps 1:1 to a bullet under
// TASK_0004's "Tests Required" and to a numbered rule in § 8.2 / § 8.4.

describe("EventBus — registration-order + await sequencing (§ 8.2 rule 1)", () => {
	it("runs handlers in registration order, awaiting each before the next starts", async () => {
		const bus = new EventBus()
		const order: number[] = []
		// Delays are deliberately inverted (3 → 1) so a naive `Promise.all` or
		// fire-without-await implementation would record [3, 2, 1] instead of
		// the registration order [1, 2, 3].
		bus.on("test.first", async () => {
			await new Promise((r) => setTimeout(r, 30))
			order.push(1)
		})
		bus.on("test.first", async () => {
			await new Promise((r) => setTimeout(r, 20))
			order.push(2)
		})
		bus.on("test.first", async () => {
			await new Promise((r) => setTimeout(r, 10))
			order.push(3)
		})

		await bus.emit("test.first", {})

		expect(order).toEqual([1, 2, 3])
	})
})

describe("EventBus — patch chaining (§ 8.2 rule 2)", () => {
	it("each handler sees prior patches applied; final patch reflects all merges", async () => {
		const bus = new EventBus()
		const observedByB: string[] = []
		type ChainPayload = { items: string[] }

		bus.on<ChainPayload>("test.chain", (current) => {
			return { items: [...(current.items ?? []), "a"] }
		})
		bus.on<ChainPayload>("test.chain", (current) => {
			observedByB.push(...(current.items ?? []))
			return { items: [...(current.items ?? []), "b"] }
		})

		const result = await bus.emit<ChainPayload>("test.chain", { items: [] })

		// Handler B observed A's patch already applied before B ran.
		expect(observedByB).toEqual(["a"])
		// Final accumulated patch reflects both merges.
		expect(result.patch).toEqual({ items: ["a", "b"] })
		expect(result.handled).toBe(2)
	})
})

describe("EventBus — blocking (§ 8.2 rule 3)", () => {
	it("a { block: true } return on a blockable dispatch stops later handlers", async () => {
		const bus = new EventBus()
		const handler3 = vi.fn()

		bus.on("test.block", () => ({ first: true }))
		bus.on("test.block", () => ({ block: true, reason: "nope" }))
		bus.on("test.block", handler3)

		const result = await bus.emit("test.block", {}, { blockable: true })

		expect(handler3).not.toHaveBeenCalled()
		expect(result.blocked).toBe(true)
		expect(result.reason).toBe("nope")
	})

	it("a { block: true } return on a NON-blockable dispatch does NOT stop the chain", async () => {
		const bus = new EventBus()
		const handler2 = vi.fn(() => ({ block: true, reason: "ignored" }))
		const handler3 = vi.fn()

		bus.on("test.noblock", () => ({ first: true }))
		bus.on("test.noblock", handler2)
		bus.on("test.noblock", handler3)

		const result = await bus.emit("test.noblock", {})

		// No blockable flag → block signal is an ordinary patch; handler 3 still runs.
		expect(handler3).toHaveBeenCalledTimes(1)
		expect(result.blocked).toBe(false)
		expect(result.reason).toBeUndefined()
	})
})

describe("EventBus — reserved name rejection (§ 8.4)", () => {
	it.each([
		"message",
		"message.delta",
		"tool",
		"context",
		"request",
		"turn",
		"abort",
		"initialize",
		"dispose",
		"error",
	])("throws synchronously for reserved exact name %s", (event) => {
		const bus = new EventBus()
		// Must throw synchronously BEFORE returning a Promise — wrap in a
		// synchronous try/catch rather than `await expect(...).rejects`.
		expect(() => bus.emit(event, {})).toThrow(/reserved for kernel use/)
	})

	it.each([
		"conversation.created",
		"driver.registered",
		"mcp.attached",
		"config.changed",
		"model.added",
		"model.changed",
		"model.removed",
		"models.changed",
		"model.resolve",
	])("throws synchronously for reserved namespace prefix %s", (event) => {
		const bus = new EventBus()
		expect(() => bus.emit(event, {})).toThrow(/reserved for kernel use/)
	})

	it("throws synchronously for an un-namespaced custom name (no dot)", () => {
		const bus = new EventBus()
		expect(() => bus.emit("nodothere", {})).toThrow(/namespaced/)
	})

	it("the synchronous throw happens before returning a Promise (not a rejection)", () => {
		const bus = new EventBus()
		let threw = false
		let returnedPromise: unknown = undefined
		try {
			returnedPromise = bus.emit("message", {})
		} catch {
			threw = true
		}
		expect(threw).toBe(true)
		expect(returnedPromise).toBeUndefined()
	})
})

describe("EventBus — valid namespaced custom event", () => {
	it("succeeds for a <plugin>.<event> name and reports handled count", async () => {
		const bus = new EventBus()
		bus.on("my-plugin.thing", () => undefined)
		bus.on("my-plugin.thing", () => undefined)

		const result = await bus.emit("my-plugin.thing", {})

		expect(result.handled).toBe(2)
		expect(result.blocked).toBe(false)
	})
})

describe("EventBus — compact special-case (§ 8.4 exception)", () => {
	it("emit('compact', ...) does not throw the generic reserved-name error", async () => {
		const bus = new EventBus()
		// Must not throw synchronously.
		expect(() => bus.emit("compact", {})).not.toThrow()
		// And must resolve as a normal (zero-subscriber) dispatch.
		const result = await bus.emit("compact", {})
		expect(result.handled).toBe(0)
	})
})

describe("EventBus — error containment (§ 8.2 rule 4)", () => {
	it("a throwing handler does not abort sibling handlers and is rerouted to 'error'", async () => {
		const bus = new EventBus()
		const sibling = vi.fn(() => ({ sibling: true }))
		const errorListener = vi.fn()

		const thrown = new Error("boom")
		bus.on("test.err", () => {
			throw thrown
		})
		bus.on("test.err", sibling)
		bus.on("error", errorListener)

		const result = await bus.emit("test.err", {})

		// Sibling handler still ran (dispatch did not abort).
		expect(sibling).toHaveBeenCalledTimes(1)
		// The error was rerouted to the `error` framework event with the thrown
		// error and `source` naming the original event.
		expect(errorListener).toHaveBeenCalledTimes(1)
		const errorPayload = errorListener.mock.calls[0][0] as {
			error: unknown
			source: string
		}
		expect(errorPayload.error).toBe(thrown)
		expect(errorPayload.source).toBe("test.err")
		// The throwing handler counts as "invoked" (it did run, then threw).
		expect(result.handled).toBe(2)
		// The throwing handler contributed no patch; the sibling's patch is present.
		expect(result.patch).toEqual({ sibling: true })
	})

	it("does not propagate the handler error to the caller of emit()", async () => {
		const bus = new EventBus()
		bus.on("test.nothrow", () => {
			throw new Error("should not escape")
		})
		// emit() resolves rather than rejecting.
		await expect(bus.emit("test.nothrow", {})).resolves.toBeDefined()
	})
})

describe("EventBus — re-entrancy / FIFO queuing (§ 8.4 rule 2)", () => {
	it("a re-entrant emit from inside a handler runs strictly after the current dispatch completes", async () => {
		const bus = new EventBus()
		const order: string[] = []

		bus.on("test.a", () => {
			// Fire a re-entrant emit WITHOUT awaiting it. Per § 8.4 rule 2 it
			// must queue and only run after the current (test.a) dispatch
			// finishes — not interleave mid-dispatch.
			void bus.emit("other-plugin.b", {})
		})
		bus.on("test.a", () => {
			order.push("a-last-handler-completed")
		})
		bus.on("other-plugin.b", () => {
			order.push("b-handler-ran")
		})

		await bus.emit("test.a", {})

		// The re-entrant b dispatch's handler ran strictly AFTER a's own last
		// handler completed, not interleaved mid-a-dispatch.
		expect(order).toEqual(["a-last-handler-completed", "b-handler-ran"])
	})

	it("two dispatches on one bus never interleave (global serialization)", async () => {
		const bus = new EventBus()
		const trace: string[] = []

		bus.on("test.x", async () => {
			trace.push("x-start")
			await new Promise((r) => setTimeout(r, 10))
			trace.push("x-end")
		})
		bus.on("test.y", async () => {
			trace.push("y-start")
			await new Promise((r) => setTimeout(r, 5))
			trace.push("y-end")
		})

		// Fire both concurrently; the bus must serialize them.
		await Promise.all([bus.emit("test.x", {}), bus.emit("test.y", {})])

		// Either x fully precedes y or y fully precedes x — no interleaving.
		const joined = trace.join(",")
		expect(
			joined === "x-start,x-end,y-start,y-end" || joined === "y-start,y-end,x-start,x-end",
		).toBe(true)
	})
})

describe("EventBus — zero-subscriber emit (§ 8.4 rule 3)", () => {
	it("emit on an event with no handlers resolves with handled:0, blocked:false, patch:{}", async () => {
		const bus = new EventBus()
		const result = await bus.emit("my-plugin.unheard", {})
		expect(result).toEqual({ blocked: false, patch: {}, handled: 0 })
	})
})

describe("EventBus — unsubscribe", () => {
	it("the returned Unsubscribe removes the handler from future dispatches", async () => {
		const bus = new EventBus()
		const handler = vi.fn()
		const off = bus.on("test.off", handler)

		await bus.emit("test.off", {})
		expect(handler).toHaveBeenCalledTimes(1)

		off()
		await bus.emit("test.off", {})
		expect(handler).toHaveBeenCalledTimes(1) // not called again
	})
})

describe("EventBus — dispatch() bypasses reserved-name check", () => {
	it("dispatch() can fire reserved kernel names that emit() would reject", async () => {
		const bus = new EventBus()
		const onInit = vi.fn()
		bus.on("initialize", onInit)

		// emit('initialize') throws; dispatch('initialize') does not.
		expect(() => bus.emit("initialize", { bh: {} })).toThrow(/reserved/)
		const result = await bus.dispatch("initialize", { bh: {} })
		expect(onInit).toHaveBeenCalledTimes(1)
		expect(result.handled).toBe(1)
	})
})
