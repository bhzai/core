# Open Questions and Resolutions

This document is an authoritative decision log for BHZAI's design. Every decision and deferral recorded here is binding on downstream implementation tasks — this is not merely a record of the architecture document's open items, but the definitive source for the choices that govern the build. Future tasks and maintainers should treat this document as the canonical reference for how ambiguous architectural choices were resolved, and any substantive disagreement with a recorded decision should be raised via a new issue or task, not silently re-decided within individual task implementations.

## Resolved (for traceability)

### R1. Decorator flavor — resolved 2026-07-04

**Decision**: TC39 stage-3 decorators only; deliberately no `experimentalDecorators` compatibility build.

The kernel standardizes on TypeScript ≥ 5.0 stage-3 decorators (`@Plugin`, `@On`, `@Tool`). A legacy-decorators build is explicitly **not** provided. Rationale: dual builds would double the test matrix, and the legacy semantics differ subtly in metadata handling and initializer order, making it impossible to guarantee consistent behavior across both variants. Hosts locked to legacy decorators (e.g., NestJS backends) use the factory or capability-object plugin forms instead, which are contract-equivalent to the decorator form (§ 7.1–7.2 of ARCHITECTURE.md).

### R2. Compaction summarizer ownership — resolved 2026-07-04

**Decision**: The kernel ships a default (out-of-the-box) compaction summarization prompt; the `compact(before)` event handler contract allows plugins to replace, prepend, append, or pre-supply the summary entirely.

This resolves the earlier open question of "who owns writing the summarization prompt." The kernel provides a sensible default OOB compaction prompt, but the `compact` event (three-state: `before`, `compacting`, `complete`) gives plugins full control over customization — handlers can `patch({ prompt })` to replace outright, `patch({ prependPrompt })` / `patch({ appendPrompt })` to adjust it, or `patch({ summary, keepFrom })` to bypass the LLM call and supply a pre-folded result entirely (ARCHITECTURE.md § 11.5).

## Open items — triaged 2026-07-20

### 1. Coarse vs. granular events

**Status**: Decided.

**Decision**: Keep the coarse `state`-discriminated event design as canonical for v0.1 (implemented in TASK_0004, TASK_0023–TASK_0031). The two high-traffic events (`message` and `tool`) remain single event names with `state` discriminators (`message` with states `before`/`waiting`/`sent`/`error`, `tool` with states `beforeCall`/`call`/`processing`/`complete`/`error`), with optional `event:state` suffix sugar available for consumers who prefer single-state subscriptions. This design is already implemented by earlier tasks; reversing it now would constitute a breaking kernel change. A future v0.2 revisit of granular event names is possible if real-world host code demonstrates ergonomic friction, but for v0.1, the coarse design is fixed. The design aligns with pi's own coarse-event convention, which BHZAI deliberately models itself on (ARCHITECTURE.md § 3).

### 2. Package name

**Status**: Decided.

**Decision**: Keep `@bhzai/core` as the package identity for v0.1. Every task file in the 44-task breakdown, `package.json`, and every subpath export (`@bhzai/core/webllm`, `@bhzai/core/mcp`, etc.) are built around this name; renaming now would be a breaking, cross-cutting change with no v0.1 benefit. The door is explicitly left open for a future org-scope rename (e.g., to `@bhzai/core` if the project moves to an organization) once the framework has matured past v0.1 — npm supports alias/renames without degrading existing installations, so a future migration is feasible when and if the project scope warrants it.

### 3. Prompt-injected tool fallback for non-tool-calling models

**Status**: Deferred past v0.1, with implementation strategy decided.

**Relationship to TASK_0017**: TASK_0017 (tool-availability filtering, `src/tools/availability.ts`) **did not implement** a prompt-injected tool fallback. When a driver reports `toolCalls: false`, TASK_0017 returns an empty tool array and explicitly flags the prompt-injection gap as "UNRESOLVED" (§ 9.5 step 3 parenthetical and lines 87–94 of the `availability.ts` source). TASK_0017's comment states: "This task does NOT implement that fallback — it returns an empty array and flags the gap. A future task (likely TASK_0026, the agent loop) will implement the prompt-injection path if the host opts in."

**Decision**: This feature is deferred past v0.1 *and the implementation strategy is decided*: when the fallback is built (likely in TASK_0026 or a successor), it **shall be an in-kernel, opt-in mechanism** embedded within the § 9.5 availability seam itself, not a separate optional plugin. This decision ratifies the architecture document's own phrasing ("the kernel falls back to prompt-injected tool descriptions only if the host opts in," which describes an in-kernel capability), and it keeps prompt injection available to every host without requiring an explicit `bh.use(...)` registration. The opt-in surface (e.g., a flag in `ConversationOptions` or a capability hook) will be defined when the feature is implemented, but the precedent is set: in-kernel and opt-in, not a plugin.

### 4. Where `bhzai/mcp` draws the auth line

**Status**: Deferred past v0.1.

**Decision**: Defer OAuth device-flow helpers and advanced authorization patterns past v0.1. The kernel's § 10.4 credential-resolution chain (runtime values → `auth` capability hooks → unauthenticated fallback) and § 9.3's header-based authentication already cover v0.1's real-world needs: local Ollama and WebLLM require no credentials, and MCP servers reachable via static API key or bearer token are fully supported through the existing chain. OAuth flows (device code, authorization code, PKCE) add significant surface area (token refresh semantics, secure storage, redirect/device-code UX that varies per host) — these belong in v0.2 or later. The decision is firmly: v0.1 ships headers-only auth; OAuth helpers are an open item for v0.2 or v1, not a gap in v0.1's scope.
