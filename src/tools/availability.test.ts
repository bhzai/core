// TASK_0017 — tool availability filtering seam tests (§ 9.5).
//
// These tests exercise the pure 3-step decision function:
//  1. Static `ToolFilter` (allow/deny, tags include/exclude).
//  2. `contextPatchedTools` (replaces, not merges).
//  3. Driver-capability gating (toolCalls: false → empty array).
// Plus the trust-flag derivation from MCP server names.

import { describe, expect, it } from "vitest"

import type { BHZAIToolDefinition, DriverCapabilities } from "../types/index.js"
import {
	type ResolveAvailableToolsOptions,
	applyToolFilter,
	isToolTrusted,
	resolveAvailableTools,
} from "./availability.js"

// ---------------------------------------------------------------------------
// Test fixtures.
// ---------------------------------------------------------------------------

function tool(name: string, tags?: string[]): BHZAIToolDefinition {
	return {
		name,
		description: `desc-${name}`,
		inputSchema: { type: "object" },
		execute: async () => ({ content: [] }),
		...(tags ? { tags } : {}),
	}
}

const TOOLS: BHZAIToolDefinition[] = [
	tool("local1", ["a", "b"]),
	tool("local2", ["b", "c"]),
	tool("local3"), // no tags
	tool("mcp__srv__t1", ["a"]),
	tool("mcp__srv__t2", ["c"]),
	tool("mcp__other__t3", ["a", "b"]),
]

const CAPS_WITH_TOOLS: DriverCapabilities = {
	streaming: true,
	toolCalls: true,
	reasoning: false,
}
const CAPS_NO_TOOLS: DriverCapabilities = {
	streaming: true,
	toolCalls: false,
	reasoning: false,
}

// ---------------------------------------------------------------------------
// applyToolFilter — step 1.
// ---------------------------------------------------------------------------

describe("applyToolFilter", () => {
	it("returns all tools when filter is undefined", () => {
		expect(applyToolFilter(TOOLS, undefined)).toHaveLength(6)
	})

	it("allow-list filters to only the named tools", () => {
		const result = applyToolFilter(TOOLS, { allow: ["local1", "local3"] })
		expect(result.map((t) => t.name)).toEqual(["local1", "local3"])
	})

	it("deny-list excludes the named tools", () => {
		const result = applyToolFilter(TOOLS, { deny: ["local1", "mcp__srv__t1"] })
		expect(result.map((t) => t.name)).toEqual([
			"local2",
			"local3",
			"mcp__srv__t2",
			"mcp__other__t3",
		])
	})

	it("deny wins over allow when a tool is in both", () => {
		const result = applyToolFilter(TOOLS, { allow: ["local1", "local2"], deny: ["local1"] })
		expect(result.map((t) => t.name)).toEqual(["local2"])
	})

	it("tags include filters to tools with at least one matching tag", () => {
		const result = applyToolFilter(TOOLS, { tags: ["a"] })
		expect(result.map((t) => t.name)).toEqual(["local1", "mcp__srv__t1", "mcp__other__t3"])
	})

	it("tags include excludes tools with no tags field", () => {
		const result = applyToolFilter(TOOLS, { tags: ["a"] })
		expect(result.map((t) => t.name)).not.toContain("local3")
	})

	it("excludeTags excludes tools with any matching tag", () => {
		const result = applyToolFilter(TOOLS, { excludeTags: ["b"] })
		expect(result.map((t) => t.name)).toEqual(["local3", "mcp__srv__t1", "mcp__srv__t2"])
	})

	it("tags + excludeTags combine (include a, exclude b)", () => {
		const result = applyToolFilter(TOOLS, { tags: ["a"], excludeTags: ["b"] })
		expect(result.map((t) => t.name)).toEqual(["mcp__srv__t1"])
	})

	it("allow + tags combine", () => {
		const result = applyToolFilter(TOOLS, { allow: ["local1", "local2", "local3"], tags: ["b"] })
		expect(result.map((t) => t.name)).toEqual(["local1", "local2"])
	})

	it("does not mutate the input array", () => {
		const input = [tool("a"), tool("b")]
		const snapshot = [...input]
		applyToolFilter(input, { allow: ["a"] })
		expect(input).toEqual(snapshot)
	})
})

// ---------------------------------------------------------------------------
// resolveAvailableTools — 3-step resolution order.
// ---------------------------------------------------------------------------

describe("resolveAvailableTools — 3-step resolution", () => {
	it("step 1 only: no filter, no context patch, toolCalls: true → all tools", () => {
		const result = resolveAvailableTools(TOOLS, undefined, undefined, CAPS_WITH_TOOLS)
		expect(result).toHaveLength(6)
		expect(result.every((r) => r.trusted === false || r.trusted === true)).toBe(true)
	})

	it("step 1: filter applies", () => {
		const result = resolveAvailableTools(TOOLS, { allow: ["local1"] }, undefined, CAPS_WITH_TOOLS)
		expect(result.map((r) => r.tool.name)).toEqual(["local1"])
	})

	it("step 2: contextPatchedTools REPLACES step 1 output (not a merge)", () => {
		// Step 1 would keep local1, but step 2 replaces with a completely
		// different set.
		const patched = [tool("patched1"), tool("patched2")]
		const result = resolveAvailableTools(TOOLS, { allow: ["local1"] }, patched, CAPS_WITH_TOOLS)
		expect(result.map((r) => r.tool.name)).toEqual(["patched1", "patched2"])
	})

	it("step 2: contextPatchedTools = [] replaces with an empty set", () => {
		const result = resolveAvailableTools(TOOLS, undefined, [], CAPS_WITH_TOOLS)
		expect(result).toEqual([])
	})

	it("step 2: contextPatchedTools = undefined passes step 1 through", () => {
		const result = resolveAvailableTools(TOOLS, { allow: ["local1"] }, undefined, CAPS_WITH_TOOLS)
		expect(result.map((r) => r.tool.name)).toEqual(["local1"])
	})

	it("step 3: toolCalls: false → empty array (regardless of prior steps)", () => {
		const result = resolveAvailableTools(TOOLS, undefined, undefined, CAPS_NO_TOOLS)
		expect(result).toEqual([])
	})

	it("step 3: toolCalls: false → empty even with contextPatchedTools", () => {
		const patched = [tool("patched1")]
		const result = resolveAvailableTools(TOOLS, undefined, patched, CAPS_NO_TOOLS)
		expect(result).toEqual([])
	})

	it("all 3 steps: filter → patch → toolCalls: true", () => {
		const patched = [tool("p1", ["x"]), tool("p2", ["y"])]
		const result = resolveAvailableTools(TOOLS, { allow: ["local1"] }, patched, CAPS_WITH_TOOLS)
		expect(result.map((r) => r.tool.name)).toEqual(["p1", "p2"])
	})
})

// ---------------------------------------------------------------------------
// Trust flag derivation.
// ---------------------------------------------------------------------------

describe("resolveAvailableTools — trust flags", () => {
	it("local tools are always trusted", () => {
		const opts: ResolveAvailableToolsOptions = { trustedSources: new Set() }
		const result = resolveAvailableTools(
			[tool("local1"), tool("local2")],
			undefined,
			undefined,
			CAPS_WITH_TOOLS,
			opts,
		)
		expect(result.every((r) => r.trusted)).toBe(true)
	})

	it("mcp tools are untrusted when trustedSources is undefined", () => {
		const result = resolveAvailableTools(
			[tool("mcp__srv__t1")],
			undefined,
			undefined,
			CAPS_WITH_TOOLS,
		)
		expect(result[0]?.trusted).toBe(false)
	})

	it("mcp tools are untrusted when their server is not in trustedSources", () => {
		const opts: ResolveAvailableToolsOptions = { trustedSources: new Set(["other"]) }
		const result = resolveAvailableTools(
			[tool("mcp__srv__t1")],
			undefined,
			undefined,
			CAPS_WITH_TOOLS,
			opts,
		)
		expect(result[0]?.trusted).toBe(false)
	})

	it("mcp tools are trusted when their server is in trustedSources", () => {
		const opts: ResolveAvailableToolsOptions = { trustedSources: new Set(["srv"]) }
		const result = resolveAvailableTools(
			[tool("mcp__srv__t1")],
			undefined,
			undefined,
			CAPS_WITH_TOOLS,
			opts,
		)
		expect(result[0]?.trusted).toBe(true)
	})

	it("mixed local + mcp tools get correct per-tool trust flags", () => {
		const opts: ResolveAvailableToolsOptions = { trustedSources: new Set(["srv"]) }
		const result = resolveAvailableTools(
			[tool("local1"), tool("mcp__srv__t1"), tool("mcp__other__t2")],
			undefined,
			undefined,
			CAPS_WITH_TOOLS,
			opts,
		)
		expect(result.map((r) => r.trusted)).toEqual([true, true, false])
	})
})

// ---------------------------------------------------------------------------
// isToolTrusted — unit tests.
// ---------------------------------------------------------------------------

describe("isToolTrusted", () => {
	it("returns true for local (non-mcp__) tool names", () => {
		expect(isToolTrusted("local1", undefined)).toBe(true)
		expect(isToolTrusted("local1", new Set())).toBe(true)
	})

	it("returns false for mcp__ tools when trustedSources is undefined", () => {
		expect(isToolTrusted("mcp__srv__t1", undefined)).toBe(false)
	})

	it("returns false for mcp__ tools when server is not in trustedSources", () => {
		expect(isToolTrusted("mcp__srv__t1", new Set(["other"]))).toBe(false)
	})

	it("returns true for mcp__ tools when server is in trustedSources", () => {
		expect(isToolTrusted("mcp__srv__t1", new Set(["srv"]))).toBe(true)
	})

	it("handles server names with dots (URL-derived names)", () => {
		expect(isToolTrusted("mcp__example.com__t1", new Set(["example.com"]))).toBe(true)
	})

	it("does not match names without the mcp__ prefix", () => {
		expect(isToolTrusted("mcp_srv_t1", new Set("srv"))).toBe(true) // single underscores — local
	})
})

// ---------------------------------------------------------------------------
// UNRESOLVED: prompt-injected tool fallback (§ 9.5 step 3 parenthetical).
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// § 13 Security: Tool annotations are untrusted hints, never drive availability/approval
// ---------------------------------------------------------------------------

describe("Security: Tool annotations never drive availability", () => {
	it("untrusted MCP tools with different annotations resolve to same trust flag", () => {
		// ARCHITECTURE.md § 13: "annotations are treated as untrusted hints"
		// § 9.1: "never let them drive availability or auto-approval decisions"
		// Two MCP tools from the same untrusted server, one with readOnlyHint: true,
		// one with readOnlyHint: false, should BOTH resolve to trusted: false
		// because the trust decision is based ONLY on the server name and
		// trustedSources, never on the annotations field.
		const toolWithAnnotation = {
			name: "mcp__untrusted__tool_annotated",
			description: "tool with hints",
			inputSchema: { type: "object" },
			annotations: { readOnlyHint: true, destructiveHint: false },
			execute: async () => ({ content: [] }),
		}
		const toolWithoutAnnotation = {
			name: "mcp__untrusted__tool_plain",
			description: "tool without hints",
			inputSchema: { type: "object" },
			execute: async () => ({ content: [] }),
		}

		// Both from untrusted server (not in trustedSources)
		const opts: ResolveAvailableToolsOptions = { trustedSources: new Set(["trusted-server"]) }
		const result = resolveAvailableTools(
			[toolWithAnnotation, toolWithoutAnnotation],
			undefined,
			undefined,
			CAPS_WITH_TOOLS,
			opts,
		)

		expect(result).toHaveLength(2)
		// Both should have trusted: false because server is not in trustedSources
		expect(result[0]?.trusted).toBe(false)
		expect(result[1]?.trusted).toBe(false)
		// Annotations should be preserved on the returned tools (surfaced for host UIs)
		expect(result[0]?.tool.annotations).toEqual({ readOnlyHint: true, destructiveHint: false })
		expect(result[1]?.tool.annotations).toBeUndefined()
	})
})

// ---------------------------------------------------------------------------
// UNRESOLVED: prompt-injected tool fallback (§ 9.5 step 3 parenthetical).
// ---------------------------------------------------------------------------

describe("UNRESOLVED — prompt-injected tool fallback", () => {
	it("toolCalls: false returns empty array (fallback NOT implemented)", () => {
		// This test documents the current behavior: when toolCalls: false,
		// resolveAvailableTools returns []. The § 9.5 spec says the kernel
		// "falls back to prompt-injected tool descriptions only if the host
		// opts in" — that fallback is NOT implemented in TASK_0017. A
		// future task (likely TASK_0026) will implement it.
		const result = resolveAvailableTools(TOOLS, undefined, undefined, CAPS_NO_TOOLS)
		expect(result).toEqual([])
	})
})
