// Tool availability filtering seam — the pure 3-step decision function that
// decides which tools a given LLM call advertises (ARCHITECTURE.md § 9.5).
//
// Scope of THIS file (TASK_0017):
//  - `resolveAvailableTools(allTools, filter, contextPatchedTools?,
//    driverCapabilities, options?)` — the pure, side-effect-free function
//    that applies the § 9.5 resolution order:
//      1. Static `ToolFilter` (allow/deny lists, tag include/exclude).
//      2. `contextPatchedTools` (the `context` event's patch result —
//         replaces the previous step's output wholesale, not a merge).
//      3. Driver-capability gating (a driver that reports `toolCalls:
//         false` gets an empty array; otherwise all tools pass).
//  - Explicitly flag the "Prompt-injected tool fallback" (§ 9.5 step 3
//    parenthetical) as UNRESOLVED — this task does NOT implement it.
//
// ENVIRONMENT BOUNDARY (§ 5): web-standard APIs only. This file is pure
// TypeScript — no `fetch`, no `crypto`, no Node built-ins. It is
// runtime-agnostic and side-effect-free.

import type { BHZAIToolDefinition, DriverCapabilities, ToolFilter } from "../types/index.js"

/**
 * Options for {@link resolveAvailableTools}.
 *
 * DESIGN NOTE: `trustedSources` is THIS TASK'S OWN INVENTION — the
 * architecture doc's § 9.5 prose does not name the opt-in surface for
 * trusting MCP server-supplied tool annotations. The closest precedent
 * is TASK_0013's `trusted` flag on `McpServerConfig`, which this task
 * consumes here: a tool whose name matches the `mcp__<server>__<tool>`
 * pattern is considered to come from a trusted source IFF the server
 * name appears in `trustedSources`. Untrusted tools' `annotations`
 * (e.g. `destructiveHint`) are surfaced to hosts but never drive the
 * availability algorithm — per § 13's "tool results are always untrusted
 * data" and § 9.1's "annotations are untrusted hints."
 */
export interface ResolveAvailableToolsOptions {
	/**
	 * Set of trusted MCP server names (from `McpServerConfig.trusted`).
	 * Tools whose namespaced name `mcp__<server>__<tool>` has `<server>`
	 * in this set are considered trusted; all others are untrusted.
	 *
	 * INERT IN THIS TASK: this field is consumed only to populate the
	 * `trusted` flag on the returned {@link ResolvedTool} records, which
	 * a host can inspect for confirmation UIs. The availability algorithm
	 * itself does NOT drop untrusted tools — that would be a host policy
	 * decision, not a kernel one. This matches § 13's "the tool executor
	 * is the actual security boundary, not the kernel."
	 */
	trustedSources?: Set<string>
}

/**
 * A tool definition plus its resolved trust flag, returned by
 * {@link resolveAvailableTools}. The `trusted` flag is derived from
 * {@link ResolveAvailableToolsOptions.trustedSources} and the tool's
 * namespaced name; it is INERT in the availability algorithm (see the
 * option's doc) but surfaced for host-side policy/confirmation UIs.
 */
export interface ResolvedTool {
	/** The tool definition. */
	tool: BHZAIToolDefinition
	/**
	 * Whether this tool comes from a trusted MCP source. `true` for local
	 * (non-`mcp__`) tools and for `mcp__<server>__<tool>` tools whose
	 * `<server>` is in `trustedSources`; `false` otherwise.
	 */
	trusted: boolean
}

/**
 * The pure 3-step tool-availability decision function (§ 9.5).
 *
 * Resolution order (per § 9.5):
 *  1. **Static `ToolFilter`** — apply the conversation's `allow`/`deny`
 *     name lists and `tags`/`excludeTags` tag filters to `allTools`.
 *  2. **`contextPatchedTools`** — if supplied (the `context` event's
 *     patch result), REPLACE the previous step's output wholesale with
 *     this array. This is NOT a merge — the `context` event may drop or
 *     add tool definitions, and its result is authoritative for the
 *     tool SET. If `undefined`, the previous step's output passes
 *     through unchanged.
 *  3. **Driver-capability gating** — if `driverCapabilities.toolCalls`
 *     is `false`, return an empty array (the driver cannot make tool
 *     calls, so no tools are advertised). Otherwise, all tools from
 *     step 2 pass.
 *
 * UNRESOLVED — "Prompt-injected tool fallback" (§ 9.5 step 3
 * parenthetical): when a driver reports `toolCalls: false`, the spec
 * says "the kernel falls back to prompt-injected tool descriptions only
 * if the host opts in." This task does NOT implement that fallback —
 * it returns an empty array and flags the gap. A future task (likely
 * TASK_0026, the agent loop) will implement the prompt-injection path
 * if the host opts in. This is documented explicitly rather than
 * silently half-implemented.
 *
 * @param allTools              Every registered tool (from `bh.listTools()`).
 * @param filter                The conversation's static `ToolFilter`.
 * @param contextPatchedTools   The `context` event's patch result, if any.
 * @param driverCapabilities    The selected driver/model's capabilities.
 * @param options               Optional trust-source set for the
 *                              `ResolvedTool.trusted` flag.
 * @returns The resolved (filtered, patched, gated) tool list with trust flags.
 */
export function resolveAvailableTools(
	allTools: BHZAIToolDefinition[],
	filter: ToolFilter | undefined,
	contextPatchedTools: BHZAIToolDefinition[] | undefined,
	driverCapabilities: DriverCapabilities,
	options?: ResolveAvailableToolsOptions,
): ResolvedTool[] {
	// Step 1: static ToolFilter.
	const step1 = applyToolFilter(allTools, filter)
	// Step 2: context event patch (replaces, not merges).
	const step2 = contextPatchedTools !== undefined ? contextPatchedTools : step1
	// Step 3: driver-capability gating.
	if (!driverCapabilities.toolCalls) {
		// UNRESOLVED: prompt-injected tool fallback (§ 9.5 step 3
		// parenthetical). This task returns an empty array and flags the
		// gap; a future task (likely TASK_0026) will implement the
		// prompt-injection path if the host opts in.
		return []
	}
	// Attach trust flags and return.
	const trustedSources = options?.trustedSources
	return step2.map((tool) => ({
		tool,
		trusted: isToolTrusted(tool.name, trustedSources),
	}))
}

/**
 * Apply a {@link ToolFilter} to a tool list (§ 9.5 step 1).
 *
 * Filter semantics (explicit assumption — the spec does not pin the
 * exact precedence):
 *  - `allow`: if present, only tools whose `name` is in `allow` pass.
 *    If absent, all tools pass this sub-check.
 *  - `deny`: if present, tools whose `name` is in `deny` are excluded.
 *    Applied AFTER `allow` (so a tool in both `allow` and `deny` is
 *    denied — deny wins).
 *  - `tags`: if present, only tools with at least one tag in `tags`
 *    pass. A tool with no `tags` field does NOT pass this sub-check
 *    (it has no matching tags).
 *  - `excludeTags`: if present, tools with any tag in `excludeTags`
 *    are excluded. Applied AFTER `tags`.
 *
 * The filter is pure and side-effect-free; it does not mutate the input.
 */
export function applyToolFilter(
	tools: BHZAIToolDefinition[],
	filter: ToolFilter | undefined,
): BHZAIToolDefinition[] {
	if (!filter) return [...tools]
	const allowSet = filter.allow ? new Set(filter.allow) : undefined
	const denySet = filter.deny ? new Set(filter.deny) : undefined
	const tagsSet = filter.tags ? new Set(filter.tags) : undefined
	const excludeTagsSet = filter.excludeTags ? new Set(filter.excludeTags) : undefined
	return tools.filter((tool) => {
		// allow-list
		if (allowSet && !allowSet.has(tool.name)) return false
		// deny-list (wins over allow)
		if (denySet?.has(tool.name)) return false
		// tags include
		if (tagsSet) {
			const toolTags = tool.tags ?? []
			const hasMatch = toolTags.some((t) => tagsSet.has(t))
			if (!hasMatch) return false
		}
		// tags exclude
		if (excludeTagsSet) {
			const toolTags = tool.tags ?? []
			const hasExcluded = toolTags.some((t) => excludeTagsSet.has(t))
			if (hasExcluded) return false
		}
		return true
	})
}

/**
 * Determine whether a tool is trusted based on its namespaced name and
 * the set of trusted MCP server names (TASK_0013's `trusted` flag
 * consumption, TASK_0017).
 *
 * - Local tools (names NOT matching `mcp__<server>__<tool>`) are
 *   always trusted — they come from the host's own plugins, not from
 *   remote MCP servers.
 * - `mcp__<server>__<tool>` tools are trusted IFF `<server>` is in
 *   `trustedSources`. If `trustedSources` is undefined, all MCP tools
 *   are untrusted (matching TASK_0013's "untrusted by default" rule).
 */
export function isToolTrusted(toolName: string, trustedSources: Set<string> | undefined): boolean {
	const mcpMatch = matchMcpNamespacedName(toolName)
	if (!mcpMatch) {
		// Local tool — always trusted.
		return true
	}
	const [, serverName] = mcpMatch
	if (!trustedSources) return false
	return trustedSources.has(serverName)
}

/**
 * Match a tool name against the `mcp__<server>__<tool>` pattern.
 * Returns `[fullMatch, serverName]` or `null` if the name is not an
 * MCP-namespaced tool. The server name is the segment between the first
 * and second `__` delimiters.
 */
function matchMcpNamespacedName(toolName: string): [string, string] | null {
	// Pattern: mcp__<server>__<tool> where <server> and <tool> are
	// non-empty. The server name may contain characters valid in bhzai-
	// local names (per TASK_0011's deriveServerName, which derives from
	// URL hostname or a host-supplied name).
	const match = /^mcp__(.+?)__(.+)$/.exec(toolName)
	if (!match) return null
	return [match[0], match[1]]
}
