// MCP integration — `bh.addMcp()` + `getMcps`/`modelSource` plugin-hook
// resolution (ARCHITECTURE.md § 6 line 215, § 7.2, § 8.5 step 2, § 9.3,
// § 10.5).
//
// Scope of THIS file (TASK_0015):
//  - `McpHandle` — the opaque handle `bh.addMcp()` returns, exposing the
//    live `McpClient` for advanced host access (re-sync, capability
//    queries, `notifyRootsChanged()`).
//  - `addMcp(server, options?)` — construct an `McpClient`, await
//    `connect()`, return the `McpHandle`, and fire the `mcp.attached`
//    framework event (§ 8.1) with `{ server, tools }`.
//  - `resolveGetMcpsHooks()` / `resolveModelSourceHooks()` — the two
//    capability-object hook resolvers called from `bh.init()` per § 8.5
//    step 2 (AFTER all `initialize` hooks have run, BEFORE the
//    `initialize` framework event fires). `getMcps` hooks each return a
//    `McpServerConfig[]` which is attached via `addMcp()`; `modelSource`
//    hooks each return a `ModelInfo[]` which is merged into
//    `bh.listModels()` alongside the driver registry's catalogue.
//
// ENVIRONMENT BOUNDARY (§ 5): web-standard APIs only. This file imports
// `McpClient` from `src/plugins/mcp/client.js` — WAIT, that would violate
// the packaging rule "Core imports nothing optional / nothing from
// src/plugins/**". To respect that rule, this file does NOT import
// `McpClient` directly. Instead, `addMcp()` accepts an injected
// `McpClient` constructor (or factory) from the host/plugin layer, and
// the kernel only depends on the `McpClientLike` interface defined below.
// The actual `McpClient` wiring is done by the MCP plugin's `setup()`
// hook, which registers the constructor into the kernel via a seam. This
// keeps `src/core/**` free of any `src/plugins/**` import, per
// `.claude/rules/packaging.md` rule 1.
//
// PATH NOTE: TASK_0015 specifies `bhzai/src/kernel/mcp-integration.ts`, but
// the repo convention (established by TASK_0002/TASK_0003) places the
// kernel under `src/core/`. This file follows the existing convention;
// the behavioral contract is unchanged.

import type { ToolRegistry } from "../tools/registry.js"
import type { McpServerConfig, ModelInfo } from "../types/index.js"
import type { EventBus } from "./event-bus.js"

/**
 * The minimal `McpClient`-like surface the kernel needs to attach an MCP
 * server. Defined here (in `src/core/`) so the kernel never imports from
 * `src/plugins/mcp/` — the MCP plugin injects its real `McpClient`
 * constructor (which satisfies this interface) via the
 * {@link McpClientFactory} seam registered during the plugin's `setup()`.
 *
 * The interface is intentionally narrow: only `connect()` and `serverName`
 * are required for `addMcp()` to do its job. The full `McpClient` exposes
 * many more methods (re-sync, capability queries, `notifyRootsChanged`,
 * etc.) which the host accesses via the {@link McpHandle.client} field's
 * real type — the kernel itself only needs the narrow surface.
 */
export interface McpClientLike {
	/** Run the handshake + discovery. */
	connect(): Promise<void>
	/** The bhzai-local server name. */
	readonly serverName: string
	/**
	 * Close the MCP session (TASK_0035). Optional so existing MCP client
	 * implementations remain structurally compatible. Called during
	 * `bh.dispose()` to cleanly shut down each attached session.
	 */
	close?(): Promise<void>
}

/**
 * Factory that constructs an `McpClientLike` from a `McpServerConfig` and
 * the shared `ToolRegistry`. The MCP plugin registers its real
 * `McpClient` constructor here during `setup()`, so the kernel can
 * instantiate clients without importing the plugin module.
 *
 * The `options` argument is the same `McpClientOptions` shape the plugin
 * defines (approval gate, capabilities, driver registry, event bus,
 * callTimeoutMs) — typed opaquely here as `unknown` so the kernel does not
 * depend on the plugin's option types. The plugin's registered factory is
 * responsible for forwarding `options` to its `McpClient` constructor.
 */
export type McpClientFactory = (
	config: McpServerConfig,
	toolRegistry: ToolRegistry,
	options?: unknown,
) => McpClientLike

/**
 * The opaque handle `bh.addMcp()` returns (§ 6 line 215). Exposes the live
 * `McpClient`-like instance for advanced host access (manual re-sync,
 * capability queries, `notifyRootsChanged()`). The handle is also stored
 * internally so `bh.dispose()` (TASK_0035) can close the session.
 *
 * `client` is typed as `McpClientLike` from the kernel's perspective; the
 * host can narrow it to the real `McpClient` type via a type assertion if
 * it needs the full surface (the runtime object IS the real `McpClient`).
 */
export interface McpHandle {
	/** The bhzai-local server name (mirrors `client.serverName`). */
	readonly serverName: string
	/** The live MCP client instance (narrow to the real type in host code). */
	readonly client: McpClientLike
}

/**
 * The payload of the `mcp.attached` framework event (§ 8.1).
 * `server` is the bhzai-local server name; `tools` is the list of
 * namespaced tool names (`mcp__<server>__<tool>`) discovered during the
 * attach. For deferred attaches (TASK_0016), `tools` is the two synthetic
 * tool names (`mcp__<server>__list_tools`, `mcp__<server>__search_tools`).
 */
export interface McpAttachedPayload {
	/** The bhzai-local server name. */
	server: string
	/** Namespaced tool names registered by this attach. */
	tools: string[]
}

/**
 * The registry of attached MCP handles, keyed by server name. Backs
 * `bh.addMcp()` and the `getMcps` hook resolver. Stored on the `BHZAI`
 * instance (not globally) so multiple `BHZAI` instances coexist without
 * collision (§ 5 "no global state").
 */
export class McpRegistry {
	/** Handles keyed by `serverName`; last attach wins (shadowing convention). */
	private readonly handles: Map<string, McpHandle> = new Map()

	/**
	 * @param bus The framework event bus, used to fire `mcp.attached` (§ 8.1).
	 *   This is a non-blockable framework event; the registry dispatches it
	 *   via the bus's kernel bypass (`dispatch()`), consistent with how the
	 *   other registries fire their events.
	 * @param toolRegistry The shared tool registry MCP clients register
	 *   discovered tools into.
	 */
	constructor(
		private readonly bus: EventBus,
		private readonly toolRegistry: ToolRegistry,
	) {}

	/**
	 * The `McpClientFactory` registered by the MCP plugin during `setup()`.
	 * `undefined` until the plugin is registered; `addMcp()` throws with a
	 * clear message if called before then.
	 */
	private factory: McpClientFactory | undefined

	/**
	 * Register the `McpClient` constructor factory. Called by the MCP
	 * plugin's `setup()` hook (which runs at `bh.use()` time). Until this
	 * is called, `addMcp()` refuses with a clear error explaining that the
	 * MCP plugin must be registered first.
	 */
	registerClientFactory(factory: McpClientFactory): void {
		this.factory = factory
	}

	/**
	 * Attach an MCP server (§ 6 line 215, § 9.3). Constructs an
	 * `McpClient` via the registered factory, awaits `connect()` (handshake
	 * + discovery), stores the handle, and fires the `mcp.attached`
	 * framework event (§ 8.1) with `{ server, tools }`.
	 *
	 * @param config   The server config (url, headers, name, deferred, trusted).
	 * @param options  Opaque options forwarded to the `McpClient`
	 *                 constructor (approval gate, capabilities, driver
	 *                 registry, event bus, callTimeoutMs). Typed as
	 *                 `unknown` so the kernel does not depend on the
	 *                 plugin's option types.
	 * @returns The {@link McpHandle} for advanced host access.
	 * @throws {Error} if the MCP plugin has not been registered (no
	 *         `McpClientFactory` is available).
	 */
	async addMcp(config: McpServerConfig, options?: unknown): Promise<McpHandle> {
		if (!this.factory) {
			throw new Error(
				"bh.addMcp(): the MCP plugin is not registered. Call `bh.use(mcpPlugin)` " +
					"(or otherwise register an McpClientFactory) before attaching MCP servers.",
			)
		}
		const client = this.factory(config, this.toolRegistry, options)
		await client.connect()
		const handle: McpHandle = { serverName: client.serverName, client }
		this.handles.set(client.serverName, handle)
		// Snapshot the currently-registered tool names that belong to this
		// server (prefix `mcp__<server>__`) for the `mcp.attached` payload.
		// This is computed AFTER connect() so discovery has registered them.
		const tools = this.toolRegistry
			.listTools()
			.filter((t) => t.name.startsWith(`mcp__${client.serverName}__`))
			.map((t) => t.name)
		// Fire-and-forget: `mcp.attached` is a non-blockable notification
		// event. Dispatched through the bus's kernel bypass (§ 8.4 rule 2).
		void this.bus.dispatch<McpAttachedPayload>("mcp.attached", {
			server: client.serverName,
			tools,
		})
		return handle
	}

	/** Look up a handle by server name, or `undefined` if not attached. */
	get(serverName: string): McpHandle | undefined {
		return this.handles.get(serverName)
	}

	/** All attached handles, in attach order. */
	list(): McpHandle[] {
		return Array.from(this.handles.values())
	}

	/** Number of currently-attached servers. */
	get size(): number {
		return this.handles.size
	}
}

/**
 * The capability-object hook shapes this task resolves during `bh.init()`
 * (§ 8.5 step 2). Narrowed from the loose `unknown[]` types in
 * `BHZAIPluginCapabilities` (TASK_0003) to the real types here, on the
 * owning task (per the TASK_0003 narrowing note).
 */
export interface ResolvedGetMcpsHook {
	/** Returns a list of MCP server configs to attach via `addMcp()`. */
	getMcps: () => Promise<McpServerConfig[]>
	/**
	 * Name of the plugin that declared this hook, when known. Carried purely so
	 * the kernel can attribute the resulting attachments back to their plugin
	 * for activation gating; this module never interprets it.
	 */
	owner?: string
}
export interface ResolvedModelSourceHook {
	/** Returns a list of model catalogue entries to merge into `listModels()`. */
	modelSource: () => Promise<ModelInfo[]>
	/** Name of the plugin that declared this hook, when known. See {@link ResolvedGetMcpsHook.owner}. */
	owner?: string
}

/**
 * Resolve every registered `getMcps` capability hook in registration order,
 * attach each returned `McpServerConfig` via `registry.addMcp()`, and
 * return the resulting handles. Per § 8.5 step 2, this runs AFTER all
 * `initialize` hooks have completed and BEFORE the `initialize` framework
 * event fires.
 *
 * PARTIAL-FAILURE ASSUMPTION (the spec does not specify): if any one
 * hook throws or any `addMcp()` call rejects, the whole resolution
 * rejects — rather than silently swallowing one hook's failure. This
 * matches TASK_0009's `DriverRegistry.listModels()` partial-failure
 * assumption for consistency across all hook-resolution paths.
 *
 * @param hooks    The `getMcps` hooks to resolve, in registration order.
 * @param registry The {@link McpRegistry} to attach servers through.
 * @param options  Opaque options forwarded to each `addMcp()` call
 *                 (approval gate, capabilities, etc.). The same options
 *                 are applied to every hook-attached server; a hook that
 *                 needs per-server options should call `bh.addMcp()`
 *                 directly from its `initialize` body instead.
 * @param onAttached Optional callback invoked after each successful attach with
 *                 the hook that produced it and the resulting handle. The
 *                 kernel uses it to attribute the attached server (and the
 *                 tools its discovery registered) to `hook.owner`.
 *                 Attribution is reported here rather than inferred from an
 *                 ambient scope because `addMcp()` registers its tools after
 *                 an `await`, where no synchronous scope survives.
 */
export async function resolveGetMcpsHooks(
	hooks: ResolvedGetMcpsHook[],
	registry: McpRegistry,
	options?: unknown,
	onAttached?: (hook: ResolvedGetMcpsHook, handle: McpHandle) => void,
): Promise<McpHandle[]> {
	const handles: McpHandle[] = []
	for (const hook of hooks) {
		const configs = await hook.getMcps()
		for (const config of configs) {
			const handle = await registry.addMcp(config, options)
			onAttached?.(hook, handle)
			handles.push(handle)
		}
	}
	return handles
}

/**
 * Resolve every registered `modelSource` capability hook in registration
 * order, concatenate the returned `ModelInfo[]` arrays, and return the
 * merged list. Per § 8.5 step 2, this runs AFTER all `initialize` hooks
 * have completed and BEFORE the `initialize` framework event fires. The
 * result is merged with the driver registry's `listModels()` output by
 * the kernel (see `BHZAI.listModels()`).
 *
 * PARTIAL-FAILURE ASSUMPTION (mirrors {@link resolveGetMcpsHooks}): if any
 * one hook throws, the whole resolution rejects.
 *
 * NO DE-DUPLICATION: entries are NOT deduplicated across hooks (or against
 * the driver registry's catalogue) — different hooks may legitimately
 * contribute models with overlapping identifiers, and de-duplication
 * policy is not specified anywhere in the doc. This matches
 * `DriverRegistry.listModels()`'s no-de-duplication convention.
 *
 * @param hooks The `modelSource` hooks to resolve, in registration order.
 * @param onResolved Optional callback invoked after each hook resolves, with the
 *              hook and the models it contributed. The kernel uses it to keep a
 *              per-owner view of the catalogue so a deactivated plugin's models
 *              can drop out of `bh.listModels()`. The merged return value is
 *              unchanged either way.
 */
export async function resolveModelSourceHooks(
	hooks: ResolvedModelSourceHook[],
	onResolved?: (hook: ResolvedModelSourceHook, models: ModelInfo[]) => void,
): Promise<ModelInfo[]> {
	const merged: ModelInfo[] = []
	for (const hook of hooks) {
		const models = await hook.modelSource()
		onResolved?.(hook, models)
		for (const m of models) {
			merged.push(m)
		}
	}
	return merged
}
