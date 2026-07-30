// TASK_0022: Model selection & switching (§ 10.5).
//
// This module is the glue that makes the driver registry (TASK_0009), the
// two bundled drivers (TASK_0019/TASK_0020), and `modelSource` plugin
// contributions (TASK_0015) into one coherent, host-consumable model picker.
// It implements: qualified/bare model-reference parsing with ambiguity
// detection, the full catalogue merge behind `bh.listModels()`, the
// four-tier resolution order that picks a model for a conversation, and
// `setModel(ref)`'s switching semantics.
//
// PATH NOTE: TASK_0022 specifies `bhzai/src/kernel/models.ts`, but the repo
// convention established by TASK_0002 is `src/core/` (see
// `src/core/AGENTS.md`). This file follows the existing convention; the
// behavioral contract is unchanged.
//
// ENVIRONMENT BOUNDARY (§ 5): pure TypeScript — no I/O, no filesystem, no
// env reads. The `listModels` function calls `driver.listModels()` (which
// itself uses `fetch`), but this module adds no environment-specific code.

import type { BHZAIDriver, ModelInfo } from "../types/index.js"

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

/**
 * Thrown by {@link resolveModelRef} when a bare model id matches entries in
 * two or more different drivers. The error lists every qualified alternative
 * so the caller can disambiguate by using a qualified `'<driver>/<model>'`
 * ref instead (§ 10.5).
 */
export class AmbiguousModelError extends Error {
	readonly alternatives: string[]
	constructor(bareId: string, alternatives: string[]) {
		super(
			`Model id "${bareId}" is ambiguous across drivers: ${alternatives.join(", ")}. Use a qualified reference instead.`,
		)
		this.name = "AmbiguousModelError"
		this.alternatives = alternatives
	}
}

/**
 * Thrown by {@link resolveModelRef} when a ref doesn't exist in the catalogue
 * at all (neither as a bare id nor as an already-qualified ref).
 *
 * EXPLICIT ASSUMPTION: § 10.5 does not name an error type for "ref doesn't
 * exist at all" (as opposed to `AmbiguousModelError`'s "exists in more than
 * one place" and `NoModelError`'s "no model could be resolved at all for a
 * conversation"). This task introduces `ModelNotFoundError` for this case,
 * documented clearly as this task's own addition so it isn't confused with
 * the two spec-named error types.
 */
export class ModelNotFoundError extends Error {
	constructor(ref: string) {
		super(`Model "${ref}" not found in the catalogue.`)
		this.name = "ModelNotFoundError"
	}
}

/**
 * Thrown by {@link resolveConversationModel} when no tier of the four-tier
 * resolution order produced a usable model ref (§ 10.5).
 */
export class NoModelError extends Error {
	constructor() {
		super(
			"No model could be resolved for this conversation: no explicit model, no default, model.resolve produced nothing, and no ready model exists in the catalogue.",
		)
		this.name = "NoModelError"
	}
}

/**
 * Thrown by {@link setModel} when the target model's `availability` is
 * `'unavailable'` — switching to an unavailable model is a hard error, not
 * a silent no-op.
 */
export class ModelUnavailableError extends Error {
	constructor(ref: string) {
		super(`Cannot switch to model "${ref}": it is unavailable.`)
		this.name = "ModelUnavailableError"
	}
}

// ---------------------------------------------------------------------------
// Identity — qualified refs and bare-id resolution
// ---------------------------------------------------------------------------

/**
 * Parse a qualified model ref `'<driverId>/<modelId>'` into its parts.
 *
 * Splits on the **first** `/` only — model ids themselves can contain
 * `/`-like or `:`-like characters (e.g. Ollama tags use `:`, and some model
 * ids embed slashes from Hugging-Face-style naming). Returns `null` if the
 * ref contains no `/` at all (meaning it's a bare id, handled by
 * {@link resolveModelRef}, not this function).
 *
 * EXPLICIT ASSUMPTION: § 10.5 doesn't spell out the parsing algorithm for
 * ids that themselves contain slashes — this first-slash-split rule is this
 * task's own resolved assumption.
 */
export function parseModelRef(ref: string): { driver: string; id: string } | null {
	const slashIndex = ref.indexOf("/")
	if (slashIndex < 0) return null
	return {
		driver: ref.slice(0, slashIndex),
		id: ref.slice(slashIndex + 1),
	}
}

/**
 * Resolve a model ref (bare or qualified) against a catalogue, returning a
 * fully-qualified `'<driver>/<model>'` ref.
 *
 * - If `ref` contains a `/` and a catalogue entry with that exact `ref`
 *   exists, return it unchanged (already qualified).
 * - If `ref` contains no `/`, treat it as a bare id: filter the catalogue
 *   for every entry whose `id === ref`. If exactly one match, return its
 *   qualified `ref`. If two or more matches (different drivers reporting the
 *   same bare `id`), throw {@link AmbiguousModelError} listing every
 *   qualified alternative.
 * - If zero matches (neither as a bare id nor as an already-qualified ref),
 *   throw {@link ModelNotFoundError}.
 */
export function resolveModelRef(ref: string, catalogue: ModelInfo[]): string {
	// Qualified ref — check for exact match.
	if (ref.includes("/")) {
		const entry = catalogue.find((m) => m.ref === ref)
		if (entry) return entry.ref
		throw new ModelNotFoundError(ref)
	}

	// Bare id — find all matches.
	const matches = catalogue.filter((m) => m.id === ref)
	if (matches.length === 0) {
		throw new ModelNotFoundError(ref)
	}
	if (matches.length === 1) {
		return matches[0].ref
	}
	// Ambiguous — multiple drivers report the same bare id.
	throw new AmbiguousModelError(
		ref,
		matches.map((m) => m.ref),
	)
}

// ---------------------------------------------------------------------------
// Discovery — the catalogue merge behind `bh.listModels()`
// ---------------------------------------------------------------------------

/**
 * Merge driver-reported models and `modelSource` plugin contributions into
 * the full model catalogue (§ 10.5 Discovery).
 *
 * 1. Every registered driver's own `listModels()` output, as-is.
 * 2. Every `modelSource`-contributed `ModelInfo`, with one kernel-enforced
 *    rule: an entry whose `driver` field does NOT match any registered
 *    driver's `id` is forced to `availability: 'unavailable'` regardless of
 *    what the contribution itself claimed. An entry whose `driver` field
 *    DOES match a registered driver is left as-is (the contributing plugin
 *    already computed the right `availability`).
 * 3. If the same qualified `ref` appears in both a driver's own output and a
 *    `modelSource` contribution, the driver's own entry wins (drivers are
 *    the authoritative source for their own models).
 *
 * EXPLICIT ASSUMPTION: § 10.5 doesn't address this exact collision case
 * (driver vs. modelSource duplicate ref). The driver-wins rule is this
 * task's own resolved assumption.
 */
export async function listModels(
	drivers: ReadonlyArray<BHZAIDriver>,
	modelSourceContributions: ReadonlyArray<ModelInfo>,
): Promise<ModelInfo[]> {
	const driverIds = new Set(drivers.map((d) => d.id))

	// Step 1: collect all driver-reported models.
	const driverModels: ModelInfo[] = []
	for (const driver of drivers) {
		const models = await driver.listModels()
		driverModels.push(...models)
	}

	// Build a set of refs that drivers already reported (for dedup).
	const driverRefs = new Set(driverModels.map((m) => m.ref))

	// Step 2: merge modelSource contributions, applying the driver-match
	// override rule and skipping duplicates.
	const merged: ModelInfo[] = [...driverModels]
	for (const contribution of modelSourceContributions) {
		// Skip duplicates — driver's own entry wins.
		if (driverRefs.has(contribution.ref)) continue

		// Force 'unavailable' if the driver isn't registered.
		if (!driverIds.has(contribution.driver)) {
			merged.push({ ...contribution, availability: "unavailable" })
		} else {
			merged.push(contribution)
		}
	}

	return merged
}

// ---------------------------------------------------------------------------
// How the consumer chooses — the four-tier resolution order
// ---------------------------------------------------------------------------

/**
 * Options for {@link resolveConversationModel}.
 */
export interface ResolveConversationModelOptions {
	/** Tier 1: `createConversation({ model })` — explicit per-conversation. */
	explicitModel?: string
	/** Tier 2: `new BHZAI({ defaultModel })` — host-wide default. */
	defaultModel?: string
	/**
	 * Tier 3: the blockable `model.resolve` framework event. Returns a
	 * patch with `{ model }` if a handler picks a model, or `undefined`.
	 */
	emitModelResolveEvent: () => Promise<{ model?: string } | undefined>
	/** Tier 4 source: the full merged catalogue. */
	catalogue: ModelInfo[]
}

/**
 * Resolve a model for a conversation using the four-tier priority order
 * (§ 10.5 "How the consumer chooses"):
 *
 * 1. **Explicit model** (`createConversation({ model })`) — always wins
 *    ordering priority, but still gets validated/qualified via
 *    `resolveModelRef` (can throw `AmbiguousModelError`/`ModelNotFoundError`).
 * 2. **Default model** (`new BHZAI({ defaultModel })`) — consulted only if
 *    tier 1 was absent.
 * 3. **`model.resolve` event** — dispatched only if tiers 1–2 produced
 *    nothing; if a handler returns `{ model }`, resolve/validate that ref.
 * 4. **First `'ready'` catalogue entry** — in catalogue iteration order.
 *    Does NOT fall back to `'downloadable'` (the kernel never silently
 *    downloads).
 *
 * If no tier produces a usable ref, throws {@link NoModelError}.
 */
export async function resolveConversationModel(
	options: ResolveConversationModelOptions,
): Promise<string> {
	const { catalogue } = options

	// Tier 1: explicit model.
	if (options.explicitModel) {
		return resolveModelRef(options.explicitModel, catalogue)
	}

	// Tier 2: default model.
	if (options.defaultModel) {
		return resolveModelRef(options.defaultModel, catalogue)
	}

	// Tier 3: model.resolve event.
	const patch = await options.emitModelResolveEvent()
	if (patch?.model) {
		return resolveModelRef(patch.model, catalogue)
	}

	// Tier 4: first 'ready' catalogue entry.
	// EXPLICIT ASSUMPTION: "first" means array order as returned by the
	// discovery merge, since § 10.5 doesn't specify a tie-breaking sort.
	// This tier explicitly does NOT fall back to 'downloadable' — the
	// kernel never silently downloads.
	const ready = catalogue.find((m) => m.availability === "ready")
	if (ready) {
		return ready.ref
	}

	// No tier produced a usable ref.
	throw new NoModelError()
}

// ---------------------------------------------------------------------------
// How switching is handled — `setModel(ref)`
// ---------------------------------------------------------------------------

/**
 * The `model.selected` event payload (§ 8.1). Notification-only — patches
 * ignored.
 */
export interface ModelSelectedPayload {
	model: string
	previousModel: string
	source: "set" | "load" | "resolve"
}

/**
 * Minimal conversation-state shape that {@link setModel} operates on.
 *
 * The full `BHZAIConversation` class is TASK_0023's — a different task. This
 * task models `setModel`'s core logic as a standalone function taking this
 * minimal shape; TASK_0023 is expected to call into this logic rather than
 * reimplement it.
 */
export interface ConversationModelState {
	/** The currently-active qualified model ref. */
	activeModelRef: string
	/** Whether the conversation is currently streaming a turn. */
	isStreaming: () => boolean
	/** The full merged catalogue. */
	catalogue: ModelInfo[]
}

/**
 * The result of a `setModel` call — either applied immediately or queued
 * for deferred application.
 */
export interface SetModelResult {
	/** Whether the switch was applied immediately or queued. */
	applied: boolean
	/**
	 * If queued, call this once the in-flight turn settles to apply the
	 * switch. If applied immediately, this is `undefined`.
	 */
	applyQueued?: () => void
}

/**
 * Switch a conversation's active model (§ 10.5 "How switching is handled").
 *
 * 1. **Validation**: resolve/qualify `ref` via `resolveModelRef`. If the
 *    resolved entry's `availability` is `'unavailable'`, throw
 *    {@link ModelUnavailableError}. If `'downloadable'`, accept it (the
 *    driver's next `chat()` call triggers the download).
 * 2. **Timing**: if `isStreaming()` returns `true`, the switch is queued
 *    (mirroring § 11.5's `'steer'` `deliverAs` semantics — "delivered after
 *    the current turn's tool calls settle, before the next LLM call"). The
 *    caller can call `abort()` first for an immediate mid-stream switch.
 * 3. **History porting**: no special code — each driver maps `BHZAIMessage[]`
 *    to its own wire format at `chat()` call time.
 * 4. **Capability re-application**: the new model's `capabilities()` govern
 *    the next `chat()` call; this function only ensures `activeModelRef` is
 *    updated before the next `context`/`request` cycle reads it.
 * 5. **`model.selected` event**: fires with `{ model, previousModel, source }`
 *    once the switch takes effect (immediately for non-streaming; at the
 *    deferred application point for queued).
 *
 * @param state The conversation state to mutate.
 * @param ref The model ref to switch to (bare or qualified).
 * @param source The switch source: `'set'` (direct call), `'load'`
 *   (re-resolution during `loadConversation`), or `'resolve'` (tier-3
 *   `model.resolve` fallback).
 * @param emitModelSelected Callback to fire the `model.selected` event.
 * @returns A {@link SetModelResult} indicating whether the switch was
 *   applied immediately or queued.
 */
export function setModel(
	state: ConversationModelState,
	ref: string,
	source: "set" | "load" | "resolve",
	emitModelSelected: (payload: ModelSelectedPayload) => void,
): SetModelResult {
	// Step 1: validate and qualify the ref.
	const qualifiedRef = resolveModelRef(ref, state.catalogue)
	const entry = state.catalogue.find((m) => m.ref === qualifiedRef)
	if (entry && entry.availability === "unavailable") {
		throw new ModelUnavailableError(qualifiedRef)
	}

	// Step 2: check streaming state.
	if (state.isStreaming()) {
		// Queue the switch — apply after the in-flight turn settles.
		// Mirrors § 11.5's 'steer' deliverAs timing contract.
		const previousModel = state.activeModelRef
		const applyQueued = () => {
			state.activeModelRef = qualifiedRef
			emitModelSelected({
				model: qualifiedRef,
				previousModel,
				source,
			})
		}
		return { applied: false, applyQueued }
	}

	// Apply immediately.
	const previousModel = state.activeModelRef
	state.activeModelRef = qualifiedRef
	emitModelSelected({
		model: qualifiedRef,
		previousModel,
		source,
	})
	return { applied: true }
}
