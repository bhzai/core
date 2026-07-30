/**
 * @file Pure helpers for the MCP servers panel: persistence, input parsing,
 * and error interpretation.
 *
 * DOM-free by convention (see `example/AGENTS.md`) so every branch here is
 * unit-testable in Node. `localStorage` is reached through the injectable
 * `storage` parameter rather than the global, which is what lets the
 * persistence tests run without a browser.
 */

/** localStorage key holding the configured server list. */
const STORAGE_KEY = "bhzai.mcp.servers"

/**
 * Schema version of the persisted payload. Bump it when the stored shape
 * changes; {@link loadServers} discards anything it does not recognize rather
 * than trying to migrate, since this is a demo app whose stored data is
 * trivially re-entered.
 */
const STORAGE_VERSION = 1

/** One persisted server entry. */
export interface StoredServer {
	/** Streamable-HTTP MCP endpoint. */
	url: string
	/** bhzai-local server name; namespaces the tools. */
	name?: string
	/** Extra request headers. */
	headers?: Record<string, string>
}

/** Result of parsing the headers textarea. */
export interface ParsedHeaders {
	/** Successfully parsed `Key: Value` pairs. */
	headers: Record<string, string>
	/** One message per malformed line, reported rather than dropped. */
	errors: string[]
}

/** The subset of a captured error {@link errorHint} needs to interpret it. */
export interface HintableError {
	name?: string
	message?: string
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
 * Read the persisted server list.
 *
 * Returns `[]` for every failure mode — absent key, disabled storage, corrupt
 * JSON, an unknown schema version, or a payload of the wrong shape. A demo
 * app must never fail to start because of what is in storage, and the user
 * can always re-add a server.
 *
 * @param storage - Storage backend (defaults to `localStorage`)
 * @returns The stored servers, or an empty list
 */
export function loadServers(storage?: Storage): StoredServer[] {
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
		if (!parsed || parsed.v !== STORAGE_VERSION || !Array.isArray(parsed.servers)) {
			return []
		}
		// Filter rather than trust: a hand-edited entry without a `url` would
		// otherwise become a server card that can never connect.
		return parsed.servers.filter(
			(s: unknown): s is StoredServer =>
				typeof s === "object" &&
				s !== null &&
				typeof (s as StoredServer).url === "string" &&
				(s as StoredServer).url.length > 0,
		)
	} catch {
		return []
	}
}

/**
 * Persist the server list.
 *
 * ⚠️ Stores request headers verbatim, including any `Authorization` bearer
 * token, in plaintext under this browser origin. That is a deliberate
 * trade-off for a local demo (one-click reconnect); a production host should
 * keep credentials out of `localStorage` and re-prompt instead.
 *
 * Silently no-ops when storage is unavailable or full — persistence is a
 * convenience here, and losing it must not break the session in progress.
 *
 * @param servers - Servers to persist
 * @param storage - Storage backend (defaults to `localStorage`)
 * @returns Whether the write succeeded
 */
export function saveServers(servers: StoredServer[], storage?: Storage): boolean {
	const backend = resolveStorage(storage)
	if (!backend) return false

	try {
		backend.setItem(STORAGE_KEY, JSON.stringify({ v: STORAGE_VERSION, servers }))
		return true
	} catch {
		return false
	}
}

/**
 * Parse the headers textarea: one `Key: Value` per line.
 *
 * Splits on the FIRST colon only, so values containing colons (a URL, a
 * timestamp) survive intact. Blank lines are ignored; malformed lines are
 * reported rather than dropped silently, so a mistyped header does not
 * present as a mysterious 401.
 *
 * @param text - Raw textarea contents
 */
export function parseHeaderLines(text: string): ParsedHeaders {
	const headers: Record<string, string> = {}
	const errors: string[] = []

	if (!text) return { headers, errors }

	const lines = text.split("\n")
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i].trim()
		if (line === "") continue

		const separator = line.indexOf(":")
		if (separator <= 0) {
			errors.push(`Line ${i + 1}: expected "Key: Value", got "${line}"`)
			continue
		}

		const key = line.slice(0, separator).trim()
		const value = line.slice(separator + 1).trim()
		if (key === "") {
			errors.push(`Line ${i + 1}: header name is empty`)
			continue
		}
		headers[key] = value
	}

	return { headers, errors }
}

/**
 * Validate a user-entered MCP endpoint.
 *
 * Only `http:`/`https:` are accepted: the client speaks streamable HTTP and
 * nothing else, so an `ws://` or `stdio://` entry is a mistake worth catching
 * before it becomes a confusing fetch failure.
 *
 * @param url - The candidate endpoint
 * @returns An error message, or null when the URL is usable
 */
export function validateServerUrl(url: string): string | null {
	const trimmed = (url ?? "").trim()
	if (trimmed === "") return "Enter the server's HTTP endpoint URL."

	let parsed: URL
	try {
		parsed = new URL(trimmed)
	} catch {
		return "That is not a valid URL. Include the scheme, e.g. https://example.com/mcp"
	}

	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		return `Only HTTP MCP servers are supported — "${parsed.protocol}" is not.`
	}

	return null
}

/**
 * Turn a captured `McpServerError` into a plain-language hint about what to
 * try next, or `null` when the message already speaks for itself.
 *
 * The `TypeError` case matters most: a browser reports a CORS rejection, a
 * DNS failure, and a refused connection identically, as an opaque "Failed to
 * fetch" with no detail available to JavaScript. Without this hint the bug
 * dialog would show a true but useless message.
 *
 * @param error - The captured error, or a nullish value
 * @returns A hint to display, or null
 */
export function errorHint(error: HintableError | null | undefined): string | null {
	if (!error) return null
	const name = error.name ?? ""
	const message = error.message ?? ""

	if (name === "TypeError" || /failed to fetch|networkerror|load failed/i.test(message)) {
		return (
			"The request never completed. The usual cause is CORS: the server must send " +
			"Access-Control-Allow-Origin for this page's origin and allow the Content-Type, " +
			"MCP-Protocol-Version, Mcp-Session-Id, and Authorization headers. It can also mean " +
			"the host is unreachable or nothing is listening on that URL."
		)
	}

	if (/HTTP 401|HTTP 403/.test(message)) {
		return "The server rejected the credentials. Check the Authorization header."
	}

	if (/HTTP 404/.test(message)) {
		return "No MCP endpoint at that path. Servers commonly mount it at /mcp."
	}

	if (/SSE stream/i.test(message)) {
		return (
			"The server replied with a text/event-stream response, which this client does not " +
			"parse yet (a documented gap). It needs to answer requests with application/json."
		)
	}

	return null
}
