# `src/plugins/mcp/` — MCP streamable-HTTP client plugin

## Purpose & scope

The built-in MCP (Model Context Protocol) client — streamable-HTTP transport only, spec rev 2025-11-25 (ARCHITECTURE.md § 9.3). Handles handshake, paginated tool discovery, live re-sync, progress/cancellation, and deferred loading via a `search_tools` convention for large tool sets (§ 9.4). Discovered remote tools are registered into `src/tools/registry.ts` with the `mcp__<server>__<tool>` name prefix, so the agent loop (TASK_0026) treats them identically to local plugin tools.

## Key files

- `index.ts` — subpath entry. Re-exports `McpClient`, `McpHandshakeError`, `McpCallError`, `McpTimeoutError`, `McpClientOptions`, and `ToolListDiff` from `client.ts`; the approval, capability, and deferred surfaces; plus `mcpPlugin`/`createMcpPlugin`/`getMcpManager` from `plugin.ts` and `McpManager` + its state types from `manager.ts`.
- `plugin.ts` — the capability object that fills the kernel's `registerMcpClientFactory` seam. Without it `bh.addMcp()` refuses to attach anything (its error message names `mcpPlugin` directly). Two forms: `mcpPlugin` (zero-config, safe on several kernels, manager via `getMcpManager(bh)`) and `createMcpPlugin(options)` (returns `{ plugin, manager }`; supports `servers`, `clientOptions`, and a custom `name`). Registration happens in `initialize` — form-2 capability objects have no `setup` key — which `bh.init()` runs before it resolves `getMcps` hooks, so the factory is in place for both declarative and imperative attaches.
- `plugin.test.ts` — the seam end to end against a REAL `BHZAI` with a stubbed `fetch`: the pre-registration refusal, tool registration after attach, per-kernel manager isolation, declarative `servers`, `clientOptions` forwarding and per-attach override, and detach through the kernel.
- `manager.ts` — `McpManager`: observable lifecycle over `bh.addMcp()` (`connecting`/`connected`/`error`/`detached`, discovered tools, structured `McpServerError`, `subscribe()`), plus `add`/`retry`/`refresh`/`remove`. Takes a narrow `McpManagerHost` rather than a `BHZAI`, mirroring the kernel-side `McpClientLike` inversion.
- `manager.test.ts` — driven through a fake host built on the real `ToolRegistry`, so tool derivation and detach cleanup are asserted against actual registry state.
- `client.ts` — `McpClient` class (TASK_0011 + TASK_0012). One instance per attached MCP server. Owns the `initialize` → `notifications/initialized` handshake, the `MCP-Protocol-Version`/`Mcp-Session-Id` header contract, paginated `tools/list` discovery, live re-sync via `handleListChanged`/`pollToolsList`, and a real `tools/call` execute binding with `outputSchema` validation (ajv), per-call timeouts, a progress seam, and `AbortSignal`-driven cancellation. Internal to this subpath; the public `bh.addMcp()` entry point (TASK_0015) wraps it.
- `client.test.ts` — handshake, header contract, pagination, namespacing, error-handling, accessor, live resync, tools/call round-trip, outputSchema validation, timeout, abort/cancellation, and progress seam tests (mocks global `fetch`).

## Conventions

- **Streamable HTTP only**: no stdio, no SSE-only legacy transport. The MCP spec's streamable-HTTP rev is the sole transport.
- **Zero-adapter interop** (§ 12): an MCP server re-export is a transport wrapper, not a conversion layer — local and remote tools share one registry and one `CallToolResult` shape.
- **Tool results are untrusted data** (§ 13): the kernel surfaces remote tool output but never lets it drive availability or auto-approval unless the host marks the source trusted.
- **`close()` is transport-only**: it aborts in-flight calls, `DELETE`s the session, and resets handshake state — it never unregisters tools. `bh.dispose()` calls it on every handle while tearing the registry down by other means, so making it destructive would break that path. Tool cleanup on detach belongs to `McpManager.remove()`.
- **The manager reports failure as state, not exceptions**: `add`/`retry`/`refresh` never reject. A UI driving off `subscribe()` would otherwise reconcile two sources of truth that can disagree. `bh.addMcp()` remains the rejecting API for callers who want that.

## Consumers

- `src/index.ts` re-exports this entry.
- `tsup.config.ts` builds it to `dist/plugins/mcp/index.js` + `.d.ts`.
- Hosts import `@bhzai/core/plugins/mcp` and pass `mcpPlugin` (or a `createMcpPlugin()` result) to `bh.use()` before `bh.init()`, then attach MCP servers via `bh.addMcp()` (TASK_0015) or, for observable state, `McpManager.add()`.
- `example/` renders `McpManager` state in its MCP servers panel — the reference consumer for the manager's status/tools/error surface.
