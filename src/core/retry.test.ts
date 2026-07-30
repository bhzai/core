// TASK_0018 — transport retry policy & request events tests (§ 10.1, § 8.5).
//
// These tests cover the `RetryPolicy`/`DEFAULT_RETRY_POLICY` constants, the
// `isRetriableError` classifier, and the `callDriverWithRetry` wrapper's
// retry/event behavior. They use a hand-written mock `BHZAIDriver` whose
// `chat()` is a `vi.fn()`-backed async generator and a recording fake
// dispatch function. They do NOT test any concrete driver (TASK_0019/0020),
// the agent loop (TASK_0025+), or the event bus itself (TASK_0004).

import { describe, expect, it, vi } from "vitest"

import type { BHZAIDriver, ChatRequest, DriverEvent, EmitResult } from "../types/index.js"
import {
	DEFAULT_RETRY_POLICY,
	type RequestDispatch,
	type RequestEventPayload,
	callDriverWithRetry,
	exponentialBackoffDelay,
	isRetriableError,
} from "./retry.js"

/** Build a minimal ChatRequest for testing. */
function makeRequest(overrides: Partial<ChatRequest> = {}): ChatRequest {
	const controller = new AbortController()
	return {
		model: "test-driver/model-1",
		messages: [],
		signal: controller.signal,
		...overrides,
	}
}

/**
 * A recording fake dispatch. Captures every dispatched event in order and
 * optionally applies a handler-returned patch (for the `before` patch test).
 */
function recordingDispatch(
	patchesByState: Partial<Record<"before" | "retry" | "after", Partial<RequestEventPayload>>> = {},
): RequestDispatch & { events: RequestEventPayload[]; blocked: boolean } {
	const events: RequestEventPayload[] = []
	let blocked = false
	const fn = (async (
		_event: "request",
		payload: RequestEventPayload,
		_options?: { blockable?: boolean },
	): Promise<EmitResult<RequestEventPayload>> => {
		events.push({ ...payload })
		const patch = patchesByState[payload.state] ?? {}
		if (payload.state === "before" && patchesByState.before?.block) {
			blocked = true
		}
		return {
			blocked: blocked && payload.state === "before",
			patch,
			handled: Object.keys(patch).length > 0 ? 1 : 0,
		}
	}) as RequestDispatch
	return Object.assign(fn, {
		events,
		get blocked() {
			return blocked
		},
	})
}

/** Build a mock driver whose `chat()` follows a scripted sequence of outcomes. */
function mockDriver(
	script: Array<
		| { kind: "throw"; error: unknown }
		| { kind: "done-error"; event: DriverEvent }
		| { kind: "events"; events: DriverEvent[] }
	>,
): BHZAIDriver & { chat: ReturnType<typeof vi.fn> } {
	const chat = vi.fn(async function* (_req: ChatRequest): AsyncIterable<DriverEvent> {
		const step = script[Math.min(chat.mock.calls.length, script.length) - 1]
		if (!step) {
			// Default: empty success if script runs out.
			return
		}
		if (step.kind === "throw") {
			throw step.error
		}
		if (step.kind === "done-error") {
			yield step.event
			return
		}
		for (const e of step.events) yield e
	})
	return {
		id: "test-driver",
		listModels: async () => [],
		capabilities: () => ({
			streaming: true,
			toolCalls: false,
			reasoning: false,
		}),
		chat,
	}
}

/** Collect all events from an async iterable into an array. */
async function drain(iter: AsyncIterable<DriverEvent>): Promise<DriverEvent[]> {
	const out: DriverEvent[] = []
	for await (const e of iter) out.push(e)
	return out
}

describe("DEFAULT_RETRY_POLICY", () => {
	it("is exactly { maxRetries: 3, backoff: 'exponential' }", () => {
		expect(DEFAULT_RETRY_POLICY).toEqual({
			maxRetries: 3,
			backoff: "exponential",
		})
	})
})

describe("exponentialBackoffDelay", () => {
	it("uses 250 * 2 ** attemptIndex, capped at 4000ms", () => {
		expect(exponentialBackoffDelay(0)).toBe(250)
		expect(exponentialBackoffDelay(1)).toBe(500)
		expect(exponentialBackoffDelay(2)).toBe(1000)
		expect(exponentialBackoffDelay(3)).toBe(2000)
		expect(exponentialBackoffDelay(4)).toBe(4000)
		expect(exponentialBackoffDelay(5)).toBe(4000)
	})
})

describe("isRetriableError", () => {
	it("returns true for HTTP 429/502/503/504 status errors", () => {
		expect(isRetriableError({ status: 429 })).toBe(true)
		expect(isRetriableError({ status: 502 })).toBe(true)
		expect(isRetriableError({ status: 503 })).toBe(true)
		expect(isRetriableError({ status: 504 })).toBe(true)
	})

	it("returns true for a TypeError (fetch network failure)", () => {
		const err = new TypeError("failed to fetch")
		expect(isRetriableError(err)).toBe(true)
	})

	it("returns true for a NetworkError-named error", () => {
		const err = new Error("dns failure")
		err.name = "NetworkError"
		expect(isRetriableError(err)).toBe(true)
	})

	it("returns true for a done event with retriable: true", () => {
		const event = {
			type: "done",
			stopReason: "error",
			retriable: true,
		} as unknown
		expect(isRetriableError(event)).toBe(true)
	})

	it("returns true for an error with retriable: true", () => {
		expect(isRetriableError({ retriable: true })).toBe(true)
	})

	it("returns true for an error with response.status 503", () => {
		expect(isRetriableError({ response: { status: 503 } })).toBe(true)
	})

	it("returns false for HTTP 400/401/404 status errors", () => {
		expect(isRetriableError({ status: 400 })).toBe(false)
		expect(isRetriableError({ status: 401 })).toBe(false)
		expect(isRetriableError({ status: 404 })).toBe(false)
	})

	it("returns false for an AbortError", () => {
		const err = new Error("aborted")
		err.name = "AbortError"
		expect(isRetriableError(err)).toBe(false)
	})

	it("returns false for a plain Error with no status/retriable hint", () => {
		expect(isRetriableError(new Error("boom"))).toBe(false)
	})

	it("returns false for an error with retriable: false", () => {
		expect(isRetriableError({ status: 503, retriable: false })).toBe(false)
	})

	it("returns false for null/undefined", () => {
		expect(isRetriableError(null)).toBe(false)
		expect(isRetriableError(undefined)).toBe(false)
	})
})

describe("callDriverWithRetry — happy path", () => {
	it("yields the driver's events unchanged and fires before+after", async () => {
		const driver = mockDriver([
			{
				kind: "events",
				events: [
					{ type: "delta", text: "hi" },
					{ type: "done", stopReason: "stop" },
				],
			},
		])
		const dispatch = recordingDispatch()
		const events = await drain(
			callDriverWithRetry(driver, makeRequest(), DEFAULT_RETRY_POLICY, dispatch),
		)
		expect(events).toEqual([
			{ type: "delta", text: "hi" },
			{ type: "done", stopReason: "stop" },
		])
		expect(driver.chat).toHaveBeenCalledTimes(1)
		const states = dispatch.events.map((e) => e.state)
		expect(states).toEqual(["before", "after"])
		expect(dispatch.events[1].status).toBe("ok")
	})
})

describe("callDriverWithRetry — transient retries", () => {
	it("retries a 503 twice then succeeds, firing events in order", async () => {
		const driver = mockDriver([
			{ kind: "throw", error: { status: 503 } },
			{ kind: "throw", error: { status: 503 } },
			{
				kind: "events",
				events: [
					{ type: "delta", text: "ok" },
					{ type: "done", stopReason: "stop" },
				],
			},
		])
		const dispatch = recordingDispatch()
		const noDelay = vi.fn(async (_ms: number) => {})
		const events = await drain(
			callDriverWithRetry(driver, makeRequest(), DEFAULT_RETRY_POLICY, dispatch, noDelay),
		)
		expect(events).toEqual([
			{ type: "delta", text: "ok" },
			{ type: "done", stopReason: "stop" },
		])
		expect(driver.chat).toHaveBeenCalledTimes(3)
		const retryEvents = dispatch.events.filter((e) => e.state === "retry")
		expect(retryEvents).toHaveLength(2)
		expect(retryEvents[0].attempt).toBe(1)
		expect(retryEvents[1].attempt).toBe(2)
		const states = dispatch.events.map((e) => e.state)
		expect(states).toEqual(["before", "retry", "retry", "after"])
		expect(dispatch.events.at(-1)?.status).toBe("ok")
	})
})

describe("callDriverWithRetry — non-retriable failure", () => {
	it("fails immediately on a 400 error with zero retry events", async () => {
		const driver = mockDriver([{ kind: "throw", error: { status: 400 } }])
		const dispatch = recordingDispatch()
		const noDelay = vi.fn(async (_ms: number) => {})
		await expect(
			drain(callDriverWithRetry(driver, makeRequest(), DEFAULT_RETRY_POLICY, dispatch, noDelay)),
		).rejects.toEqual({ status: 400 })
		expect(driver.chat).toHaveBeenCalledTimes(1)
		const states = dispatch.events.map((e) => e.state)
		expect(states).toEqual(["before", "after"])
		expect(dispatch.events.at(-1)?.status).toBe("error")
		expect(dispatch.events.filter((e) => e.state === "retry")).toHaveLength(0)
	})
})

describe("callDriverWithRetry — exhaustion", () => {
	it("surfaces the final error after exactly maxRetries retries", async () => {
		const policy = { maxRetries: 2, backoff: "none" as const }
		const driver = mockDriver([
			{ kind: "throw", error: { status: 503 } },
			{ kind: "throw", error: { status: 503 } },
			{ kind: "throw", error: { status: 503 } },
		])
		const dispatch = recordingDispatch()
		const noDelay = vi.fn(async (_ms: number) => {})
		await expect(
			drain(callDriverWithRetry(driver, makeRequest(), policy, dispatch, noDelay)),
		).rejects.toEqual({ status: 503 })
		// 1 initial + 2 retries = 3 total calls.
		expect(driver.chat).toHaveBeenCalledTimes(3)
		expect(dispatch.events.filter((e) => e.state === "retry")).toHaveLength(2)
		expect(dispatch.events.at(-1)?.status).toBe("error")
	})
})

describe("callDriverWithRetry — default policy attempt count", () => {
	it("makes exactly 4 total calls (1 initial + 3 retries) under the default policy", async () => {
		const driver = mockDriver([
			{ kind: "throw", error: { status: 503 } },
			{ kind: "throw", error: { status: 503 } },
			{ kind: "throw", error: { status: 503 } },
			{ kind: "throw", error: { status: 503 } },
		])
		const dispatch = recordingDispatch()
		const noDelay = vi.fn(async (_ms: number) => {})
		await expect(
			drain(callDriverWithRetry(driver, makeRequest(), DEFAULT_RETRY_POLICY, dispatch, noDelay)),
		).rejects.toEqual({ status: 503 })
		expect(driver.chat).toHaveBeenCalledTimes(4)
		expect(dispatch.events.filter((e) => e.state === "retry")).toHaveLength(3)
	})
})

describe("callDriverWithRetry — backoff 'none'", () => {
	it("completes all retries with zero delay", async () => {
		const policy = { maxRetries: 2, backoff: "none" as const }
		const driver = mockDriver([
			{ kind: "throw", error: { status: 503 } },
			{ kind: "throw", error: { status: 503 } },
		])
		const dispatch = recordingDispatch()
		const noDelay = vi.fn(async (_ms: number) => {})
		await expect(
			drain(callDriverWithRetry(driver, makeRequest(), policy, dispatch, noDelay)),
		).rejects.toEqual({ status: 503 })
		// Every delay call was with 0ms.
		for (const call of noDelay.mock.calls) {
			expect(call[0]).toBe(0)
		}
		expect(noDelay).toHaveBeenCalledTimes(2)
	})
})

describe("callDriverWithRetry — request(before) patch", () => {
	it("applies a handler-returned payload patch to the actual driver call", async () => {
		const driver = mockDriver([
			{
				kind: "events",
				events: [{ type: "done", stopReason: "stop" }],
			},
		])
		const dispatch = recordingDispatch({
			before: { payload: { ...makeRequest(), model: "patched-model" } },
		})
		await drain(callDriverWithRetry(driver, makeRequest(), DEFAULT_RETRY_POLICY, dispatch))
		expect(driver.chat.mock.calls[0][0].model).toBe("patched-model")
	})
})

describe("callDriverWithRetry — done-event retriable", () => {
	it("retries when the driver yields a done event with retriable: true", async () => {
		const driver = mockDriver([
			{
				kind: "done-error",
				event: {
					type: "done",
					stopReason: "error",
					retriable: true,
				} as DriverEvent,
			},
			{
				kind: "events",
				events: [{ type: "done", stopReason: "stop" }],
			},
		])
		const dispatch = recordingDispatch()
		const noDelay = vi.fn(async (_ms: number) => {})
		const events = await drain(
			callDriverWithRetry(driver, makeRequest(), DEFAULT_RETRY_POLICY, dispatch, noDelay),
		)
		// The retriable done event is swallowed (not yielded); only the final
		// success done event is yielded.
		expect(events).toEqual([{ type: "done", stopReason: "stop" }])
		expect(driver.chat).toHaveBeenCalledTimes(2)
		expect(dispatch.events.filter((e) => e.state === "retry")).toHaveLength(1)
	})

	it("yields a non-retriable done-error event and stops", async () => {
		const driver = mockDriver([
			{
				kind: "done-error",
				event: {
					type: "done",
					stopReason: "error",
					error: new Error("nope"),
				} as DriverEvent,
			},
		])
		const dispatch = recordingDispatch()
		const noDelay = vi.fn(async (_ms: number) => {})
		const events = await drain(
			callDriverWithRetry(driver, makeRequest(), DEFAULT_RETRY_POLICY, dispatch, noDelay),
		)
		expect(events).toEqual([
			{
				type: "done",
				stopReason: "error",
				error: new Error("nope"),
			},
		])
		expect(driver.chat).toHaveBeenCalledTimes(1)
		expect(dispatch.events.filter((e) => e.state === "retry")).toHaveLength(0)
		expect(dispatch.events.at(-1)?.status).toBe("error")
	})
})

describe("callDriverWithRetry — abort during backoff", () => {
	it("surfaces an abort done event when signal fires during the wait", async () => {
		const controller = new AbortController()
		const request = makeRequest({ signal: controller.signal })
		const driver = mockDriver([
			{ kind: "throw", error: { status: 503 } },
			{ kind: "throw", error: { status: 503 } },
		])
		const dispatch = recordingDispatch()
		// Delay that aborts on the first call.
		const delay = vi.fn(async (_ms: number, signal?: AbortSignal) => {
			controller.abort()
			if (signal?.aborted) {
				const err = new Error("aborted")
				err.name = "AbortError"
				throw err
			}
		})
		const events = await drain(
			callDriverWithRetry(driver, request, DEFAULT_RETRY_POLICY, dispatch, delay),
		)
		expect(events).toHaveLength(1)
		expect(events[0].type).toBe("done")
		if (events[0].type === "done") {
			expect(events[0].stopReason).toBe("abort")
		}
		expect(dispatch.events.at(-1)?.status).toBe("error")
	})
})

describe("callDriverWithRetry — request(before) block", () => {
	it("throws when a before handler blocks, without calling the driver", async () => {
		const driver = mockDriver([{ kind: "events", events: [{ type: "done", stopReason: "stop" }] }])
		const dispatch = recordingDispatch({
			before: {
				block: true,
				reason: "nope",
			} as unknown as Partial<RequestEventPayload>,
		})
		await expect(
			drain(callDriverWithRetry(driver, makeRequest(), DEFAULT_RETRY_POLICY, dispatch)),
		).rejects.toThrow(/blocked/)
		expect(driver.chat).not.toHaveBeenCalled()
		expect(dispatch.events.at(-1)?.status).toBe("error")
	})
})
