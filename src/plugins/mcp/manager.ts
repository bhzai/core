// MCP server lifecycle manager — observable connect/retry/refresh/detach state
// on top of `bh.addMcp()` (ARCHITECTURE.md § 6 line 215, § 9.3).
//
// WHY THIS EXISTS: `McpRegistry` (src/core/mcp-integration.ts) stores handles
// and fires `mcp.attached`, but it deliberately keeps no lifecycle state — it
// has no notion of "connecting", it does not retain WHY a connect failed, and
// it has no detach path. A host that renders MCP servers in a UI needs all
// three: a status to show while the handshake is in flight, the structured
// failure reason to show when it fails, and a way to take a server back out.
// This class is that layer, and it lives in the plugin (not the kernel)
// because the kernel must stay free of anything optional (§ 5, packaging rule
// 1).
//
// ENVIRONMENT BOUNDARY (§ 5): web-standard APIs only — `crypto.randomUUID`,
// `Date.now`. No Node built-ins.

import type { McpHandle } from "../../core/mcp-integration.js"
// Imported from the leaf type modules rather than the `types/` barrel: the
// barrel and `types/tool.ts` are mutually dependent, so re-exporting through it
// lands them in different rollup chunks and the build warns about the resulting
// circular chunk dependency.
import type { McpServerConfig } from "../../types/mcp.js"
import type { BHZAIToolDefinition, ToolFilter } from "../../types/tool.js"
import { deriveServerName } from "./client.js"
import type { McpClientOptions } from "./client.js"

/**
 * Lifecycle state of a managed MCP server.
 *
 * - `connecting` — `bh.addMcp()` is in flight (handshake + discovery).
 * - `connected` — the handshake succeeded; `tools` is populated.
 * - `error` — the last `connect`/`refresh` attempt failed; `error` explains why.
 * - `detached` — transient, only observed by a listener that runs during
 *   {@link McpManager.remove}; the entry is dropped immediately after.
 */
export type McpServerStatus = "connecting" | "connected" | "error" | "detached"

/**
 * A structured, render-ready snapshot of a failure. Deliberately a plain data
 * object rather than the `Error` itself: the UI needs to show the same fields
 * for an `McpHandshakeError` thrown by the client and for the opaque
 * `TypeError: Failed to fetch` a browser produces on a CORS rejection, and a
 * plain object survives being held in state without retaining the stack of
 * whatever threw it.
 */
export interface McpServerError {
	/** The error's constructor name, e.g. `"McpHandshakeError"` or `"TypeError"`. */
	name: string
	/** The error message, verbatim. */
	message: string
	/** The stack trace when the thrown value carried one. */
	stack?: string
	/** The endpoint the failed attempt targeted, for display alongside the message. */
	url: string
	/** `Date.now()` at capture time. */
	at: number
	/** Which operation failed — the same error text means different things per phase. */
	phase: "connect" | "refresh" | "detach"
}

/** One discovered tool, in the shape a UI wants rather than the registry's. */
export interface McpServerTool {
	/** The bhzai-local registry key: `mcp__<server>__<tool>`. */
	name: string
	/** The bare remote tool name, with the `mcp__<server>__` prefix stripped. */
	shortName: string
	/** The server-supplied description (untrusted text — render with `textContent`). */
	description: string
}

/**
 * An immutable snapshot of one managed server. Every {@link McpManager}
 * transition replaces the whole object rather than mutating it, so a UI can
 * hold a previous snapshot for comparison without it changing underfoot.
 */
export interface McpServerState {
	/** Stable identity, generated at `add()` time and preserved across retries. */
	readonly id: string
	/** The config this entry was created with. */
	readonly config: McpServerConfig
	/**
	 * The bhzai-local server name used to namespace tools. Resolved from
	 * `config.name`, falling back to the URL hostname the same way
	 * {@link McpClient} derives it, so the namespace prefix is known before the
	 * handshake completes.
	 */
	readonly serverName: string
	readonly status: McpServerStatus
	/** Discovered tools; empty until `connected` (and for a deferred attach, the two synthetic tools). */
	readonly tools: McpServerTool[]
	/** Present when `status` is `error`. */
	readonly error?: McpServerError
	/** `Date.now()` of the most recent successful connect. */
	readonly connectedAt?: number
	/** Whether this server was attached with deferred tool loading (§ 9.4). */
	readonly deferred: boolean
}

/**
 * The narrow slice of `BHZAI` the manager needs. Declared as an interface —
 * rather than importing the kernel class — for the same reason
 * {@link McpClientLike} exists on the kernel side: it keeps the dependency
 * one-directional and lets the manager be unit-tested against a fake host
 * without constructing a whole kernel.
 */
export interface McpManagerHost {
	addMcp(config: McpServerConfig, options?: unknown): Promise<McpHandle>
	listTools(filter?: ToolFilter): BHZAIToolDefinition[]
	removeTool(name: string): void
}

/** A subscriber notified with the full server list on every transition. */
export type McpManagerListener = (states: McpServerState[]) => void

/** Options for {@link McpManager}. */
export interface McpManagerOptions {
	/** `McpClientOptions` forwarded to every `addMcp()` this manager performs. */
	clientOptions?: McpClientOptions
}

/**
 * Normalize an unknown thrown value into a {@link McpServerError}. Handles the
 * non-`Error` throw (a string, a rejected non-Error) that a `catch` can always
 * receive, so the UI never has to render `undefined`.
 */
function toServerError(
	thrown: unknown,
	url: string,
	phase: McpServerError["phase"],
): McpServerError {
	if (thrown instanceof Error) {
		return {
			name: thrown.name,
			message: thrown.message,
			stack: thrown.stack,
			url,
			at: Date.now(),
			phase,
		}
	}
	return {
		name: "Error",
		message: typeof thrown === "string" ? thrown : String(thrown),
		url,
		at: Date.now(),
		phase,
	}
}

/**
 * Tracks the lifecycle of every MCP server a host attaches, and notifies
 * subscribers on each transition.
 *
 * REJECTION POLICY — deliberate divergence from `bh.addMcp()`: {@link add},
 * {@link retry}, and {@link refresh} NEVER reject. A failed connect is a
 * first-class, displayable state here, not an exception: a UI driving off
 * `subscribe()` would otherwise have to reconcile two sources of truth (the
 * state stream and a thrown error) that can disagree. Callers who want the
 * failure as a rejection should use `bh.addMcp()` directly. {@link remove} is
 * the one method that can reject, and only on an unknown id — a caller bug,
 * not a server condition.
 *
 * All state transitions notify synchronously, including the `connecting` one
 * that happens BEFORE the network call. That ordering is the whole point: it
 * is what lets a UI show the in-flight state instead of freezing until the
 * handshake settles.
 */
export class McpManager {
	private readonly host: McpManagerHost
	private readonly clientOptions: McpClientOptions | undefined

	/** Entries in insertion order — `Map` iteration order is the display order. */
	private readonly entries: Map<string, McpServerState> = new Map()

	/** Live handles, keyed by the same entry id, for refresh/detach. */
	private readonly handles: Map<string, McpHandle> = new Map()

	private readonly listeners: Set<McpManagerListener> = new Set()

	constructor(host: McpManagerHost, options?: McpManagerOptions) {
		this.host = host
		this.clientOptions = options?.clientOptions
	}

	/**
	 * Attach a server. Inserts a `connecting` entry and notifies BEFORE
	 * awaiting the handshake, then resolves with the terminal (`connected` or
	 * `error`) state.
	 *
	 * A server name already in use is refused up front with an `error` state
	 * rather than attached: `McpRegistry` is keyed by server name and is
	 * last-attach-wins, so a duplicate would orphan the previous handle while
	 * its tools stayed in the registry under the same prefix — leaving the two
	 * entries permanently indistinguishable.
	 */
	async add(config: McpServerConfig): Promise<McpServerState> {
		const id = crypto.randomUUID()
		const serverName = config.name ?? deriveServerName(config.url)
		const base: McpServerState = {
			id,
			config,
			serverName,
			status: "connecting",
			tools: [],
			deferred: config.deferred === true,
		}

		const clash = this.findByServerName(serverName)
		if (clash) {
			// Refused, but still recorded: a silently-dropped add would look
			// like a hung "connecting" card to the user.
			return this.set({
				...base,
				status: "error",
				error: {
					name: "McpDuplicateServerError",
					message: `An MCP server named '${serverName}' is already attached. Remove it first, or give this one a distinct name.`,
					url: config.url,
					at: Date.now(),
					phase: "connect",
				},
			})
		}

		this.set(base)
		return this.connect(id)
	}

	/**
	 * Re-attempt the connection for an existing entry, keeping its id (and so
	 * its position in the list and any UI state keyed on it). A no-op returning
	 * the current state if the entry is already `connected`.
	 */
	async retry(id: string): Promise<McpServerState> {
		const current = this.entries.get(id)
		if (!current) {
			throw new Error(`McpManager.retry(): no MCP server with id '${id}'`)
		}
		if (current.status === "connected") return current
		this.set({ ...current, status: "connecting", error: undefined })
		return this.connect(id)
	}

	/**
	 * Re-sync the tool list for a connected server.
	 *
	 * This is the MANUAL path that stands in for push updates: the client does
	 * not hold an SSE stream open, so `notifications/tools/list_changed` never
	 * arrives (a gap documented in `docs/plugins/mcp-client.md`). Calls
	 * `pollToolsList()`, which itself no-ops unless the server declared
	 * `tools.listChanged`, then re-derives the tool list from the registry.
	 */
	async refresh(id: string): Promise<McpServerState> {
		const current = this.entries.get(id)
		if (!current) {
			throw new Error(`McpManager.refresh(): no MCP server with id '${id}'`)
		}
		const handle = this.handles.get(id)
		if (!handle || current.status !== "connected") return current

		try {
			const client = handle.client as { pollToolsList?: () => Promise<unknown> }
			await client.pollToolsList?.()
			return this.set({ ...current, tools: this.readTools(current.serverName) })
		} catch (thrown) {
			return this.set({
				...current,
				status: "error",
				error: toServerError(thrown, current.config.url, "refresh"),
			})
		}
	}

	/**
	 * Detach a server: close its session, unregister every tool its discovery
	 * put into the shared registry, and drop the entry.
	 *
	 * Tool cleanup happens HERE rather than in `McpClient.close()` because the
	 * client is not the registry's owner — `close()` is transport-only, and
	 * making it destructive would break `bh.dispose()`, which calls it on every
	 * handle while tearing the registry down by other means.
	 *
	 * A failing `close()` does not abort the detach: the local teardown must
	 * complete regardless of whether the remote acknowledged, or a server that
	 * has already gone away would be un-removable. Such a failure is reported
	 * through the `detach`-phase notification and then discarded with the entry.
	 */
	async remove(id: string): Promise<void> {
		const current = this.entries.get(id)
		if (!current) {
			throw new Error(`McpManager.remove(): no MCP server with id '${id}'`)
		}
		const handle = this.handles.get(id)

		if (handle) {
			try {
				await handle.client.close?.()
			} catch (thrown) {
				this.set({
					...current,
					status: "detached",
					error: toServerError(thrown, current.config.url, "detach"),
				})
			}
		}

		// Unregister by prefix rather than by the recorded `tools` list: a
		// deferred server registers its real tools lazily, long after the
		// snapshot was taken, so the snapshot would under-report them.
		for (const tool of this.host.listTools()) {
			if (tool.name.startsWith(`mcp__${current.serverName}__`)) {
				this.host.removeTool(tool.name)
			}
		}

		this.handles.delete(id)
		this.entries.delete(id)
		this.notify()
	}

	/** Every managed server, in the order they were added. */
	list(): McpServerState[] {
		return Array.from(this.entries.values())
	}

	/** One managed server by id, or `undefined`. */
	get(id: string): McpServerState | undefined {
		return this.entries.get(id)
	}

	/**
	 * Subscribe to state changes. The listener fires on every transition with
	 * the full list (not a delta) — the list is small and a whole-list render
	 * is far simpler to get right than incremental patching. Returns an
	 * unsubscribe function.
	 *
	 * Does NOT fire immediately on subscribe: a caller that wants the current
	 * state has {@link list} for that, synchronously.
	 */
	subscribe(listener: McpManagerListener): () => void {
		this.listeners.add(listener)
		return () => {
			this.listeners.delete(listener)
		}
	}

	// -------------------------------------------------------------------------
	// Internals.
	// -------------------------------------------------------------------------

	/**
	 * Run the attach for an entry that is already in `connecting`, and record
	 * the outcome. Shared by {@link add} and {@link retry}.
	 */
	private async connect(id: string): Promise<McpServerState> {
		const current = this.entries.get(id)
		if (!current) {
			throw new Error(`McpManager: entry '${id}' vanished mid-connect`)
		}
		try {
			const handle = await this.host.addMcp(current.config, this.clientOptions)
			this.handles.set(id, handle)
			// Prefer the handle's resolved name over our own derivation — the
			// client is the authority on what prefix it registered under.
			const serverName = handle.serverName || current.serverName
			return this.set({
				...current,
				serverName,
				status: "connected",
				tools: this.readTools(serverName),
				error: undefined,
				connectedAt: Date.now(),
			})
		} catch (thrown) {
			return this.set({
				...current,
				status: "error",
				tools: [],
				error: toServerError(thrown, current.config.url, "connect"),
			})
		}
	}

	/** Derive this server's tools from the shared registry by name prefix. */
	private readTools(serverName: string): McpServerTool[] {
		const prefix = `mcp__${serverName}__`
		return this.host
			.listTools()
			.filter((tool) => tool.name.startsWith(prefix))
			.map((tool) => ({
				name: tool.name,
				shortName: tool.name.slice(prefix.length),
				description: tool.description ?? "",
			}))
	}

	/** Store a state snapshot and notify. Returns the snapshot for chaining. */
	private set(state: McpServerState): McpServerState {
		this.entries.set(state.id, state)
		this.notify()
		return state
	}

	/** Find an existing entry by resolved server name, if any. */
	private findByServerName(serverName: string): McpServerState | undefined {
		for (const entry of this.entries.values()) {
			if (entry.serverName === serverName) return entry
		}
		return undefined
	}

	/**
	 * Notify every listener with a fresh list. Each listener is isolated: a
	 * throwing subscriber must not prevent the others from being told, nor
	 * turn a successful state transition into a rejected `add()`.
	 */
	private notify(): void {
		const snapshot = this.list()
		for (const listener of this.listeners) {
			try {
				listener(snapshot)
			} catch {
				// A subscriber's own bug is not this manager's to propagate.
			}
		}
	}
}
