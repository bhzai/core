# MCP Client (`src/plugins/mcp/`)

Documentation for the built-in MCP (Model Context Protocol) streamable-HTTP
client. Spec rev 2025-11-25. Architecture reference: ARCHITECTURE.md § 9.3.

## Overview

The `McpClient` class is the internal building block for attaching remote MCP
servers. One instance is constructed per attached server. It owns:

1. The JSON-RPC 2.0 handshake (`initialize` → `notifications/initialized`).
2. The `MCP-Protocol-Version` / `Mcp-Session-Id` HTTP header contract.
3. Paginated `tools/list` discovery, registering remote tools into the shared
   `ToolRegistry` under the `mcp__<server>__<tool>` namespace.
4. Live re-sync via `handleListChanged()` / `pollToolsList()`.
5. A real `tools/call` execute binding with `outputSchema` validation,
   per-call timeouts, a progress seam, and `AbortSignal`-driven cancellation.

The public `bh.addMcp()` entry point (TASK_0015) wraps this class; hosts do
not typically construct `McpClient` directly.

## Getting started

The kernel never imports `src/plugins/**`, so `bh.addMcp()` cannot build an
`McpClient` by itself — it calls whatever factory has been registered, and
refuses to attach anything until one is. **`mcpPlugin` registers that
factory**; without it every attach fails with:

> `bh.addMcp(): the MCP plugin is not registered. Call `bh.use(mcpPlugin)` …`

```typescript
import { BHZAI } from "@bhzai/core";
import { mcpPlugin } from "@bhzai/core/plugins/mcp";

const bh = new BHZAI();
bh.use(mcpPlugin);          // must happen before init()
await bh.init();

const handle = await bh.addMcp({ url: "https://example.com/mcp", name: "github" });
// The server's tools are now in bh.listTools() as mcp__github__<tool>.
```

Ordering: `use()` before `init()`; `addMcp()` after it. Registration happens
in the plugin's `initialize` hook — form-2 capability objects have no `setup`
key — which `bh.init()` runs before it resolves `getMcps`, so both
declarative and imperative attaches are covered.

## Public API

```typescript
import {
  // Plugin + lifecycle
  mcpPlugin,
  createMcpPlugin,
  getMcpManager,
  McpManager,
  type McpPluginOptions,
  type McpServerState,
  type McpServerStatus,
  type McpServerError,
  type McpServerTool,
  // Client
  McpClient,
  McpHandshakeError,
  McpCallError,
  McpTimeoutError,
  type McpClientOptions,
  type ToolListDiff,
} from "@bhzai/core/plugins/mcp";
```

### `mcpPlugin` / `createMcpPlugin()`

- `mcpPlugin: BHZAIPluginCapabilities` — zero-config form. Holds no per-kernel
  state, so it is safe to register on several `BHZAI` instances; each gets its
  own manager, reachable via `getMcpManager(bh)`.
- `createMcpPlugin(options?): { plugin, manager }` — configurable form,
  handing the manager back directly. Bound to the first kernel it is `use()`d
  on; registering the same result on a second kernel throws.
  - `options.name` — plugin name for `use()` idempotency and
    `bh.disablePlugin(name)`. Defaults to `"mcp"`.
  - `options.servers` — `McpServerConfig[]` attached during `bh.init()` via
    the `getMcps` hook. These go through the kernel's hook resolution, so a
    failure rejects `init()` rather than becoming an `error` state — use it
    for servers the host considers mandatory.
  - `options.clientOptions` — default `McpClientOptions` for every client the
    plugin builds. Per-attach options passed to `bh.addMcp(config, options)`
    are merged over these.
- `getMcpManager(bh): McpManager | undefined` — the manager bound to a
  kernel, or `undefined` before `init()` has run.

### `McpManager`

Observable lifecycle on top of `bh.addMcp()`, for hosts that render attached
servers in a UI. Tracks a `McpServerState` per server:

```typescript
{
  id: string                 // stable across retries
  config: McpServerConfig
  serverName: string
  status: "connecting" | "connected" | "error" | "detached"
  tools: { name, shortName, description }[]
  error?: { name, message, stack?, url, at, phase }
  connectedAt?: number
  deferred: boolean
}
```

- `add(config)` — inserts a `connecting` entry and notifies **before**
  awaiting the handshake, then resolves with the terminal state. A duplicate
  server name is refused rather than attached (`McpRegistry` is
  last-attach-wins, which would orphan the previous handle's tools).
- `retry(id)` / `refresh(id)` — re-attempt a failed connect; re-poll a
  connected server's tool list.
- `remove(id)` — `close()` the session, unregister every `mcp__<server>__`
  tool, drop the entry. Local teardown completes even if `close()` fails, so
  a server that has already gone away stays removable.
- `list()` / `get(id)` / `subscribe(listener)` — read state; subscribe fires
  on every transition with the full list and returns an unsubscribe function.

**`add`, `retry`, and `refresh` never reject.** A failed connect is a
displayable state, not an exception — otherwise a UI driving off
`subscribe()` would have to reconcile the state stream against a thrown
error. Use `bh.addMcp()` directly if you want the rejecting API.

### `McpClient`

```typescript
new McpClient(config: McpServerConfig, toolRegistry: ToolRegistry, options?: McpClientOptions)
```

- `config.url` — streamable-HTTP MCP endpoint URL (required).
- `config.headers` — extra HTTP headers on every outbound request (optional).
- `config.name` — bhzai-local server name for tool namespacing (optional;
  derived from URL hostname if omitted).
- `config.deferred` — skip discovery at connect time (TASK_0016) (optional).
- `options.callTimeoutMs` — per-call timeout in milliseconds (default 60_000).

#### Methods

- `connect(): Promise<void>` — handshake + (unless `deferred`) discovery.
- `pollToolsList(): Promise<ToolListDiff>` — manual re-sync fallback (no-op
  if the server did not declare `tools.listChanged`).
- `handleListChanged(): Promise<ToolListDiff>` — re-run `tools/list`, diff
  against the cached name set, register/unregister the delta.
- `close(): Promise<void>` — terminate the session: abort in-flight calls,
  `DELETE` the endpoint with `Mcp-Session-Id` (spec session termination), and
  reset handshake state so a later `connect()` starts clean. **Never throws** —
  a `405` (server disallows client termination) and a network failure are both
  swallowed. **Transport-only**: it does not unregister discovered tools, since
  `bh.dispose()` calls it while tearing the registry down by other means; tool
  cleanup on detach is `McpManager.remove()`'s job.

#### Accessors

- `serverName: string` — the bhzai-local server name.
- `capabilities: ServerCapabilities | null` — server-declared capabilities.
- `supportsListChanged: boolean` — whether the server declared
  `tools.listChanged`.

### Error classes

- `McpHandshakeError` — handshake/discovery failures (non-2xx HTTP, JSON-RPC
  error, malformed body).
- `McpCallError` — `tools/call` failures (JSON-RPC error, non-2xx HTTP).
- `McpTimeoutError` — per-call timeout exceeded (carries `toolName` +
  `timeoutMs`).

## Known gaps (documented explicitly)

### SSE-streamed responses

The streamable-HTTP transport permits a server to respond with
`Content-Type: text/event-stream` instead of `application/json`. This client
only parses the plain-JSON case. Full SSE-stream parsing is deferred to a
future task. Servers that only ever respond with SSE streams (rare for
request/response methods like `initialize` and `tools/list`) are not
supported.

### Live push notifications

Receiving unsolicited server-to-client notifications like
`notifications/tools/list_changed` requires an open SSE stream. Since full
SSE-stream listening is not implemented, this client does not automatically
receive push notifications. Use `pollToolsList()` as a manual fallback (e.g.
on a timer). `McpManager.refresh(id)` wraps exactly that call, which is why
the example's MCP panel gives each connected server a manual refresh button
instead of updating its tool list on its own.

### Browser origins and CORS

The client is plain `fetch`, so a browser host is subject to CORS. An MCP
endpoint reached from a page must send `Access-Control-Allow-Origin` for that
origin and allow the `Content-Type`, `MCP-Protocol-Version`, `Mcp-Session-Id`,
and (when used) `Authorization` request headers. A CORS rejection surfaces in
JavaScript as an opaque `TypeError: Failed to fetch` — indistinguishable from
DNS failure or a refused connection — so hosts should say so in their error
UI rather than showing the raw message alone.

## Test coverage

34 tests in `src/plugins/mcp/client.test.ts`:

- Handshake: JSON-RPC 2.0 envelope, protocol version, session id, stateless
  server, `notifications/initialized`.
- Error handling: JSON-RPC error, non-2xx HTTP, malformed JSON.
- Discovery: pagination, namespacing, passthrough fields, deferred mode,
  custom headers, fallback server name.
- Re-sync: diff (added/removed/updated), no-op when `listChanged` not
  declared, `pollToolsList` delegation.
- Calls: original (unprefixed) name on wire, verbatim result round-trip,
  `outputSchema` validation (pass + fail with `isError` degradation),
  timeout, abort/cancellation with `notifications/cancelled`, progress seam.
- `close()`: `DELETE` headers, config-header merging, skipped when stateless,
  tolerance of `405` and network failure, state reset across a reconnect,
  in-flight call abort.

21 tests in `src/plugins/mcp/manager.test.ts` — status transitions and the
notify-before-await ordering, tool derivation by prefix, error capture and
normalization, duplicate-name refusal, retry/refresh, detach cleanup
(including tools registered lazily after the attach), and subscriber
isolation.

13 tests in `src/plugins/mcp/plugin.test.ts` — the seam end to end against a
real `BHZAI` kernel: pre-registration refusal, tool registration after attach,
per-kernel manager isolation, declarative `servers`, `clientOptions`
forwarding and per-attach override, and detach through the kernel.
