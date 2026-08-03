/**
 * @file Pure helpers for the providers panel: persistence and validation of
 * local HTTP provider configs (Ollama and LM Studio).
 *
 * DOM-free by convention (see `example/AGENTS.md`) so every branch here is
 * unit-testable in Node. `localStorage` is reached through the injectable
 * `storage` parameter rather than the global, which is what lets the
 * persistence tests run without a browser. Mirrors `mcp-store.ts`'s shape:
 * versioned localStorage payload, injectable backend, defensive parsing.
 */

/** localStorage key holding the configured provider list. */
const STORAGE_KEY = "bhzai.providers"

/**
 * Schema version of the persisted payload. Bump it when the stored shape
 * changes; {@link loadProviders} discards anything it does not recognize
 * rather than trying to migrate, since this is a demo app whose stored data
 * is trivially re-entered.
 *
 * v2 added the `kind` discriminator and moved off the ollama-only
 * `bhzai.providers.ollama` key, so a v1 payload is simply left behind.
 */
const STORAGE_VERSION = 2

/**
 * The HTTP providers the panel can add. WebLLM is the built-in, not one of
 * these.
 *
 * `ollama` and `lmstudio` are local servers; `openai` is the hosted platform,
 * which differs only in that its API token is required rather than optional —
 * every request to api.openai.com without one is rejected with 401.
 */
export type ProviderKind = "ollama" | "lmstudio" | "openai"

/** Every addable provider kind, in the order the add form offers them. */
export const PROVIDER_KINDS: ProviderKind[] = ["ollama", "lmstudio", "openai"]

/** Human-readable name per kind, used in form labels and error messages. */
export const PROVIDER_LABELS: Record<ProviderKind, string> = {
	ollama: "Ollama",
	lmstudio: "LM Studio",
	openai: "OpenAI",
}

/**
 * The default API address offered in the add-provider form, per kind. Every
 * driver appends its own API path, so they want the server ROOT — see
 * {@link normalizeBaseUrl}, which strips the `/v1` and `/api` suffixes users
 * paste out of habit.
 */
export const DEFAULT_PROVIDER_API: Record<ProviderKind, string> = {
	ollama: "http://localhost:11434/api",
	lmstudio: "http://localhost:1234",
	openai: "https://api.openai.com/v1",
}

/** Resolve a display label from an arbitrary string, falling back to the raw value. */
export function providerLabel(kind: string): string {
	return PROVIDER_LABELS[kind as ProviderKind] ?? kind
}

/**
 * Map a user-facing label back to its kind. The add form's typeahead shows
 * labels ("LM Studio"), not slugs, so its reported value has to be translated
 * before it can select a driver.
 *
 * @param label - The label the typeahead reported
 * @returns The matching kind, or the first kind when nothing matches
 */
export function providerKindFromLabel(label: string): ProviderKind {
	const match = PROVIDER_KINDS.find((kind) => PROVIDER_LABELS[kind] === label)
	return match ?? (PROVIDER_KINDS[0] as ProviderKind)
}

/** One persisted provider entry. */
export interface ProviderConfig {
	/** Stable client-side id (`crypto.randomUUID()`), persisted across reloads. */
	id: string
	/** Which driver this entry configures. */
	kind: ProviderKind
	/** The server root URL (after {@link normalizeBaseUrl}). */
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
 * Read the persisted provider list.
 *
 * Returns `[]` for every failure mode — absent key, disabled storage, corrupt
 * JSON, an unknown schema version, or a payload of the wrong shape. A demo
 * app must never fail to start because of what is in storage, and the user
 * can always re-add a provider.
 *
 * @param storage - Storage backend (defaults to `localStorage`)
 * @returns The stored providers, or an empty list
 */
export function loadProviders(storage?: Storage): ProviderConfig[] {
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
		// would otherwise become a provider row that can never connect, and an
		// unrecognized `kind` has no driver to instantiate.
		return parsed.providers.filter(
			(p: unknown): p is ProviderConfig =>
				typeof p === "object" &&
				p !== null &&
				typeof (p as ProviderConfig).id === "string" &&
				(p as ProviderConfig).id.length > 0 &&
				PROVIDER_KINDS.includes((p as ProviderConfig).kind) &&
				typeof (p as ProviderConfig).baseUrl === "string" &&
				(p as ProviderConfig).baseUrl.length > 0 &&
				typeof (p as ProviderConfig).token === "string",
		)
	} catch {
		return []
	}
}

/**
 * Persist the provider list.
 *
 * ⚠️ Stores the bearer token verbatim in plaintext under this browser origin.
 * That is a deliberate trade-off for a local demo (one-click reconnect); a
 * production host should keep credentials out of `localStorage` and re-prompt
 * instead. Mirrors `mcp-store.ts`'s `saveServers` policy. It matters more for
 * an `openai` provider than for a local one: that token is a real,
 * billable API key, readable by any script on this origin, so use a key scoped
 * to a throwaway project — or a proxy that injects the key server-side.
 *
 * Silently no-ops when storage is unavailable or full — persistence is a
 * convenience here, and losing it must not break the session in progress.
 *
 * @param providers - Providers to persist
 * @param storage - Storage backend (defaults to `localStorage`)
 * @returns Whether the write succeeded
 */
export function saveProviders(providers: ProviderConfig[], storage?: Storage): boolean {
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
 * Strip a trailing API path segment (and any trailing slash) from a
 * user-entered address so the driver receives the server ROOT.
 *
 * Every driver appends its own API path — Ollama appends `/api/tags`, LM
 * Studio appends `/api/v0/models`, OpenAI appends `/v1/models` — so a baseUrl
 * that already ends in one would produce a doubled path. The three suffixes
 * users realistically paste are handled: `/api/v0` and `/v1` (the two
 * addresses LM Studio's Developer tab shows, and the one every OpenAI doc page
 * prints) and `/api` (Ollama's). A trailing endpoint name (`/models`, `/tags`)
 * is stripped first, since docs quote the full endpoint far more often than the
 * root. A bare root is returned unchanged.
 *
 * @param api - The user-entered address (e.g. `http://localhost:1234/api/v0`)
 * @returns The server root (e.g. `http://localhost:1234`)
 */
export function normalizeBaseUrl(api: string): string {
	let url = (api ?? "").trim()
	// Drop a trailing slash first so `/api/` and `/api` both reduce to `/api`.
	url = url.replace(/\/+$/, "")
	// Drop a trailing `/models` or `/tags` — the endpoint people copy out of a
	// provider's docs (`https://openrouter.ai/api/v1/models`) rather than its
	// root. Without this the driver appends its own path to it and requests
	// `.../v1/models/v1/models`, which 404s with an HTML body.
	url = url.replace(/\/(models|tags)$/i, "")
	// Now strip a trailing API-path segment (case-insensitive) if present.
	url = url.replace(/\/(api\/v0|v1|api)$/i, "")
	// A second slash trim in case stripping the segment exposed one.
	return url.replace(/\/+$/, "")
}

/**
 * Validate a user-entered provider API address.
 *
 * Only `http:`/`https:` are accepted: both drivers speak HTTP and nothing
 * else, so a `ws://` or `file://` entry is a mistake worth catching before it
 * becomes a confusing fetch failure. Mirrors `mcp-store.ts`'s
 * `validateServerUrl` style.
 *
 * @param url - The candidate address
 * @param kind - Which provider is being configured, for the message wording
 * @returns An error message, or null when the URL is usable
 */
export function validateApiUrl(url: string, kind: ProviderKind = "ollama"): string | null {
	const label = providerLabel(kind)
	const trimmed = (url ?? "").trim()
	if (trimmed === "") return `Enter the ${label} API address.`

	let parsed: URL
	try {
		parsed = new URL(trimmed)
	} catch {
		return `That is not a valid URL. Include the scheme, e.g. ${DEFAULT_PROVIDER_API[kind]}`
	}

	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		return `Only HTTP ${label} servers are supported — "${parsed.protocol}" is not.`
	}

	return null
}
