// Driver registry — the kernel-side store of model-provider drivers
// (ARCHITECTURE.md § 10.1). Drivers (WebLLM, Ollama, or any future provider)
// plug into this registry; `bh.listModels()` aggregates their model
// catalogues into one merged list.
//
// Scope of THIS file (TASK_0009): the `DriverRegistry` class backing
// `bh.addDriver`/`bh.listModels`, plus the `driver.registered` framework event
// (§ 8.1). It does NOT implement any concrete driver (those are TASK_0019/
// 0020's job), does NOT resolve `modelSource` plugin hooks (TASK_0015), and
// does NOT route MCP sampling (TASK_0014).
//
// ENVIRONMENT BOUNDARY (§ 5): web-standard APIs only. This file touches nothing
// outside of plain TypeScript — no `fetch`, no `crypto`, no Node built-ins. It
// is runtime-agnostic.
//
// PATH NOTE: TASK_0009 specifies `bhzai/src/kernel/drivers.ts`, but the package
// layout already established by TASK_0002/TASK_0003 places the kernel under
// `src/core/` (see `src/core/index.ts` and the `./core` subpath export in
// `package.json`). This file follows the existing repo convention to keep one
// kernel directory; the behavioral contract is unchanged.

import type { BHZAIDriver, ModelInfo } from "../types/index.js"
import type { EventBus } from "./event-bus.js"

/**
 * The driver registry (§ 10.1). Stores {@link BHZAIDriver} instances keyed by
 * `driver.id`, fires `driver.registered` (§ 8.1) on registration, and merges
 * every registered driver's `listModels()` into one flat catalogue.
 */
export class DriverRegistry {
	/** Drivers keyed by `driver.id`; last registration wins (shadowing). */
	private readonly drivers: Map<string, BHZAIDriver> = new Map()

	/**
	 * @param bus The framework event bus, used to fire `driver.registered`
	 *   (§ 8.1). This is a non-blockable framework event; the registry
	 *   dispatches it via the bus's kernel bypass (`dispatch()`), consistent
	 *   with how the kernel fires its other registry events
	 *   (`tool.registered`/`tool.removed`).
	 */
	constructor(private readonly bus: EventBus) {}

	/**
	 * Predicate deciding whether a driver id is currently visible, injected by
	 * the kernel to implement plugin activation. `undefined` (the default) means
	 * no gating — a registry constructed without a kernel behaves exactly as it
	 * did before plugin activation existed.
	 *
	 * The registry stays plugin-unaware on purpose: it knows only "some ids may
	 * be filtered out", never why. The kernel owns the ownership ledger that
	 * answers the question.
	 */
	private isActive: ((driverId: string) => boolean) | undefined

	/** Install the visibility predicate. Called once by the `BHZAI` constructor. */
	setActivePredicate(predicate: (driverId: string) => boolean): void {
		this.isActive = predicate
	}

	/**
	 * Drivers currently visible: every registered driver when no predicate is
	 * installed, otherwise only those whose id the predicate accepts. Preserves
	 * registration order.
	 */
	private activeEntries(): BHZAIDriver[] {
		const all = Array.from(this.drivers.values())
		const predicate = this.isActive
		if (predicate === undefined) return all
		return all.filter((d) => predicate(d.id))
	}

	/**
	 * Register (or replace) a driver (§ 6, § 10.1). Inserts the entry under
	 * `driver.id` and fires `driver.registered` with `{ driver }`.
	 *
	 * SHADOWING CONVENTION (cross-referenced to TASK_0008): the architecture
	 * doc does not explicitly state what happens when `addDriver()` is called
	 * twice with the same `id`. This registry adopts the IDENTICAL convention
	 * TASK_0008 established for tool-name shadowing: later registration
	 * replaces the earlier one under the same key, for consistency across all
	 * of BHZAI's registries (tools, drivers, and — see TASK_0010 — commands).
	 * Rationale: same as TASK_0008's — conceptually the host still sees "a
	 * driver named X" continuously across the shadowing; nothing was removed,
	 * only updated.
	 *
	 * ASYMMETRY NOTE (deliberate, not an oversight): unlike TASK_0008's tool
	 * registry, there is no `driver.removed` event fired here — not even on
	 * explicit removal (which this registry does not expose at all in
	 * TASK_0009's scope). § 8.1 defines NO `driver.removed` row, so this
	 * registry must NOT invent one. Shadowing a driver only fires
	 * `driver.registered` for the new instance, with no corresponding
	 * "removed" signal for the old one. This is intentional: the spec defines
	 * no event to fire even if we wanted to draw the parallel with
	 * `tool.removed`.
	 */
	addDriver(driver: BHZAIDriver): void {
		this.drivers.set(driver.id, driver)
		// Fire-and-forget: `addDriver` is synchronous (`void`), and
		// `driver.registered` is a non-blockable notification event. Dispatched
		// through the bus's global FIFO queue (§ 8.4 rule 2); callers observe
		// it via `bh.on('driver.registered')`.
		void this.bus.dispatch("driver.registered", { driver })
	}

	/**
	 * Merged model catalogue from every currently-registered driver (§ 6, § 10.1).
	 *
	 * Calls `driver.listModels()` on every registered driver in parallel
	 * (`Promise.all`) and concatenates the results into one flat `ModelInfo[]`,
	 * in registration order (the order drivers were inserted into the internal
	 * `Map`, which preserves insertion order for new keys and updates-in-place
	 * for shadowed keys — so a shadowed driver keeps its original position in
	 * the merge). The spec does not mandate an order; registration order is
	 * chosen as the deterministic, observable, host-predictable option.
	 *
	 * PARTIAL-FAILURE ASSUMPTION (the spec does not specify): if any one
	 * driver's `listModels()` rejects, the whole `listModels()` promise
	 * rejects too — rather than silently swallowing one driver's failure.
	 * Silently dropping a driver's models could surprise a host expecting a
	 * complete catalogue. A future task may revisit this with per-driver error
	 * isolation if that proves too brittle in practice, but do not implement
	 * partial-failure isolation speculatively here.
	 *
	 * NO DE-DUPLICATION: entries are NOT deduplicated across drivers by
	 * name/id/ref — different drivers may legitimately expose models with
	 * overlapping identifiers (e.g. two Ollama endpoints), and de-duplication
	 * policy is not specified anywhere in the doc; entries are left as-is.
	 *
	 * TODO(TASK_0015): merge in modelSource plugin-hook results here as well.
	 * Per ARCHITECTURE.md § 6 line 189, `listModels()` is documented as
	 * "merged: drivers + modelSource hooks" — this task (TASK_0009) only
	 * implements the driver half of that merge. TASK_0015 extends this method
	 * (or wraps it) to also include results from every registered `modelSource`
	 * capability-object hook, resolved during bh.init() per § 8.5.
	 */
	async listModels(): Promise<ModelInfo[]> {
		// TODO(TASK_0015): merge in modelSource plugin-hook results here as well.
		// Per ARCHITECTURE.md § 6 line 189, `listModels()` is documented as
		// "merged: drivers + modelSource hooks" — this task (TASK_0009) only
		// implements the driver half of that merge. TASK_0015 extends this method
		// (or wraps it) to also include results from every registered `modelSource`
		// capability-object hook, resolved during bh.init() per § 8.5.
		// Only active drivers contribute. A driver belonging to a deactivated
		// plugin keeps its registration (and its `driver.registered` event
		// already fired) but drops out of the merged catalogue.
		const drivers = this.activeEntries()
		const perDriver = await Promise.all(drivers.map((d) => d.listModels()))
		// Concatenate in registration order. `perDriver[i]` corresponds to
		// `drivers[i]` since `Promise.all` preserves input order.
		const merged: ModelInfo[] = []
		for (const models of perDriver) {
			for (const m of models) {
				merged.push(m)
			}
		}
		return merged
	}

	/**
	 * Look up a registered driver by `id`, or `undefined` if not registered.
	 *
	 * MINOR SUPERSET ADDITION beyond § 6's literal text (which names only
	 * `addDriver`/`listModels`): this accessor exists so the kernel and tests
	 * can reach a driver's `capabilities(model)` method without re-implementing
	 * the lookup. It is a convenience accessor, not a new kernel API surface —
	 * `bh` does not re-export it on § 6's named method list.
	 */
	get(id: string): BHZAIDriver | undefined {
		if (this.isActive !== undefined && !this.isActive(id)) return undefined
		return this.drivers.get(id)
	}

	/** Number of currently-visible drivers. Convenience accessor. */
	get size(): number {
		if (this.isActive === undefined) return this.drivers.size
		return this.activeEntries().length
	}
}
