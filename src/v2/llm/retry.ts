import type { BHZAIDriver, ChatRequest, DriverEvent } from "../../types/driver"
import { ContextOverflowError, isContextOverflowError } from "./errors"
import type { RetryPolicy } from "./types"

/**
 * The default retry policy: up to 3 retries with exponential backoff.
 */
export const DEFAULT_RETRY_POLICY: RetryPolicy = {
	maxRetries: 3,
	backoff: "exponential",
}

/**
 * Calculates exponential backoff delay in milliseconds.
 * @param attemptIndex 0-based attempt index.
 * @returns Delay in milliseconds.
 */
export function exponentialBackoffDelay(attemptIndex: number): number {
	const base = 250
	const cap = 4000
	return Math.min(base * 2 ** attemptIndex, cap)
}

/**
 * Calculates delay based on the configured retry policy.
 * @param policy The retry policy.
 * @param attemptIndex 0-based retry attempt number.
 * @returns Delay in milliseconds.
 */
export function calculateDelay(policy: RetryPolicy, attemptIndex: number): number {
	if (policy.backoff === "none") {
		return 0
	}
	return exponentialBackoffDelay(attemptIndex)
}

/**
 * Promisified sleep supporting AbortSignal cancellation.
 * @param ms Duration to wait in milliseconds.
 * @param signal Optional AbortSignal.
 */
export async function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
	if (signal?.aborted) {
		const err = new Error("Aborted")
		err.name = "AbortError"
		throw err
	}
	if (ms <= 0) return

	await new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort)
			resolve()
		}, ms)
		const onAbort = () => {
			clearTimeout(timer)
			signal?.removeEventListener("abort", onAbort)
			const err = new Error("Aborted")
			err.name = "AbortError"
			reject(err)
		}
		signal?.addEventListener("abort", onAbort, { once: true })
	})
}

/**
 * Classifies whether a failure represents a transient error that should be retried.
 * @param error Error or event to evaluate.
 * @returns True if the failure is transient and eligible for retry.
 */
export function isRetriableError(error: unknown): boolean {
	if (error == null) return false
	if (isContextOverflowError(error)) return false

	if (error instanceof Error && error.name === "AbortError") {
		return false
	}

	if (isDoneEventRetriable(error)) {
		return true
	}

	if (error instanceof Error && (error.name === "TypeError" || error.name === "NetworkError")) {
		return true
	}

	return isHttpStatusRetriable(error)
}

function isDoneEventRetriable(error: unknown): boolean {
	if (typeof error !== "object" || error === null) return false
	const evt = error as { type?: string; stopReason?: string; retriable?: boolean; error?: unknown }
	if (evt.type !== "done" || evt.stopReason !== "error") return false
	if (evt.retriable === true) return true
	return isHttpStatusRetriable(evt.error)
}

function isHttpStatusRetriable(error: unknown): boolean {
	if (typeof error !== "object" || error === null) return false
	const e = error as { status?: number; retriable?: boolean; response?: { status?: number } }
	if (e.retriable === true) return true
	const status = e.status ?? e.response?.status
	if (typeof status === "number") {
		if (status === 429 || status === 502 || status === 503 || status === 504) {
			return true
		}
		if (status >= 400 && status < 500) {
			return false
		}
	}
	return false
}

type DelayFn = (ms: number, signal?: AbortSignal) => Promise<void>

type StreamFailure = { kind: "throw"; error: unknown } | { kind: "done"; event: DriverEvent }

async function handleStreamAttempt(
	driver: BHZAIDriver,
	request: ChatRequest,
	yieldEvent: (event: DriverEvent) => void,
): Promise<StreamFailure | null> {
	let iter: AsyncIterable<DriverEvent>
	try {
		iter = driver.chat(request)
	} catch (err) {
		return { kind: "throw", error: err }
	}

	try {
		for await (const event of iter) {
			if (event.type === "done" && event.stopReason === "error") {
				return { kind: "done", event }
			}
			yieldEvent(event)
		}
		return null
	} catch (err) {
		return { kind: "throw", error: err }
	}
}

interface StreamDecision {
	action: "throw" | "yield" | "retry"
	error?: unknown
	event?: DriverEvent
	delayMs?: number
}

function evaluateStreamFailure(
	failure: StreamFailure,
	attempt: number,
	policy: RetryPolicy,
	signal?: AbortSignal,
): StreamDecision {
	const errTarget =
		failure.kind === "throw"
			? failure.error
			: ((failure.event as { error?: unknown }).error ?? failure.event)

	if (isContextOverflowError(errTarget)) {
		const msg = errTarget instanceof Error ? errTarget.message : "Context length exceeded for model"
		return { action: "throw", error: new ContextOverflowError(msg, errTarget) }
	}

	if (signal?.aborted || (errTarget instanceof Error && errTarget.name === "AbortError")) {
		return failure.kind === "throw"
			? { action: "throw", error: errTarget }
			: { action: "yield", event: failure.event }
	}

	if (isRetriableError(errTarget) && attempt < policy.maxRetries) {
		const delayMs = calculateDelay(policy, attempt)
		return { action: "retry", delayMs }
	}

	return failure.kind === "throw"
		? { action: "throw", error: failure.error }
		: { action: "yield", event: failure.event }
}

/**
 * Invokes driver.chat() with retry backoff and error normalization.
 * @param driver The driver to invoke.
 * @param request The chat request.
 * @param policy Retry policy.
 * @param sleepFn Delay function override.
 */
export async function* callDriverWithRetry(
	driver: BHZAIDriver,
	request: ChatRequest,
	policy: RetryPolicy = DEFAULT_RETRY_POLICY,
	sleepFn: DelayFn = defaultSleep,
): AsyncIterable<DriverEvent> {
	let attempt = 0

	while (true) {
		const buffered: DriverEvent[] = []
		const failure = await handleStreamAttempt(driver, request, (e) => buffered.push(e))

		for (const event of buffered) {
			yield event
		}

		if (!failure) return

		const decision = evaluateStreamFailure(failure, attempt, policy, request.signal)
		if (decision.action === "throw") {
			throw decision.error
		}
		if (decision.action === "yield") {
			if (decision.event) yield decision.event
			return
		}
		if (decision.action === "retry") {
			await sleepFn(decision.delayMs ?? 0, request.signal)
			attempt++
		}
	}
}
