// Cross-cutting content-block and tool-result type declarations (§ 9.1).
// Types only — no runtime logic. See TASK_0002 for the scope contract.

/**
 * Loose JSON Schema (2020-12 dialect) alias.
 *
 * Deliberate scope decision (not an oversight): a fully-typed JSON Schema AST is
 * out of scope for BHZAI's MVP and would be its own significant undertaking. We
 * model it as `Record<string, unknown>` and let downstream code that needs to
 * inspect specific keywords (e.g. TASK_0006's `default` keyword lookup) narrow
 * locally. The "wire-compatible" note in § 9.1 refers to the dialect, not to a
 * structural TypeScript model of the schema grammar.
 */
export type JSONSchema = Record<string, unknown>

/**
 * Discriminated union of MCP content-block variants (§ 9.1 inline list:
 * `text | image | audio | resource_link | resource`).
 *
 * Explicit assumption: ARCHITECTURE.md names these five variants but defers to
 * the MCP spec for exact wire shapes. Field modeling follows MCP `ContentBlock`
 * conventions — `text` carries `text`; `image`/`audio` carry base64 `data` +
 * `mimeType`; `resource_link` references a URI; `resource` embeds a resource
 * record. If a future MCP-conformance task (§ 9.3, not part of this batch)
 * finds a field mismatch, it should refine THIS union rather than defining a
 * second parallel one.
 */
export type ContentBlock =
	| { type: "text"; text: string }
	| { type: "image"; data: string; mimeType: string }
	| { type: "audio"; data: string; mimeType: string }
	| { type: "resource_link"; uri: string; name?: string; mimeType?: string }
	| {
			type: "resource"
			resource: { uri: string; mimeType?: string; text?: string; blob?: string }
	  }

/**
 * MCP `CallToolResult`, wire-compatible (spec rev 2025-11-25, § 9.1).
 * `structuredContent` is validated against `outputSchema` when one is declared
 * on the tool definition (TASK_0008's responsibility).
 */
export interface CallToolResult {
	content: ContentBlock[]
	structuredContent?: Record<string, unknown>
	isError?: boolean
	_meta?: Record<string, unknown>
}
