/**
 * @file Pure helpers for the providers panel: persistence and validation of
 * Ollama provider configs.
 *
 * DOM-free by convention (see `example/AGENTS.md`) so every branch here is
 * unit-testable in Node. `localStorage` is reached through the injectable
 * `storage` parameter rather than the global, which is what lets the
 * persistence tests run without a browser. Mirrors `mcp-store.ts`'s shape:
 * versioned localStorage payload, injectable backend, defensive parsing.
 */

/** localStorage key holding the configured Ollama provider list. */
const STORAGE_KEY = "bhai.providers.ollama"

/**
 * Schema version of the persisted payload. Bump it when the stored shape
 * changes; {@link loadProviders} discards anything it does not recognize
 * rather than trying to migrate, since this is a demo app whose stored data
 * is trivially re-entered.
 */
const STORAGE_VERSION = 1

/**
 * The default Ollama API address offered in the add-provider form. The plugin
 * appends `/api/tags` itself, so the driver wants the server ROOT, not the
 * `/api` path — see {@link normalizeBaseUrl}.
 */
export const DEFAULT_OLLAMA_API = "http://localhost:11434/api"

/** One persisted Ollama provider entry. */
export interface OllamaProviderConfig {
	/** Stable client-side id (`crypto.randomUUID()`), persisted across reloads. */
	id: string
	/** The Ollama server root URL (after {@link normalizeBaseUrl}). */
	baseUrl: string
	/** Optional bearer token; empty string means unauthenticated. */
	token: string
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
 * Read the persisted Ollama provider list.
 *
 * Returns `[]` for every failure mode — absent key, disabled storage, corrupt
 * JSON, an unknown schema version, or a payload of the wrong shape. A demo
 * app must never fail to start because of what is in storage, and the user
 * can always re-add a provider.
 *
 * @param storage - Storage backend (defaults to `localStorage`)
 * @returns The stored providers, or an empty list
 */
export function loadProviders(storage?: Storage): OllamaProviderConfig[] {
	const backend = resolveStorage(storage)
	if (!backend) return []

	let raw: string | null
	try {
		raw = backend.getItem(STORAGE_KEY)
	} catch {
		return []
	}
	if (!raw) return []

	try {
		const parsed = JSON.parse(raw)
		if (!parsed || parsed.v !== STORAGE_VERSION || !Array.isArray(parsed.providers)) {
			return []
		}
		// Filter rather than trust: a hand-edited entry without a usable baseUrl
		// would otherwise become a provider row that can never connect.
		return parsed.providers.filter(
			(p: unknown): p is OllamaProviderConfig =>
				typeof p === "object" &&
				p !== null &&
				typeof (p as OllamaProviderConfig).id === "string" &&
				(p as OllamaProviderConfig).id.length > 0 &&
				typeof (p as OllamaProviderConfig).baseUrl === "string" &&
				(p as OllamaProviderConfig).baseUrl.length > 0 &&
				typeof (p as OllamaProviderConfig).token === "string",
		)
	} catch {
		return []
	}
}

/**
 * Persist the Ollama provider list.
 *
 * ⚠️ Stores the bearer token verbatim in plaintext under this browser origin.
 * That is a deliberate trade-off for a local demo (one-click reconnect); a
 * production host should keep credentials out of `localStorage` and re-prompt
 * instead. Mirrors `mcp-store.ts`'s `saveServers` policy.
 *
 * Silently no-ops when storage is unavailable or full — persistence is a
 * convenience here, and losing it must not break the session in progress.
 *
 * @param providers - Providers to persist
 * @param storage - Storage backend (defaults to `localStorage`)
 * @returns Whether the write succeeded
 */
export function saveProviders(providers: OllamaProviderConfig[], storage?: Storage): boolean {
	const backend = resolveStorage(storage)
	if (!backend) return false

	try {
		backend.setItem(STORAGE_KEY, JSON.stringify({ v: STORAGE_VERSION, providers }))
		return true
	} catch {
		return false
	}
}

/**
 * Strip a trailing `/api` (and any trailing slash) from a user-entered Ollama
 * address so the plugin receives the server ROOT.
 *
 * The Ollama plugin appends `/api/tags` itself, so a baseUrl that already ends
 * in `/api` would produce `/api/api/tags`. A bare root (`http://host:11434`)
 * is returned unchanged. A trailing slash on the root is removed too.
 *
 * @param api - The user-entered address (e.g. `http://localhost:11434/api`)
 * @returns The server root (e.g. `http://localhost:11434`)
 */
export function normalizeBaseUrl(api: string): string {
	let url = (api ?? "").trim()
	// Drop a trailing slash first so `/api/` and `/api` both reduce to `/api`.
	url = url.replace(/\/+$/, "")
	// Now strip a trailing `/api` segment (case-insensitive) if present.
	url = url.replace(/\/api$/i, "")
	// A second slash trim in case stripping `/api` exposed one.
	return url.replace(/\/+$/, "")
}

/**
 * Validate a user-entered Ollama API address.
 *
 * Only `http:`/`https:` are accepted: the Ollama plugin speaks HTTP and
 * nothing else, so a `ws://` or `file://` entry is a mistake worth catching
 * before it becomes a confusing fetch failure. Mirrors `mcp-store.ts`'s
 * `validateServerUrl` style.
 *
 * @param url - The candidate address
 * @returns An error message, or null when the URL is usable
 */
export function validateApiUrl(url: string): string | null {
	const trimmed = (url ?? "").trim()
	if (trimmed === "") return "Enter the Ollama API address."

	let parsed: URL
	try {
		parsed = new URL(trimmed)
	} catch {
		return "That is not a valid URL. Include the scheme, e.g. http://localhost:11434/api"
	}

	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		return `Only HTTP Ollama servers are supported — "${parsed.protocol}" is not.`
	}

	return null
}
