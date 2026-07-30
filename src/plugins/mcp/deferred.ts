// Deferred tool loading — `search_tools` synthetic tools (ARCHITECTURE.md
// § 9.4). Purely client-side policy layered over the standard protocol.
//
// Scope of THIS file (TASK_0016):
//  - When an MCP server is attached with `{ deferred: true }`, register
//    ONLY two synthetic tools (`mcp__<server>__list_tools` and
//    `mcp__<server>__search_tools`) instead of eagerly registering every
//    discovered tool.
//  - Cache the full `tools/list` discovery result internally so the
//    synthetic tools can answer without re-fetching.
//  - When the model calls either synthetic tool, trigger eager real-tool
//    registration (registering every cached tool into the shared
//    `ToolRegistry`), then answer the synthetic call with the discovery
//    result (filtered by keyword for `search_tools`).
//
// PURELY CLIENT-SIDE POLICY (§ 9.4): the wire exchanges remain plain
// paginated `tools/list` + `tools/call`; no server support or protocol
// extension is required. `search_tools` filters the cached `tools/list`
// result by keyword — it does NOT send a server-side search request.
//
// ENVIRONMENT BOUNDARY (§ 5): web-standard APIs only. This file touches
// nothing outside of plain TypeScript — no `fetch` directly (it uses the
// `McpClient`'s transport methods via the injected `DeferredContext`).

import type { BHZAIToolDefinition, JSONSchema } from "../../types/index.js"

/**
 * A minimal projection of `McpTool` (the shape `McpClient.discoverTools()`
 * parses from `tools/list`). Defined here so this module does not need to
 * import the full `McpClient` type. The real `McpClient` passes its
 * cached discovery result into {@link registerDeferredTools} as this shape.
 */
export interface DeferredMcpTool {
	/** The original (unprefixed) MCP tool name. */
	name: string
	/** The tool's description. */
	description?: string
	/** The tool's input schema. */
	inputSchema?: JSONSchema
	/** The tool's output schema (optional). */
	outputSchema?: JSONSchema
	/** Passthrough fields (title, icons, annotations, etc.). */
	[key: string]: unknown
}

/**
 * The context the `McpClient` supplies to the deferred-tool helpers. This
 * is a narrow interface so the deferred module does not import the full
 * `McpClient` (which would create a circular dependency — `McpClient`
 * imports this module to wire the deferred path).
 */
export interface DeferredContext {
	/** The bhzai-local server name (used for the `mcp__<server>__` prefix). */
	readonly serverName: string
	/** Register a tool into the shared `ToolRegistry`. */
	registerTool: (tool: BHZAIToolDefinition) => void
}

/**
 * The result of a synthetic `list_tools` or `search_tools` call. Returned
 * to the model as the `CallToolResult.content` text.
 */
export interface DeferredToolListResult {
	/** The tool names + descriptions matching the call. */
	tools: Array<{ name: string; description?: string }>
}

/**
 * Register the two synthetic deferred tools (`mcp__<server>__list_tools`
 * and `mcp__<server>__search_tools`) into the shared `ToolRegistry`.
 *
 * Called by `McpClient.connect()` when `deferred: true` is set, INSTEAD of
 * `discoverTools()`. The full discovery result is cached externally (on
 * the `McpClient` instance) and passed to {@link eagerRegister} when the
 * synthetic tools are invoked.
 *
 * The synthetic tools' `execute` bindings call back into the supplied
 * `onInvoke` callback, which the `McpClient` wires to its
 * `eagerRegisterAndAnswer` method.
 *
 * @param ctx      The deferred context (server name + registry).
 * @param onInvoke The callback invoked when either synthetic tool is
 *                 called. Receives the tool name (`list_tools` or
 *                 `search_tools`) and the invocation params (which for
 *                 `search_tools` carries a `query` keyword). Returns the
 *                 `CallToolResult` to surface to the model.
 */
export function registerDeferredTools(
	ctx: DeferredContext,
	onInvoke: (
		tool: "list_tools" | "search_tools",
		params: unknown,
	) => Promise<{ content: Array<{ type: "text"; text: string }> }>,
): void {
	const listToolsName = `mcp__${ctx.serverName}__list_tools`
	const searchToolsName = `mcp__${ctx.serverName}__search_tools`
	const listTool: BHZAIToolDefinition = {
		name: listToolsName,
		description: `List all tools available on the '${ctx.serverName}' MCP server. Returns tool names and descriptions. Call this first to discover what tools exist, then call mcp__<server>__search_tools with a keyword to narrow down, or call any discovered tool directly.`,
		inputSchema: { type: "object", properties: {} },
		execute: async (invocation) => {
			const result = await onInvoke("list_tools", invocation.params)
			return result
		},
	}
	const searchTool: BHZAIToolDefinition = {
		name: searchToolsName,
		description: `Search tools on the '${ctx.serverName}' MCP server by keyword. Returns tool names and descriptions whose name or description matches the query. Discovered tools are registered live for the rest of the conversation.`,
		inputSchema: {
			type: "object",
			properties: {
				query: {
					type: "string",
					description: "Keyword to search for in tool names and descriptions.",
				},
			},
			required: ["query"],
		},
		execute: async (invocation) => {
			const result = await onInvoke("search_tools", invocation.params)
			return result
		},
	}
	ctx.registerTool(listTool)
	ctx.registerTool(searchTool)
}

/**
 * Eagerly register every cached tool into the shared `ToolRegistry`, then
 * build the `CallToolResult` for the synthetic `list_tools` or
 * `search_tools` call.
 *
 * Behavior:
 *  - For `list_tools`: register every cached tool (via `ctx.registerTool`),
 *    then return the full list of `{ name, description }` entries.
 *  - For `search_tools`: register every cached tool (the spec says
 *    "discovered tools are then registered live for the rest of the
 *    conversation" — so even a search registers all matches, not just
 *    the filtered subset), then return the FILTERED list of
 *    `{ name, description }` entries whose name or description matches
 *    the `query` keyword (case-insensitive substring match).
 *
 * DESIGN DECISION (eager registration on first call): the spec says
 * "discovered tools are then registered live for the rest of the
 * conversation." This task interprets "discovered" as "the full cached
 * `tools/list` result is registered on the FIRST synthetic-tool call,"
 * rather than "only the matching tools are registered on each search."
 * Rationale: once the model has invoked a discovery tool, it has signaled
 * intent to use the server's tools, and registering them all eagerly
 * avoids repeated registration churn on subsequent searches. The
 * `search_tools` result is still filtered by keyword so the model sees a
 * focused list, but the registry contains everything.
 *
 * @param cachedTools  The full cached `tools/list` discovery result.
 * @param ctx          The deferred context (server name + registry).
 * @param tool         Which synthetic tool was called.
 * @param params       The invocation params (for `search_tools`, carries
 *                     `query`).
 * @returns The `CallToolResult` content to surface to the model.
 */
export async function eagerRegisterAndAnswer(
	cachedTools: DeferredMcpTool[],
	ctx: DeferredContext,
	tool: "list_tools" | "search_tools",
	params: unknown,
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
	// Eagerly register every cached tool (namespaced as
	// `mcp__<server>__<tool>`). The registry's shadowing semantics mean
	// re-registering an already-registered tool is a safe no-op replace.
	for (const mcpTool of cachedTools) {
		const namespacedName = `mcp__${ctx.serverName}__${mcpTool.name}`
		const def: BHZAIToolDefinition = {
			name: namespacedName,
			description: mcpTool.description ?? "",
			inputSchema: mcpTool.inputSchema ?? { type: "object" },
			...(mcpTool.outputSchema ? { outputSchema: mcpTool.outputSchema } : {}),
			// The execute binding is NOT set here — the real McpClient wires
			// the execute binding when it registers tools via its private
			// `registerTool` method. This module's `ctx.registerTool` is
			// expected to delegate to that private method (the McpClient
			// passes a bound `registerTool` that includes the execute
			// binding logic). See the wiring in `client.ts`.
			execute: async () => ({ content: [] }),
		}
		ctx.registerTool(def)
	}
	// Build the answer payload.
	let tools: Array<{ name: string; description?: string }>
	if (tool === "search_tools") {
		const query =
			typeof (params as { query?: unknown })?.query === "string"
				? (params as { query: string }).query.toLowerCase()
				: ""
		tools = cachedTools
			.filter((t) => {
				const name = t.name.toLowerCase()
				const desc = (t.description ?? "").toLowerCase()
				return name.includes(query) || desc.includes(query)
			})
			.map((t) => ({ name: t.name, description: t.description }))
	} else {
		tools = cachedTools.map((t) => ({ name: t.name, description: t.description }))
	}
	const payload: DeferredToolListResult = { tools }
	return {
		content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
	}
}
