// Transport retry policy & request lifecycle events (ARCHITECTURE.md § 10.1,
// § 8.1, § 8.5). This module sits between the agent loop (TASK_0025+) and any
// `BHZAIDriver.chat()` call, retrying only transient transport failures and
// emitting the `request` lifecycle event (`before` → `retry`* → `after`) so
// hosts can observe and patch outgoing driver calls.
//
// Scope of THIS file (TASK_0018): the `RetryPolicy` type, a
// `DEFAULT_RETRY_POLICY` constant, an explicit `isRetriableError(error)`
// classifier, and the `callDriverWithRetry(driver, request, policy, dispatch)`
// wrapper. It does NOT implement any driver (TASK_0019/0020), the agent loop
// (TASK_0025+), or the event bus itself (TASK_0004) — only the retry wrapper
// and its classifier.
//
// THE DISPATCH vs EMIT DISTINCTION (explicit assumption, § 8.4):
// This module fires the reserved `request` event via the bus's internal
// `dispatch` path, not the public, guarded `emit()`, per § 8.4's note that
// kernel lifecycle emissions are not a privileged side channel — same
// semantics, different entry point that skips the plugin-facing reserved-name
// check. `request` is in the § 8.1 reserved-namespace list, so a plugin
// calling the public `emit()` with the name `request` must throw; this
// kernel-internal wrapper uses `dispatch()` (the same internal bypass
// `EventBus` exposes for kernel-originated events) to fire it.
//
// ENVIRONMENT BOUNDARY (§ 5): web-standard APIs only. This file touches only
// `AbortSignal`, async iterables, and `setTimeout` (via a swappable delay
// function for testability). No Node built-ins, no DOM, no imports from
// `src/plugins/**`.
//
// PATH NOTE: TASK_0018 specifies `bhzai/src/kernel/retry.ts`, but the package
// layout already established by TASK_0002/TASK_0003 places the kernel under
// `src/core/` (see `src/core/index.ts` and the `./core` subpath export in
// `package.json`). This file follows the existing repo convention; the
// behavioral contract is unchanged.

import type { BHZAIDriver, ChatRequest, DriverEvent, EmitResult } from "../types/index.js"

/**
 * The dispatch primitive this module uses to fire the reserved `request`
 * event. This is the internal, unguarded entry point `EventBus.dispatch()`
 * exposes for kernel-originated events (see the file-header note and § 8.4).
 *
 * Modeled as an injected function (rather than importing `EventBus` directly)
 * so this module stays decoupled from the bus's concrete class shape and is
 * unit-testable with a plain recording fake. The signature mirrors
 * `EventBus.dispatch`'s public contract: it dispatches `event` with `payload`
 * (optionally blockable) and resolves with an {@link EmitResult} whose
 * `patch` field carries any handler-returned patches and whose `blocked`
 * field signals a blockable handler that returned `{ block: true }`.
 */
export type RequestDispatch = (
	event: "request",
	payload: RequestEventPayload,
	options?: { blockable?: boolean },
) => Promise<EmitResult<RequestEventPayload>>

/**
 * Payload of the `request` lifecycle event (§ 8.1, § 10.1).
 *
 * - `state: 'before'` — fired once before the first attempt; `payload` is the
 *   `ChatRequest` about to be sent. A handler may return `{ payload:
 *   partialRequest }` to patch the request (§ 8.1: "`before` may return a
 *   modified payload").
 * - `state: 'retry'` — fired before each retry attempt (after the first
 *   failure); `payload` is the patched request that will be re-sent, and
 *   `attempt` is the 1-based retry number. The `attempt` field is this task's
 *   own backward-compatible addition (the spec's payload highlights column
 *   doesn't spell out `retry`'s exact fields beyond reusing `before`'s
 *   `{ payload }` shape).
 * - `state: 'after'` — fired once after the call settles (success or final
 *   failure); `status` is `'ok'` or `'error'`. `headers` is `undefined` for
 *   both bundled drivers since the `BHZAIDriver` interface does not surface
 *   raw HTTP headers; a future driver plugin with real HTTP semantics may
 *   populate it.
 */
export interface RequestEventPayload {
	state: "before" | "retry" | "after"
	payload?: ChatRequest
	attempt?: number
	status?: "ok" | "error"
	headers?: Record<string, string>
	block?: boolean
	reason?: string
}

/**
 * Retry policy (§ 10.1). `maxRetries` is the number of retry attempts after
 * the initial call (so `maxRetries: 3` means up to 4 total `driver.chat()`
 * calls). `backoff` is the inter-attempt delay strategy.
 *
 * EXPLICIT ASSUMPTION: § 10.1 only names `'exponential'` as a backoff
 * strategy in the default policy; it does not enumerate the full set of
 * legal `backoff` values. This task adds `'none'` (zero delay between
 * attempts, useful for tests and for hosts that want to disable backoff
 * delay without disabling retries entirely) as the only other legal value,
 * since the spec doesn't rule it out and it is the minimal extension needed
 * for deterministic, fast unit tests. Do not add other backoff strategies
 * (linear, jittered, etc.) — that would be unrequested scope creep; if a
 * future task needs them, it should extend this union, not this task.
 */
export interface RetryPolicy {
	maxRetries: number
	backoff: "exponential" | "none"
}

/**
 * The default retry policy (§ 10.1): `{ maxRetries: 3, backoff:
 * 'exponential' }`.
 */
export const DEFAULT_RETRY_POLICY: RetryPolicy = {
	maxRetries: 3,
	backoff: "exponential",
}

/**
 * Exponential backoff delay formula (explicit assumption, since the spec
 * gives no formula): `delayMs = 250 * 2 ** attemptIndex` (attempt 0 → 250ms,
 * attempt 1 → 500ms, attempt 2 → 1000ms), capped at 4000ms. A future task
 * may tune these constants without violating the documented contract,
 * provided `maxRetries`/`backoff` semantics stay intact.
 *
 * @param attemptIndex 0-based index of the attempt that just failed (the
 *   first retry happens after attempt 0 fails).
 * @returns Delay in milliseconds before the next attempt.
 */
export function exponentialBackoffDelay(attemptIndex: number): number {
	const base = 250
	const cap = 4000
	return Math.min(base * 2 ** attemptIndex, cap)
}

/**
 * A swappable delay function. The default uses `setTimeout`; tests inject a
 * fake to make backoff deterministic and fast. Exposed as a parameter on
 * {@link callDriverWithRetry} so callers (and tests) can override it without
 * monkey-patching globals.
 */
export type DelayFn = (ms: number, signal?: AbortSignal) => Promise<void>

/**
 * Default delay function: `setTimeout`-based, reject on `signal` abort.
 *
 * If `signal` is already aborted, rejects immediately. If `signal` fires
 * during the wait, rejects immediately with an `AbortError`-shaped error
 * (name `'AbortError'`) so the retry loop can surface an abort outcome
 * without attempting a further retry.
 */
export const defaultDelay: DelayFn = (ms, signal) =>
	new Promise<void>((resolve, reject) => {
		if (signal?.aborted) {
			const err = new Error("Aborted")
			err.name = "AbortError"
			reject(err)
			return
		}
		if (ms <= 0) {
			resolve()
			return
		}
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

/**
 * Classify whether an error is a transient transport/rate-limit failure that
 * the retry wrapper should retry (§ 10.1: "retrying only transient
 * transport/rate-limit errors").
 *
 * The architecture doc says only "retrying only transient transport/rate-limit
 * errors" without enumerating what counts as transient. This classifier
 * defines the exact, explicit classification:
 *
 * **Retriable (transient)**:
 * 1. A thrown error that is a network-level failure — i.e. a `TypeError`
 *    thrown by `fetch` itself (covers connection refused, DNS failure, and
 *    similar "failed to fetch" conditions in both browser and Node `fetch`
 *    implementations), OR an error object exposing a recognizable
 *    `cause`/`name` indicating a network fault (`error.name === 'TypeError'`
 *    or `error.name === 'NetworkError'`).
 * 2. An error carrying an HTTP `status` (or `response.status`) of `429`
 *    (rate limited), `502` (bad gateway), `503` (service unavailable), or
 *    `504` (gateway timeout). The expected error shape is
 *    `{ status?: number; retriable?: boolean }` (a loosely-typed `unknown`
 *    narrowed via a type guard) since drivers throw whatever shape is natural
 *    for their own transport, and this wrapper cannot assume a single error
 *    class hierarchy across driver plugins.
 * 3. A `DriverEvent` of `{ type: 'done', stopReason: 'error', error }` where
 *    the driver has explicitly signaled retriability by attaching
 *    `retriable: true` somewhere reachable on the event or its nested
 *    `error`. The exact narrow shape checked is
 *    `event.type === 'done' && event.stopReason === 'error' &&
 *     (event as { retriable?: boolean }).retriable === true`. This is the
 *    mechanism by which a driver that already knows "this specific failure
 *    is safe to retry" (e.g. it caught a 503 internally rather than letting
 *    `chat()` throw) can still request a kernel-level retry without the
 *    kernel having to parse driver-specific error shapes.
 *
 * **Non-retriable (do not retry)**:
 * - Any HTTP status in the `4xx` range other than `429` (e.g. `400` Bad
 *   Request, `401` Unauthorized, `403` Forbidden, `404` Not Found) — these
 *   indicate a malformed request or an auth/permission problem that a retry
 *   cannot fix.
 * - An `AbortError` (the request was cancelled via `AbortSignal` — retrying
 *   a deliberate cancellation would be actively wrong).
 * - Any error that does not match one of the three retriable patterns above
 *   — the default is **not retriable**, since silently retrying unclassified
 *   errors risks masking real bugs (e.g. a programming error inside a
 *   driver) behind repeated retries.
 *
 * Exported as a named function so it is unit-testable in isolation, not
 * buried as inline logic inside the retry loop.
 *
 * @param error The thrown error or yielded `done` event to classify.
 * @returns `true` if the failure is transient and should be retried.
 */
export function isRetriableError(error: unknown): boolean {
	if (error == null) return false

	// Pattern 3: a `done` DriverEvent with `retriable: true` on the event.
	if (typeof error === "object") {
		const evt = error as {
			type?: string
			stopReason?: string
			retriable?: boolean
		}
		if (evt.type === "done" && evt.stopReason === "error" && evt.retriable === true) {
			return true
		}
	}

	// AbortError: never retry a deliberate cancellation.
	if (error instanceof Error && error.name === "AbortError") {
		return false
	}

	// Pattern 1: network-level failure (fetch TypeError / NetworkError).
	if (error instanceof Error) {
		if (error.name === "TypeError" || error.name === "NetworkError") {
			return true
		}
	}

	// Pattern 2: HTTP status on the error object (or nested `response`).
	if (typeof error === "object") {
		const e = error as {
			status?: number
			retriable?: boolean
			response?: { status?: number }
		}
		// Explicit `retriable: true` short-circuits to retriable.
		if (e.retriable === true) return true
		if (e.retriable === false) return false
		const status = typeof e.status === "number" ? e.status : e.response?.status
		if (typeof status === "number") {
			return status === 429 || status === 502 || status === 503 || status === 504
		}
	}

	return false
}

/**
 * Wrap a `BHZAIDriver.chat()` call with transport retry policy and `request`
 * lifecycle events (§ 10.1, § 8.5 step 8.2).
 *
 * Behavior:
 * 1. Before the first attempt, dispatch `request` with `state: 'before'` and
 *    payload `{ payload: request }`. Await the result; if any handler in the
 *    chain returned a patch (e.g. `{ payload: partialRequest }`), shallow-
 *    merge it onto `request` per § 8.2's patch-chaining rule, and use the
 *    patched request for the actual `driver.chat()` call. If a handler
 *    returns `{ block: true }`, treat it like any other blockable kernel
 *    event: stop before calling the driver at all and surface a rejection to
 *    the caller (consistent with § 8.2's general blocking contract, since
 *    § 8.1's `request` row does not explicitly mention blocking — this
 *    extends it uniformly with the rest of the event model rather than
 *    special-casing `request` as non-blockable).
 * 2. Call `driver.chat(patchedRequest)` and iterate its
 *    `AsyncIterable<DriverEvent>`, re-yielding every event to the caller as
 *    it arrives (this wrapper is a transparent pass-through on the happy
 *    path — callers cannot tell they're going through a wrapper unless a
 *    retry occurs).
 * 3. If iterating the driver's async iterable throws, or if a yielded event
 *    is `{ type: 'done', stopReason: 'error', ... }` that also satisfies the
 *    retriable classification:
 *    - If `isRetriableError` returns `false`, or the number of attempts
 *      already made equals `policy.maxRetries`, stop retrying: dispatch
 *      `request` with `state: 'after'` (payload `{ status: 'error', headers:
 *      undefined }`) and propagate the failure to the caller (re-throw the
 *      original error, or yield the terminal `done` event with
 *      `stopReason: 'error'` and stop iterating — preserving throw-vs-yield
 *      fidelity rather than converting one into the other).
 *    - Otherwise: dispatch `request` with `state: 'retry'` and payload
 *      `{ payload: patchedRequest, attempt: <1-based retry number> }`, wait
 *      according to `policy.backoff`, increment the attempt counter, and go
 *      back to step 2 (restart `driver.chat()` from scratch with the same
 *      patched request — do NOT re-run `request(before)` handlers on a
 *      retry, since `before` semantically means "before the first attempt").
 * 4. On eventual success (the iterable completes without throwing and its
 *    terminal `done` event has a `stopReason` other than `error`, or is
 *    absent because the driver simply stopped yielding), dispatch `request`
 *    with `state: 'after'` and payload `{ status: 'ok', headers: undefined }`.
 *
 * EDGE CASE — partial output before a retry: events already yielded have
 * reached the caller (e.g. partially rendered in a chat UI) before the retry
 * restarts the whole call from scratch. This wrapper does not attempt to
 * "un-yield" or deduplicate partial output — that is an agent-loop/UI concern
 * for a different task. This wrapper's job stops at faithfully replaying the
 * retry-and-restart mechanics and firing the right events.
 *
 * EDGE CASE — `AbortSignal` during a retry wait: if `request.signal` fires
 * while the wrapper is waiting on backoff, the delay rejects with an
 * `AbortError`-shaped error; the wrapper surfaces a terminal `done` event
 * with `stopReason: 'abort'`, fires `request(after)` with an error outcome,
 * and propagates an abort (no further retry after an explicit abort,
 * regardless of remaining `maxRetries`).
 *
 * @param driver The driver whose `chat()` is being wrapped.
 * @param request The original chat request.
 * @param policy Retry policy; defaults to {@link DEFAULT_RETRY_POLICY}.
 * @param dispatch The bus's internal `dispatch` primitive used to fire the
 *   reserved `request` event (see the file-header note on the dispatch vs
 *   emit distinction).
 * @param delay Optional override of the delay function (for tests).
 */
export async function* callDriverWithRetry(
	driver: BHZAIDriver,
	request: ChatRequest,
	policy: RetryPolicy,
	dispatch: RequestDispatch,
	delay: DelayFn = defaultDelay,
): AsyncIterable<DriverEvent> {
	// Step 1: fire `request(before)`, apply any handler-returned patch.
	const beforeResult = await dispatch(
		"request",
		{ state: "before", payload: request },
		{ blockable: true },
	)
	if (beforeResult.blocked) {
		// A handler blocked the call — surface a rejection to the caller and
		// fire `request(after)` with an error outcome, consistent with § 8.2's
		// general blocking contract.
		await dispatch("request", {
			state: "after",
			status: "error",
			headers: undefined,
		})
		throw new Error(
			`callDriverWithRetry: request(before) was blocked by a handler${beforeResult.reason ? `: ${beforeResult.reason}` : ""}`,
		)
	}
	let patchedRequest: ChatRequest = request
	const beforePatch = beforeResult.patch as Partial<RequestEventPayload>
	if (beforePatch && typeof beforePatch.payload === "object" && beforePatch.payload) {
		patchedRequest = { ...patchedRequest, ...beforePatch.payload }
	}

	// Step 2–4: attempt loop.
	let attempt = 0
	while (true) {
		// Acquire the async iterable, catching synchronous throws from
		// `chat()` (treated identically to a thrown error mid-iteration).
		let iter: AsyncIterable<DriverEvent> | null = null
		try {
			iter = driver.chat(patchedRequest)
		} catch (err) {
			const outcome = await classifyAndMaybeScheduleRetry(
				err,
				attempt,
				policy,
				patchedRequest,
				dispatch,
				delay,
				request.signal,
			)
			switch (outcome.kind) {
				case "propagate-throw":
					throw outcome.error
				case "abort":
					yield outcome.event
					return
				case "retry":
					attempt = outcome.attempt
					continue
			}
		}

		// Iterate the driver's stream, looking for a terminal error event.
		// `iter` is non-null here: the catch block above always throws, returns,
		// or continues before reaching this point.
		const driverIter = iter as AsyncIterable<DriverEvent>
		let failureMode:
			| { kind: "throw"; error: unknown }
			| { kind: "done-event"; event: DriverEvent }
			| null = null
		try {
			for await (const event of driverIter) {
				if (event.type === "done" && event.stopReason === "error") {
					// Terminal error event — hold it back and check retriability
					// after the loop. If retriable, swallow and retry; if not,
					// re-yield it after the loop.
					failureMode = { kind: "done-event", event }
					break
				}
				yield event
			}
		} catch (err) {
			failureMode = { kind: "throw", error: err }
		}

		if (failureMode === null) {
			// Success: iterable completed without a terminal error event.
			await dispatch("request", {
				state: "after",
				status: "ok",
				headers: undefined,
			})
			return
		}

		// Classify the failure and either retry or propagate.
		const classifyTarget = failureMode.kind === "throw" ? failureMode.error : failureMode.event
		const outcome = await classifyAndMaybeScheduleRetry(
			classifyTarget,
			attempt,
			policy,
			patchedRequest,
			dispatch,
			delay,
			request.signal,
		)
		switch (outcome.kind) {
			case "propagate-throw":
				throw outcome.error
			case "propagate-done":
				yield outcome.event
				return
			case "abort":
				yield outcome.event
				return
			case "retry":
				attempt = outcome.attempt
		}
	}
}

/**
 * Internal outcome of classifying a failure and deciding what to do next.
 */
type RetryOutcome =
	| { kind: "retry"; attempt: number }
	| { kind: "propagate-throw"; error: unknown }
	| { kind: "propagate-done"; event: DriverEvent }
	| { kind: "abort"; event: DriverEvent }

/**
 * Internal helper: classify a failure, fire the appropriate `request` event(s),
 * wait on backoff if retrying, and return the outcome. Shared by the
 * synchronous-throw and in-iteration failure paths so the retry logic stays
 * in one place.
 *
 * @param failure The thrown error or terminal `done` event to classify.
 * @param attempt The current 0-based attempt index (before incrementing).
 * @param policy The retry policy.
 * @param patchedRequest The patched request (for the `retry` event payload).
 * @param dispatch The dispatch primitive.
 * @param delay The delay function.
 * @param signal The request's abort signal.
 * @returns The outcome: `retry` (loop again), `propagate-throw` (re-throw),
 *   `propagate-done` (yield the held-back done event), or `abort` (yield an
 *   abort done event).
 */
async function classifyAndMaybeScheduleRetry(
	failure: unknown,
	attempt: number,
	policy: RetryPolicy,
	patchedRequest: ChatRequest,
	dispatch: RequestDispatch,
	delay: DelayFn,
	signal: AbortSignal,
): Promise<RetryOutcome> {
	const retriable = isRetriableError(failure)
	const exhausted = attempt >= policy.maxRetries

	if (!retriable || exhausted) {
		// Final failure: fire `request(after)` with error outcome and
		// propagate, preserving throw-vs-yield fidelity.
		await dispatch("request", {
			state: "after",
			status: "error",
			headers: undefined,
		})
		// If the failure was a done event, propagate it as a yield; otherwise
		// re-throw.
		if (
			typeof failure === "object" &&
			failure !== null &&
			(failure as { type?: string }).type === "done"
		) {
			return { kind: "propagate-done", event: failure as DriverEvent }
		}
		return { kind: "propagate-throw", error: failure }
	}

	// Retriable and not exhausted: fire `request(retry)`, wait, retry.
	const nextAttempt = attempt + 1
	await dispatch("request", {
		state: "retry",
		payload: patchedRequest,
		attempt: nextAttempt,
	})

	// Wait according to backoff, honoring abort.
	const delayMs = policy.backoff === "exponential" ? exponentialBackoffDelay(attempt) : 0
	try {
		await delay(delayMs, signal)
	} catch (err) {
		// Abort during backoff wait: surface abort, no further retry.
		await dispatch("request", {
			state: "after",
			status: "error",
			headers: undefined,
		})
		return {
			kind: "abort",
			event: { type: "done", stopReason: "abort", error: err },
		}
	}
	return { kind: "retry", attempt: nextAttempt }
}
