/**
 * @file Pure helpers for persisting the user's provider + model choice so the
 * picker can restore it on the next visit.
 *
 * Mirrors `provider-store.ts`'s shape: versioned localStorage payload,
 * injectable backend (so persistence is testable in Node), defensive
 * parsing that fails to `null` rather than throwing. See that file's header
 * comment for the rationale.
 */

/** localStorage key holding the persisted provider + model selection. */
const STORAGE_KEY = "bhzai.selection"

/** Schema version of the persisted payload. Bump on a shape change. */
const STORAGE_VERSION = 1

/** The persisted provider + model choice. */
export interface Selection {
	/** A driver id (e.g. `"ollama"`), or `"all"` to show every provider's models. */
	provider: string
	/** Bare model id, matching `ModelInfo.id`. Empty string means none saved. */
	modelId: string
}

/**
 * Resolve the storage backend, tolerating environments that have no
 * `localStorage` at all (Node, or a browser with storage disabled entirely).
 *
 * @param storage - Explicit backend, for tests
 * @returns The backend to use, or null if none is available
 */
function resolveStorage(storage: Storage | undefined): Storage | null {
	if (storage) return storage
	try {
		return typeof localStorage === "undefined" ? null : localStorage
	} catch {
		// Accessing `localStorage` itself throws in some privacy modes.
		return null
	}
}

/**
 * Read the persisted provider + model selection.
 *
 * Returns `null` for every failure mode — absent key, disabled storage,
 * corrupt JSON, an unknown schema version, or a payload of the wrong shape.
 * A demo app must never fail to start because of what is in storage.
 *
 * @param storage - Storage backend (defaults to `localStorage`)
 * @returns The stored selection, or null
 */
export function loadSelection(storage?: Storage): Selection | null {
	const backend = resolveStorage(storage)
	if (!backend) return null

	let raw: string | null
	try {
		raw = backend.getItem(STORAGE_KEY)
	} catch {
		return null
	}
	if (!raw) return null

	try {
		const parsed = JSON.parse(raw)
		if (
			!parsed ||
			parsed.v !== STORAGE_VERSION ||
			typeof parsed.provider !== "string" ||
			typeof parsed.modelId !== "string"
		) {
			return null
		}
		return { provider: parsed.provider, modelId: parsed.modelId }
	} catch {
		return null
	}
}

/**
 * Persist the provider + model selection.
 *
 * Silently no-ops when storage is unavailable or full — persistence is a
 * convenience here, and losing it must not break the session in progress.
 *
 * @param selection - The selection to persist
 * @param storage - Storage backend (defaults to `localStorage`)
 * @returns Whether the write succeeded
 */
export function saveSelection(selection: Selection, storage?: Storage): boolean {
	const backend = resolveStorage(storage)
	if (!backend) return false

	try {
		backend.setItem(STORAGE_KEY, JSON.stringify({ v: STORAGE_VERSION, ...selection }))
		return true
	} catch {
		return false
	}
}
