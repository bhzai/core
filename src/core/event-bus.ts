// Framework event bus — the single dispatch mechanism underpinning every
// observable behavior in BHZAI (§ 8). One instance lives on each `BHZAI` kernel
// (the framework bus); TASK_0023 will instantiate one per `Conversation` too,
// reusing this exact class unchanged.
//
// Scope of THIS file (TASK_0004): the standalone, reusable `EventBus` class
// implementing § 8.2's five handler-semantics rules and § 8.4's emission
// asymmetry — sequential awaited dispatch with patch chaining, blockable
// pipelines, error containment + rerouting, reserved-namespace enforcement on
// the public `emit()` with an internal `dispatch()` bypass for kernel-originated
// events, and global per-bus FIFO serialization of re-entrant emissions.
//
// ENVIRONMENT BOUNDARY (§ 5): web-standard APIs only. This file touches nothing
// outside of plain TypeScript — no `fetch`, no `crypto`, no timers. It is
// runtime-agnostic and safe to instantiate in any environment.
//
// PATH NOTE: TASK_0004 specifies `bhzai/src/kernel/event-bus.ts`, but the
// package layout already established by TASK_0002/TASK_0003 places the kernel
// under `src/core/` (see `src/core/index.ts` and the `./core` subpath export in
// `package.json`). This file follows the existing repo convention; the
// behavioral contract is unchanged.

import type { EmitResult, Unsubscribe } from "../types/events.js"

/**
 * A signal a handler can return (only meaningful on dispatches made with
 * `{ blockable: true }`) to stop the handler chain early.
 *
 * Per § 8.2 rule 3, `{ block: true, reason? }` is documented as the block
 * signal. On a non-blockable dispatch it is treated as an ordinary (if
 * unusual) patch object and merged in with no special stopping behavior.
 */
export interface BlockSignal {
	block: true
	reason?: string
}

/**
 * A handler registered via {@link EventBus.on}. Receives the current (possibly
 * already-patched) payload and may return:
 * - `undefined`/`void` — observe-only, no patch;
 * - a partial patch object — shallow-merged into the running payload before
 *   the next handler runs (§ 8.2 rule 2);
 * - a {@link BlockSignal} — on a blockable dispatch, stops the chain (rule 3).
 *
 * Handlers are always awaited in registration order (rule 1); a handler that
 * throws is caught, its error rerouted to the `error` framework event, and
 * treated as "no patch" (rule 4) — the remaining handlers still run.
 */
export type Handler<Payload> = (payload: Payload) =>
	| void
	| Partial<Payload>
	| BlockSignal
	| (Partial<Payload> & BlockSignal)
	// biome-ignore lint/suspicious/noConfusingVoidType: spec (§ 8.2) defines handler returns with `void` for observe-only handlers
	| Promise<void | Partial<Payload> | BlockSignal | (Partial<Payload> & BlockSignal)>

/**
 * Per-dispatch options.
 *
 * `blockable` is caller-supplied rather than hardcoded per event name: the
 * § 8.1 tables (which mark specific named events as blockable) are owned by
 * whichever task fires each event. This bus only provides the mechanism — the
 * caller passes `{ blockable: true }` when dispatching an event the spec marks
 * blockable (e.g. `tool(beforeCall)` in TASK_0023), and leaves it falsy
 * otherwise. This keeps the bus decoupled from any closed set of event names.
 */
export interface DispatchOptions {
	/**
	 * Whether a handler returning `{ block: true }` on this dispatch actually
	 * stops later handlers. Defaults to `false` — a block signal is then merged
	 * in like any other patch with no special stopping behavior.
	 */
	blockable?: boolean
}

/**
 * Reserved event names/prefixes that only the kernel may dispatch (§ 8.4).
 *
 * `compact` is listed in § 8.4's reserved set but is exempted from the public
 * `emit()` throw — it is a legal manual trigger the kernel intercepts to start
 * the compaction pipeline. The exemption is handled in {@link
 * EventBus.assertEmitName}, not by omitting it here, so the reservation is
 * still visible in this table for documentation.
 */
const RESERVED_EXACT: ReadonlySet<string> = new Set([
	"message",
	"message.delta",
	"tool",
	"context",
	"request",
	"turn",
	"abort",
	"compact", // exempted from throwing in assertEmitName; see TODO(TASK_0031)
	"initialize",
	"dispose",
	"error",
])

const RESERVED_PREFIXES: readonly string[] = [
	"conversation.",
	"driver.",
	"mcp.",
	"config.",
	"model.",
	"models.",
]

/**
 * `EventBus` implements BHZAI's uniform event semantics (§ 8) for a single
 * scope — one instance per `BHZAI` kernel (the framework bus) and, later, one
 * per `Conversation` (TASK_0023).
 *
 * The class is intentionally standalone and framework-agnostic: it knows
 * nothing about plugins, conversations, or the kernel. It only maintains an
 * ordered handler list per event name and serializes dispatches through a
 * single global FIFO queue so two dispatches never interleave on one bus
 * (§ 8.4 rule 2).
 */
export class EventBus {
	/**
	 * Registered handlers per event name, in registration order. A plain array
	 * per name (not a Set) because order matters and duplicate registrations of
	 * the same handler are permitted.
	 */
	private readonly handlers: Map<string, Array<Handler<unknown>>> = new Map()

	/**
	 * Owner (plugin name) of each registered handler, for plugin activation
	 * gating. Only handlers registered with an explicit `owner` appear here;
	 * everything else is unowned and therefore never gated.
	 *
	 * A `WeakMap` keyed by the handler function keeps the `handlers` arrays and
	 * the `indexOf`-based unsubscribe above untouched — the alternative,
	 * restructuring the arrays into `{ handler, owner }` records, would ripple
	 * through every read path for no behavioral gain.
	 *
	 * ASSUMPTION: if the SAME function reference is registered by two different
	 * owners, the second registration's owner overwrites the first, and both
	 * registrations are then gated as the second owner. Handlers are
	 * overwhelmingly fresh closures or `.bind()` results (both fresh
	 * references), so this is an accepted, documented edge rather than a reason
	 * to give up the `WeakMap`.
	 */
	private readonly handlerOwners: WeakMap<Handler<unknown>, string> = new WeakMap()

	/**
	 * Predicate deciding whether an owner's handlers currently run, injected by
	 * the kernel via {@link setOwnerActivePredicate}. `undefined` (the default)
	 * means no gating at all — a standalone bus with no kernel behaves exactly
	 * as it did before plugin activation existed.
	 */
	private isOwnerActive: ((owner: string) => boolean) | undefined

	/**
	 * Single global dispatch queue per bus instance. Every `emit()`/`dispatch()`
	 * schedules onto this chain, so dispatches serialize across all event names
	 * — not per-event-name. This is the § 8.4 rule 2 guarantee: "Two dispatches
	 * never interleave on one bus."
	 */
	private chain: Promise<void> = Promise.resolve()

	/**
	 * Register a handler for `event`, returning an {@link Unsubscribe} that
	 * removes it. Handlers run in registration order (§ 8.2 rule 1).
	 *
	 * `on()` accepts any event name, including reserved kernel names — plugins
	 * observe kernel events by subscribing to them. Only the public `emit()`
	 * restricts which names a plugin may fire; subscription is unrestricted.
	 *
	 * `owner` optionally attributes this handler to a plugin, so the kernel can
	 * skip it while that plugin is deactivated (see
	 * {@link setOwnerActivePredicate}). Omitting it — which every pre-existing
	 * caller does — leaves the handler unowned and permanently active.
	 */
	on<Payload>(event: string, handler: Handler<Payload>, owner?: string): Unsubscribe {
		const list = this.handlers.get(event)
		if (list) {
			list.push(handler as Handler<unknown>)
		} else {
			this.handlers.set(event, [handler as Handler<unknown>])
		}
		if (owner !== undefined) {
			this.handlerOwners.set(handler as Handler<unknown>, owner)
		}
		return () => {
			const arr = this.handlers.get(event)
			if (!arr) return
			const idx = arr.indexOf(handler as Handler<unknown>)
			if (idx >= 0) arr.splice(idx, 1)
			if (arr.length === 0) this.handlers.delete(event)
		}
	}

	/**
	 * Install the predicate that decides whether an owned handler runs.
	 *
	 * Called once by the `BHZAI` constructor to hand the bus a view onto plugin
	 * activation state. The bus deliberately does not import anything about
	 * plugins — it only knows "some handlers carry an owner string, and some
	 * predicate says whether that string is currently active" — which keeps this
	 * class as framework-agnostic as its class doc claims.
	 */
	setOwnerActivePredicate(predicate: (owner: string) => boolean): void {
		this.isOwnerActive = predicate
	}

	/**
	 * Whether `handler` should run right now: true when it is unowned, or when
	 * its owner is active per the injected predicate.
	 */
	private isHandlerActive(handler: Handler<unknown>): boolean {
		if (this.isOwnerActive === undefined) return true
		const owner = this.handlerOwners.get(handler)
		if (owner === undefined) return true
		return this.isOwnerActive(owner)
	}

	/**
	 * Public entrypoint for plugin/host code. Throws synchronously (before any
	 * dispatch begins) if `event` is a reserved kernel name or an un-namespaced
	 * custom name, per § 8.4. The one documented exception is `compact`, a
	 * legal manual trigger that does not throw here.
	 *
	 * The returned Promise resolves with an {@link EmitResult} after the
	 * dispatch — and any dispatches re-entrantly queued from inside its
	 * handlers — have fully completed (FIFO, § 8.4 rule 2).
	 */
	emit<Payload>(
		event: string,
		payload: Payload,
		options?: DispatchOptions,
	): Promise<EmitResult<Payload>> {
		EventBus.assertEmitName(event)
		return this.scheduleAndDrain(() => this.runDispatch(event, payload, options))
	}

	/**
	 * Internal entrypoint for kernel-originated events. Bypasses the reserved-
	 * name check — this is how the kernel fires `initialize`/`dispose`/`error`
	 * and other reserved events itself. There is one bus per scope, not a
	 * privileged side channel (§ 8.4): `dispatch()` uses the exact same
	 * serialization and handler semantics as `emit()`.
	 */
	dispatch<Payload>(
		event: string,
		payload: Payload,
		options?: DispatchOptions,
	): Promise<EmitResult<Payload>> {
		return this.scheduleAndDrain(() => this.runDispatch(event, payload, options))
	}

	// ---------------------------------------------------------------------------
	// Name validation (public `emit()` only).
	// ---------------------------------------------------------------------------

	/**
	 * Throws synchronously if `event` is reserved for kernel use or is an
	 * un-namespaced custom name. Called by `emit()` before scheduling.
	 *
	 * ASSUMPTION (narrower interpretation of § 8.4): the spec mandates that
	 * custom event names be namespaced `<plugin-name>.<event>` but does not
	 * describe a mechanism for threading the calling plugin's identity through
	 * `emit()`. This check therefore only enforces "contains at least one dot
	 * and is not on the reserved list" — it does NOT verify that the prefix
	 * before the dot matches a real, currently-registered plugin name. That
	 * weaker check still blocks the spec's stated failure modes (forging
	 * kernel events, firing un-namespaced names) without requiring identity
	 * plumbing the spec leaves unspecified.
	 */
	private static assertEmitName(event: string): void {
		if (event === "compact") {
			// § 8.4 documented exception: `compact` is a legal manual trigger the
			// kernel intercepts to start the compaction pipeline (`source: 'emit'`).
			// The real interception (TASK_0031) lives in BHZAIConversationImpl.emit(),
			// not here, because EventBus must remain scope-agnostic — it is reused as both
			// the framework bus (which has no compaction context) and the per-conversation bus.
			// Hardcoding conversation/compaction logic into EventBus would break that contract.
			// Instead, conversation.emit('compact') routes through to runCompactionPipeline()
			// at the scope where it makes sense.
			return
		}
		if (RESERVED_EXACT.has(event)) {
			throw new Error(`EventBus.emit(): event name "${event}" is reserved for kernel use (§ 8.4)`)
		}
		for (const prefix of RESERVED_PREFIXES) {
			if (event.startsWith(prefix)) {
				throw new Error(
					`EventBus.emit(): event namespace "${prefix}*" is reserved for kernel use (§ 8.4)`,
				)
			}
		}
		if (!event.includes(".")) {
			throw new Error(
				'EventBus.emit(): event name must be namespaced "<plugin-name>.<event>" (§ 8.4)',
			)
		}
	}

	// ---------------------------------------------------------------------------
	// Dispatch core.
	// ---------------------------------------------------------------------------

	/**
	 * Run a single dispatch: iterate the handlers registered for `event` in
	 * registration order, awaiting each, applying patch chaining, honoring
	 * `{ block: true }` on blockable dispatches, and rerouting handler
	 * exceptions to the `error` framework event (rule 4) without aborting the
	 * remaining handlers.
	 *
	 * `patch` in the returned {@link EmitResult} is the cumulative merged object
	 * of every patch returned by handlers — it does NOT include the original
	 * payload's untouched fields, so callers can tell what changed. `handled`
	 * counts every handler that was invoked, including ones that threw (a
	 * throwing handler still ran, so it counts; the spec does not spell this
	 * out, so this interpretation is documented here).
	 */
	private async runDispatch<Payload>(
		event: string,
		payload: Payload,
		options?: DispatchOptions,
	): Promise<EmitResult<Payload>> {
		const list = this.handlers.get(event)
		if (!list || list.length === 0) {
			return { blocked: false, patch: {}, handled: 0 }
		}

		let current: Payload = payload
		let accumulatedPatch: Partial<Payload> = {}
		let blocked = false
		let reason: string | undefined
		let handled = 0
		const blockable = options?.blockable === true

		for (const handler of list) {
			// Plugin activation gate. A handler belonging to a deactivated plugin
			// is skipped entirely and does NOT count toward `handled` — that field
			// counts handlers that ran, and this one did not. (A throwing handler
			// still counts, per the doc above, because it did run.)
			if (!this.isHandlerActive(handler)) {
				continue
			}
			try {
				const result = await (handler as Handler<Payload>)(current)
				handled += 1

				if (result != null && typeof result === "object") {
					const blockSig = result as Partial<BlockSignal>
					if (blockable && blockSig.block === true) {
						blocked = true
						reason = blockSig.reason
						// Merge any non-control fields the handler also returned as a
						// final patch, then stop the chain (rule 3).
						const patchPart = stripBlockFields(result as Record<string, unknown>)
						if (Object.keys(patchPart).length > 0) {
							current = { ...current, ...patchPart }
							accumulatedPatch = { ...accumulatedPatch, ...patchPart }
						}
						break
					}
					// Non-blockable dispatch, or no block signal: merge the entire
					// returned object as an ordinary patch (rule 2). Per § 8.2 rule 3
					// prose, on a non-blockable dispatch a `{ block: true }` return is
					// "merged in like any other returned object" — so we do NOT strip
					// block/reason here; only the blockable-and-blocking path strips.
					const patchPart = result as Partial<Payload>
					current = { ...current, ...patchPart }
					accumulatedPatch = { ...accumulatedPatch, ...patchPart }
				}
			} catch (err) {
				handled += 1
				// Rule 4: catch, do not propagate, treat as "no patch", reroute to
				// the `error` framework event, and continue with the remaining
				// handlers. The error dispatch is fired without awaiting: it is
				// re-entrant (we are mid-dispatch), so it queues behind the current
				// dispatch and runs after it completes (§ 8.4 rule 2). Awaiting it
				// here would deadlock (current dispatch waits for a dispatch queued
				// behind itself). The outer emit()/dispatch() drains the queue before
				// resolving, so error listeners have run by the time the caller's
				// await settles.
				void this.dispatch("error", { error: err, source: event })
			}
		}

		return { blocked, reason, patch: accumulatedPatch, handled }
	}

	// ---------------------------------------------------------------------------
	// FIFO serialization + queue draining (§ 8.4 rule 2).
	// ---------------------------------------------------------------------------

	/**
	 * Schedule `task` onto the global chain (so it runs only after all
	 * previously scheduled dispatches complete) and return a Promise that
	 * resolves with the task's result after the entire chain — including any
	 * dispatches re-entrantly queued from inside `task`'s handlers — has
	 * drained.
	 *
	 * "Drain" semantics: the returned Promise does not resolve until the chain
	 * is idle. This makes `await bus.emit(...)` mean "this event and everything
	 * it triggered has settled," which is what tests and callers naturally
	 * expect. Without draining, re-entrantly queued dispatches (including
	 * `error` rerouting) would still be pending when the outer await resolved,
	 * making the bus effectively untestable for ordering.
	 */
	private scheduleAndDrain<T>(task: () => Promise<T>): Promise<T> {
		const taskResult = this.schedule(task)
		return this.drainAfter(taskResult)
	}

	/**
	 * Append `task` to the global chain. The chain never rejects — a failing
	 * task's error is funneled into its own result Promise, not the chain, so
	 * one bad dispatch cannot wedge subsequent ones.
	 */
	private schedule<T>(task: () => Promise<T>): Promise<T> {
		let resolveTask!: (value: T) => void
		let rejectTask!: (reason: unknown) => void
		const taskResult = new Promise<T>((resolve, reject) => {
			resolveTask = resolve
			rejectTask = reject
		})
		this.chain = this.chain.then(async () => {
			try {
				const value = await task()
				resolveTask(value)
			} catch (err) {
				rejectTask(err)
			}
		})
		return taskResult
	}

	/**
	 * Await `taskResult`, then repeatedly await the chain until it stops
	 * growing — i.e. until no new dispatches were queued during the most
	 * recently awaited segment. This catches arbitrarily deep re-entrant
	 * nesting, not just one level.
	 */
	private async drainAfter<T>(taskResult: Promise<T>): Promise<T> {
		const value = await taskResult
		await this.drain()
		return value
	}

	/**
	 * Drain the global chain until it is idle. Loops because a dispatch queued
	 * during the awaited segment may itself queue further dispatches, extending
	 * the chain again.
	 */
	private async drain(): Promise<void> {
		while (true) {
			const segment = this.chain
			await segment
			if (this.chain === segment) return
		}
	}
}

/**
 * Return a copy of `obj` with the `block` and `reason` control fields removed,
 * for merging the data fields of a blocking handler's return value as a patch.
 */
function stripBlockFields<T extends Record<string, unknown>>(obj: T): Record<string, unknown> {
	const out: Record<string, unknown> = {}
	for (const key of Object.keys(obj)) {
		if (key !== "block" && key !== "reason") {
			out[key] = obj[key]
		}
	}
	return out
}
