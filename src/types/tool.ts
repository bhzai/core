// Tool-definition and tool-invocation type declarations (§ 9.1).
// Types only — no runtime logic.
//
// CROSS-TASK COORDINATION NOTE: TASK_0002's scope originally covered every
// shared type under src/types/, but the tool-specific shapes
// (`BHZAIToolDefinition`, `ToolInvocation`, `ToolExecute`, `ToolFilter`,
// `Icon`, `ToolAnnotations`) were not landed in that task's barrel before
// TASK_0008 started. Per TASK_0008's dependency instructions ("if any of
// these types are missing from the TASK_0002 barrel when this task starts,
// add minimal local type stubs and flag the gap back to TASK_0002's owner
// rather than silently duplicating the type definitions"), TASK_0008 adds
// them here — in the canonical types home, not as duplicated stubs — and
// flags the gap so TASK_0002's owner can reconcile. The shapes match
// ARCHITECTURE.md § 9.1 verbatim; TASK_0002 may move/refine them but must
// preserve these field names and optionality for MCP wire-compatibility
// (§ 9.1: a BHZAI tool definition *is* an MCP `Tool` object plus a local
// `execute` binding).

import type { BHZAIConversation as BHZAIConversationReal } from "../conversation/conversation.js"
import type { CallToolResult, ContentBlock, JSONSchema } from "./content.js"

/**
 * Icon record for tool display (§ 9.1 `icons?: Icon[]`).
 *
 * Explicit assumption: ARCHITECTURE.md names `Icon` only via the inline
 * comment `{ src, mimeType?, sizes? }` (line 602). Field types follow that
 * comment — `src` is a URI/string, `mimeType` and `sizes` are optional. `sizes`
 * is typed loosely (`string[]`) since the spec does not constrain its element
 * shape; a future MCP-conformance task may refine it.
 */
export interface Icon {
	src: string
	mimeType?: string
	sizes?: string[]
}

/**
 * MCP `ToolAnnotations` hints (§ 9.1 `annotations?: ToolAnnotations`).
 *
 * Per § 9.1's notes, `annotations` are **untrusted hints**: BHZAI surfaces them
 * to hosts (e.g. for confirmation UIs) but never lets them drive availability
 * or auto-approval unless the host marks the source trusted (§ 13). All fields
 * are optional booleans matching the spec's named hints.
 */
export interface ToolAnnotations {
	readOnlyHint?: boolean
	destructiveHint?: boolean
	idempotentHint?: boolean
	openWorldHint?: boolean
}

/**
 * The real `BHZAIConversation` interface (TASK_0023, ARCHITECTURE.md § 11.1).
 *
 * Represents a single conversation instance — the primary object hosts and
 * plugins interact with. The interface defines conversation lifecycle, event
 * handling, and metadata management.
 */
export type BHZAIConversation = BHZAIConversationReal

/**
 * The payload handed to a tool's `execute()` (§ 9.1).
 *
 * `params` is typed as the tool's generic parameter `P` (defaulting to
 * `unknown`); the agent loop (TASK_0026) validates `params` against the tool's
 * `inputSchema` before `execute` runs. `progress` mirrors MCP progress
 * notifications; `signal` aborts with the turn and is proxied as
 * `notifications/cancelled` for remote MCP tools (TASK_0011).
 */
export interface ToolInvocation<P = unknown> {
	conversation: BHZAIConversation | undefined
	params: P
	toolCallId: string
	signal: AbortSignal
	progress(update: string | ContentBlock[]): void
}

/**
 * The executor signature stored on a `BHZAIToolDefinition` (§ 9.1).
 *
 * Returns a `CallToolResult`, a bare string (wrapped by `normalizeToolResult`
 * into `{ content: [{ type: 'text', text }] }`), or `void` (normalized to
 * `{ content: [] }`). The agent-loop pipeline (TASK_0026) is responsible for
 * invoking this, validating arguments, and catching executor errors; the
 * registry built in TASK_0008 only stores it.
 */
export type ToolExecute<P = unknown> = (
	invocation: ToolInvocation<P>,
	// biome-ignore lint/suspicious/noConfusingVoidType: § 9.1 specifies the execute() return union as `CallToolResult | string | void`; `void` is the spec's wording for "returned nothing", preserved verbatim for wire-compat documentation even though biome prefers `undefined`.
) => Promise<CallToolResult | string | void> | CallToolResult | string | void

/**
 * A BHZAI tool definition *is* an MCP `Tool` object (spec rev 2025-11-25) plus a
 * local `execute` binding (§ 9.1). Field names and optionality match the spec
 * verbatim for MCP wire-compatibility — do not rename or reorder optionality.
 *
 * The generic `P` parameterizes `execute`'s `ToolInvocation<P>` so a plugin can
 * narrow the validated-params type; the registry stores definitions under the
 * erased `BHZAIToolDefinition<unknown>` shape since the registry is agnostic to
 * a tool's param type.
 */
export interface BHZAIToolDefinition<P = unknown> {
	// ——— MCP `Tool` fields, wire-compatible (spec rev 2025-11-25) ———
	/** 1–128 chars, `[a-zA-Z0-9_.-]`; later registration shadows earlier. */
	name: string
	/** Optional human-readable display name. */
	title?: string
	/** Shown to the model. Required on the stored shape for MCP wire-compat. */
	description: string
	/** JSON Schema (2020-12) for the arguments. */
	inputSchema: JSONSchema
	/** When declared, results carry validated `structuredContent`. */
	outputSchema?: JSONSchema
	/** Optional display icons. */
	icons?: Icon[]
	/** Untrusted hints (readOnlyHint / destructiveHint / etc.). */
	annotations?: ToolAnnotations
	// ——— bhzai-local fields (never serialized onto the wire) ———
	/** Local executor. Invoked by the agent loop (TASK_0026), not the registry. */
	execute: ToolExecute<P>
	/** Host-defined grouping for the availability seam (§ 9.5). */
	tags?: string[]
	/** Exclude this tool from concurrent batches (§ 11.2). */
	serial?: boolean
}

/**
 * Filter argument accepted by `bh.listTools(filter?)` (§ 6, § 9.5).
 *
 * SCOPE NOTE: the *filtering semantics* (allow-list, deny-list, tag filters,
 * driver-capability gating, and the § 9.5 3-step resolution order) are owned by
 * TASK_0017's `resolveAvailableTools`. TASK_0008's `listTools` accepts this
 * parameter for signature compatibility with § 6's kernel API and implements
 * only the identity case plus a trivial name allow/deny list; full semantics
 * are deferred. This type is declared here (not in TASK_0017) so the kernel
 * signature is stable from TASK_0008 onward.
 *
 * Explicit assumption: the spec does not pin `ToolFilter`'s shape. The fields
 * below follow the § 9.5 prose (allow/deny by name, tag inclusion/exclusion).
 * TASK_0017 may refine this interface; any change here must keep the
 * already-shipped `listTools` signature compatible.
 */
export interface ToolFilter {
	/** Allow-list of tool names. If present, only these names are returned. */
	allow?: string[]
	/** Deny-list of tool names. If present, these names are excluded. */
	deny?: string[]
	/** Include only tools tagged with at least one of these tags. */
	tags?: string[]
	/** Exclude tools tagged with any of these tags. */
	excludeTags?: string[]
}
