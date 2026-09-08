import { describe, expect, it, vi } from "vitest"
import type { BHZAIDriver, ChatRequest, DriverEvent } from "../types/driver"
import { ContextOverflowError } from "./errors"
import {
	calculateDelay,
	callDriverWithRetry,
	exponentialBackoffDelay,
	isRetriableError,
} from "./retry"
import type { RetryPolicy } from "./types"

describe("isRetriableError", () => {
	it("returns false for null, undefined, or empty values", () => {
		expect(isRetriableError(null)).toBe(false)
		expect(isRetriableError(undefined)).toBe(false)
		expect(isRetriableError("")).toBe(false)
	})

	it("returns false for AbortError", () => {
		const abortErr = new Error("Aborted")
		abortErr.name = "AbortError"
		expect(isRetriableError(abortErr)).toBe(false)
	})

	it("returns false for ContextOverflowError and overflow strings", () => {
		expect(isRetriableError(new ContextOverflowError("Exceeded"))).toBe(false)
		expect(isRetriableError(new Error("This model's maximum context length is 8192 tokens."))).toBe(
			false,
		)
		expect(isRetriableError({ code: "context_length_exceeded" })).toBe(false)
	})

	it("returns true for TypeError and NetworkError", () => {
		const typeErr = new TypeError("Failed to fetch")
		const netErr = new Error("Network offline")
		netErr.name = "NetworkError"
		expect(isRetriableError(typeErr)).toBe(true)
		expect(isRetriableError(netErr)).toBe(true)
	})

	it("returns true for transient HTTP status codes", () => {
		expect(isRetriableError({ status: 429 })).toBe(true)
		expect(isRetriableError({ status: 502 })).toBe(true)
		expect(isRetriableError({ status: 503 })).toBe(true)
		expect(isRetriableError({ status: 504 })).toBe(true)
		expect(isRetriableError({ response: { status: 429 } })).toBe(true)
	})

	it("returns false for non-transient HTTP 4xx status codes", () => {
		expect(isRetriableError({ status: 400 })).toBe(false)
		expect(isRetriableError({ status: 401 })).toBe(false)
		expect(isRetriableError({ status: 403 })).toBe(false)
		expect(isRetriableError({ status: 404 })).toBe(false)
	})

	it("returns true when retriable is explicitly set to true", () => {
		expect(isRetriableError({ retriable: true })).toBe(true)
	})

	it("evaluates done error DriverEvents", () => {
		const doneEventRetriable: DriverEvent = {
			type: "done",
			stopReason: "error",
			error: { status: 503 },
		}
		expect(isRetriableError(doneEventRetriable)).toBe(true)

		const doneEventExplicit: DriverEvent = {
			type: "done",
			stopReason: "error",
			error: { retriable: true },
		}
		expect(isRetriableError(doneEventExplicit)).toBe(true)

		const doneNonRetriable: DriverEvent = {
			type: "done",
			stopReason: "error",
			error: { status: 400 },
		}
		expect(isRetriableError(doneNonRetriable)).toBe(false)
	})
})

describe("delay calculation", () => {
	it("calculates exponential backoff delay capped at 4000ms", () => {
		expect(exponentialBackoffDelay(0)).toBe(250)
		expect(exponentialBackoffDelay(1)).toBe(500)
		expect(exponentialBackoffDelay(2)).toBe(1000)
		expect(exponentialBackoffDelay(3)).toBe(2000)
		expect(exponentialBackoffDelay(4)).toBe(4000)
		expect(exponentialBackoffDelay(10)).toBe(4000)
	})

	it("returns 0 delay for backoff: none", () => {
		const policy: RetryPolicy = { maxRetries: 2, backoff: "none" }
		expect(calculateDelay(policy, 0)).toBe(0)
		expect(calculateDelay(policy, 3)).toBe(0)
	})
})

describe("callDriverWithRetry", () => {
	const dummyRequest: ChatRequest = {
		model: "mock-model",
		messages: [],
		signal: new AbortController().signal,
	}

	it("yields all events on a successful stream without retry", async () => {
		const mockDriver: BHZAIDriver = {
			id: "mock",
			async listModels() {
				return []
			},
			capabilities() {
				return { streaming: true, toolCalls: false, reasoning: false }
			},
			async *chat() {
				yield { type: "delta", text: "Hello " }
				yield { type: "delta", text: "world" }
				yield { type: "done", stopReason: "stop" }
			},
		}

		const events: DriverEvent[] = []
		for await (const event of callDriverWithRetry(mockDriver, dummyRequest)) {
			events.push(event)
		}

		expect(events).toHaveLength(3)
		expect(events[0]).toEqual({ type: "delta", text: "Hello " })
		expect(events[1]).toEqual({ type: "delta", text: "world" })
	})

	it("retries on transient failure and succeeds on subsequent attempt", async () => {
		let attempts = 0
		const mockDriver: BHZAIDriver = {
			id: "mock",
			async listModels() {
				return []
			},
			capabilities() {
				return { streaming: true, toolCalls: false, reasoning: false }
			},
			async *chat() {
				attempts++
				if (attempts === 1) {
					throw { status: 503 }
				}
				yield { type: "delta", text: "Recovered" }
				yield { type: "done", stopReason: "stop" }
			},
		}

		const sleepSpy = vi.fn().mockResolvedValue(undefined)
		const events: DriverEvent[] = []

		for await (const event of callDriverWithRetry(
			mockDriver,
			dummyRequest,
			{ maxRetries: 2, backoff: "none" },
			sleepSpy,
		)) {
			events.push(event)
		}

		expect(attempts).toBe(2)
		expect(sleepSpy).toHaveBeenCalledTimes(1)
		expect(events[0]).toEqual({ type: "delta", text: "Recovered" })
	})

	it("throws normalized ContextOverflowError immediately without retry", async () => {
		let attempts = 0
		const mockDriver: BHZAIDriver = {
			id: "mock",
			async listModels() {
				return []
			},
			capabilities() {
				return { streaming: true, toolCalls: false, reasoning: false }
			},
			async *chat() {
				yield* []
				attempts++
				throw new Error("maximum context length is 8192 tokens")
			},
		}

		const sleepSpy = vi.fn()
		await expect(async () => {
			for await (const _ of callDriverWithRetry(
				mockDriver,
				dummyRequest,
				{ maxRetries: 3, backoff: "none" },
				sleepSpy,
			)) {
				// empty
			}
		}).rejects.toThrow(ContextOverflowError)

		expect(attempts).toBe(1)
		expect(sleepSpy).not.toHaveBeenCalled()
	})

	it("throws immediately on AbortError without retry", async () => {
		const abortErr = new Error("Request aborted")
		abortErr.name = "AbortError"

		const mockDriver: BHZAIDriver = {
			id: "mock",
			async listModels() {
				return []
			},
			capabilities() {
				return { streaming: true, toolCalls: false, reasoning: false }
			},
			async *chat() {
				yield* []
				throw abortErr
			},
		}

		await expect(async () => {
			for await (const _ of callDriverWithRetry(mockDriver, dummyRequest)) {
				// empty
			}
		}).rejects.toThrow("Request aborted")
	})

	it("yields done error event when non-retriable", async () => {
		const mockDriver: BHZAIDriver = {
			id: "mock",
			async listModels() {
				return []
			},
			capabilities() {
				return { streaming: true, toolCalls: false, reasoning: false }
			},
			async *chat() {
				yield {
					type: "done",
					stopReason: "error",
					error: { status: 400 },
				}
			},
		}

		const events: DriverEvent[] = []
		for await (const event of callDriverWithRetry(mockDriver, dummyRequest)) {
			events.push(event)
		}

		expect(events).toHaveLength(1)
		expect(events[0].type).toBe("done")
	})

	it("throws when max retries are exhausted", async () => {
		const mockDriver: BHZAIDriver = {
			id: "mock",
			async listModels() {
				return []
			},
			capabilities() {
				return { streaming: true, toolCalls: false, reasoning: false }
			},
			async *chat() {
				yield* []
				throw { status: 503 }
			},
		}

		await expect(async () => {
			for await (const _ of callDriverWithRetry(mockDriver, dummyRequest, {
				maxRetries: 1,
				backoff: "none",
			})) {
				// empty
			}
		}).rejects.toEqual({ status: 503 })
	})

	it("handles synchronous throw from driver.chat()", async () => {
		const mockDriver: BHZAIDriver = {
			id: "mock",
			async listModels() {
				return []
			},
			capabilities() {
				return { streaming: true, toolCalls: false, reasoning: false }
			},
			chat() {
				throw new Error("Synchronous driver throw")
			},
		}

		await expect(async () => {
			for await (const _ of callDriverWithRetry(mockDriver, dummyRequest)) {
				// empty
			}
		}).rejects.toThrow("Synchronous driver throw")
	})

	it("yields done abort event without throwing", async () => {
		const abortErr = new Error("Aborted")
		abortErr.name = "AbortError"

		const mockDriver: BHZAIDriver = {
			id: "mock",
			async listModels() {
				return []
			},
			capabilities() {
				return { streaming: true, toolCalls: false, reasoning: false }
			},
			async *chat() {
				yield {
					type: "done",
					stopReason: "error",
					error: abortErr,
				}
			},
		}

		const events: DriverEvent[] = []
		for await (const event of callDriverWithRetry(mockDriver, dummyRequest)) {
			events.push(event)
		}

		expect(events).toHaveLength(1)
		expect(events[0].type).toBe("done")
	})
})

describe("defaultSleep", () => {
	it("resolves immediately when ms <= 0", async () => {
		const { defaultSleep } = await import("./retry")
		await expect(defaultSleep(0)).resolves.toBeUndefined()
		await expect(defaultSleep(-10)).resolves.toBeUndefined()
	})

	it("rejects immediately if signal is already aborted", async () => {
		const { defaultSleep } = await import("./retry")
		const controller = new AbortController()
		controller.abort()

		await expect(defaultSleep(100, controller.signal)).rejects.toThrow("Aborted")
	})

	it("sleeps for specified duration and resolves", async () => {
		const { defaultSleep } = await import("./retry")
		await expect(defaultSleep(5)).resolves.toBeUndefined()
	})

	it("aborts when signal fires during sleep", async () => {
		const { defaultSleep } = await import("./retry")
		const controller = new AbortController()
		const sleepPromise = defaultSleep(1000, controller.signal)

		setTimeout(() => controller.abort(), 10)
		await expect(sleepPromise).rejects.toThrow("Aborted")
	})
})
