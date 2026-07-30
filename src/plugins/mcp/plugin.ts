// The MCP plugin — the capability object that fills the kernel's MCP seam
// (ARCHITECTURE.md § 7.2, § 9.3).
//
// WHY THIS EXISTS: `src/core/` must never import `src/plugins/` (packaging
// rule 1), so `bh.addMcp()` cannot construct an `McpClient` on its own. The
// kernel instead exposes `bh.registerMcpClientFactory()` and refuses to attach
// anything until something fills it — its error message literally reads
// "Call `bh.use(mcpPlugin)`". This module is that `mcpPlugin`: the host-side
// half of the inversion, plus the {@link McpManager} that makes attached
// servers observable.
//
// LIFECYCLE ORDERING: form-2 capability objects have no `setup` hook (the
// allowlist has no such key), so registration happens in `initialize`, which
// `bh.init()` runs in step 2 — after every plugin's `initialize`, but BEFORE
// it resolves `getMcps` hooks. The factory is therefore in place for both
// declaratively-attached servers (this plugin's own `getMcps`) and imperative
// `bh.addMcp()` calls made after `init()` resolves. The one thing a host
// cannot do is `addMcp()` before `init()` — that throws, as it did before this
// plugin existed.

import type { BHZAI, BHZAIPluginCapabilities } from "../../core/bhzai.js"
import type { ToolRegistry } from "../../tools/registry.js"
import type { McpServerConfig } from "../../types/mcp.js"
import { McpClient, type McpClientOptions } from "./client.js"
import { McpManager, type McpManagerHost } from "./manager.js"

/** Options for {@link createMcpPlugin}. */
export interface McpPluginOptions {
	/**
	 * Plugin name, used for `use()` idempotency and activation toggles
	 * (`bh.disablePlugin(name)`). Defaults to `"mcp"`. Override it only to run
	 * two independently-toggleable MCP plugins on one kernel.
	 */
	name?: string
	/**
	 * Servers attached declaratively during `bh.init()` via the `getMcps` hook.
	 * Equivalent to calling `manager.add()` for each after init, except these
	 * attach through the kernel's own hook resolution — which means a failure
	 * rejects `bh.init()` rather than surfacing as an `error` state. Use this
	 * for servers the host considers mandatory; use `manager.add()` for
	 * user-supplied ones.
	 */
	servers?: McpServerConfig[]
	/**
	 * Default {@link McpClientOptions} applied to every client this plugin
	 * constructs — the approval gate, capability opt-ins, driver registry for
	 * sampling, and per-call timeout. Per-attach options passed to
	 * `bh.addMcp(config, options)` are merged over these.
	 */
	clientOptions?: McpClientOptions
}

/**
 * Managers created by this module, keyed by the kernel they are bound to, so
 * {@link getMcpManager} can find a manager the host never held a reference to
 * (the zero-config {@link mcpPlugin} form). A `WeakMap` rather than a `Map`:
 * a disposed kernel must not be kept alive by this lookup.
 */
const managers: WeakMap<BHZAI, McpManager> = new WeakMap()

/**
 * Build the MCP plugin and its manager together.
 *
 * The manager is returned immediately, before any kernel exists to back it —
 * it holds a deferred host that resolves to the `bh` passed to `initialize`.
 * Calling a manager method before `bh.init()` therefore throws a specific,
 * actionable error rather than a `TypeError` on an undefined kernel.
 *
 * ONE KERNEL PER CALL: the returned pair is bound to the first `BHZAI` it is
 * `use()`d on. Registering the same object on a second kernel throws — two
 * kernels sharing one manager would have it report servers attached to
 * whichever initialized last. Call this once per `BHZAI` instance.
 *
 * @example
 * ```ts
 * const { plugin, manager } = createMcpPlugin()
 * bh.use(plugin)
 * await bh.init()
 * const state = await manager.add({ url: "https://example.com/mcp" })
 * ```
 */
export function createMcpPlugin(options?: McpPluginOptions): {
	plugin: BHZAIPluginCapabilities
	manager: McpManager
} {
	let bound: BHZAI | undefined

	const requireBound = (): BHZAI => {
		if (!bound) {
			throw new Error(
				"McpManager: the MCP plugin has not been initialized yet. " +
					"Call `bh.use(plugin)` and `await bh.init()` before attaching MCP servers.",
			)
		}
		return bound
	}

	const host: McpManagerHost = {
		addMcp: (config, opts) => requireBound().addMcp(config, opts ?? options?.clientOptions),
		listTools: (filter) => requireBound().listTools(filter),
		removeTool: (name) => requireBound().removeTool(name),
	}

	const manager = new McpManager(host, { clientOptions: options?.clientOptions })

	const plugin: BHZAIPluginCapabilities = {
		name: options?.name ?? "mcp",
		initialize({ bh }) {
			if (bound && bound !== bh) {
				throw new Error(
					"createMcpPlugin(): this plugin is already bound to a different BHZAI instance. " +
						"Call createMcpPlugin() once per kernel.",
				)
			}
			bound = bh
			managers.set(bh, manager)
			bh.registerMcpClientFactory((config, toolRegistry: ToolRegistry, opts?: unknown) => {
				// Per-attach options win over the plugin-level defaults, so a
				// single server can opt into (say) elicitation without every
				// other server on the kernel inheriting it.
				return new McpClient(config, toolRegistry, {
					...options?.clientOptions,
					...(opts as McpClientOptions | undefined),
				})
			})
		},
		getMcps: async () => options?.servers ?? [],
	}

	return { plugin, manager }
}

/**
 * The zero-config MCP plugin, so the kernel's own guidance — "Call
 * `bh.use(mcpPlugin)`" — works verbatim.
 *
 * Safe to register on several kernels: unlike a {@link createMcpPlugin}
 * result, this object holds no per-kernel state. Each `initialize` creates a
 * fresh manager for its own kernel, retrievable with {@link getMcpManager}.
 * Reach for `createMcpPlugin()` instead when you need client options,
 * declarative servers, or a direct handle on the manager.
 */
export const mcpPlugin: BHZAIPluginCapabilities = {
	name: "mcp",
	initialize({ bh }) {
		const host: McpManagerHost = {
			addMcp: (config, opts) => bh.addMcp(config, opts),
			listTools: (filter) => bh.listTools(filter),
			removeTool: (name) => bh.removeTool(name),
		}
		managers.set(bh, new McpManager(host))
		bh.registerMcpClientFactory(
			(config, toolRegistry: ToolRegistry, opts?: unknown) =>
				new McpClient(config, toolRegistry, opts as McpClientOptions | undefined),
		)
	},
}

/**
 * The {@link McpManager} bound to `bh`, or `undefined` if no MCP plugin has
 * initialized on it yet. Works for both plugin forms; the
 * {@link createMcpPlugin} form also hands the manager back directly, which
 * avoids the "did init run yet?" question entirely.
 */
export function getMcpManager(bh: BHZAI): McpManager | undefined {
	return managers.get(bh)
}
