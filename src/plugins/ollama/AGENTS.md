# `src/plugins/ollama/` — Ollama driver plugin

## Purpose & scope

The Ollama driver plugin — talks to a local/remote Ollama server over plain
`fetch` (ARCHITECTURE.md § 10.3). Implements `BHAIDriver` (from
`src/types/driver.ts`) with no environment-specific bindings, so it runs in any
runtime that has `fetch` (browser, Node, Electron). This is the second of the
two "bundled drivers" (§ 10.3); unlike WebLLM, it needs no peer dependency —
just `fetch`.

## Key files

- `index.ts` — subpath entry. Exports the `Ollama` class (extends
  `EventTarget`, implements `BHAIDriver`), `OllamaOptions`, `OllamaEventMap`,
  and the internal `OllamaInternalOptions` (test-injection seam for `fetch`).
  Fully implemented by TASK_0020.
- `index.test.ts` — 19 tests covering NDJSON stream parsing, `listModels()`
  mapping, `capabilities()` cache + conservative defaults, `embed()`
  request/response, tool-call parsing with id fallback, non-2xx error
  handling, usage event mapping, and connection lifecycle events
  (`'connect'`, `'disconnect'`, `'error'`). Uses a hand-written fake `fetch`
  injected via `OllamaInternalOptions.fetchOverride`.

## Conventions

- **No peer deps**: unlike `webllm/`, this plugin needs only `fetch`, so it
  declares no peer dependency. It's pure web-standard.
- **Connection lifecycle events**: `Ollama extends EventTarget` and dispatches
  three web-standard events so hosts can observe the connection lifecycle
  without coupling to driver internals:
  - `'connect'` — `CustomEvent<{ models: ModelInfo[] }>` dispatched at the end
    of a successful `listModels()`, carrying the resolved model list.
  - `'disconnect'` — `Event` dispatched by the public `disconnect()` method.
    The Ollama transport is stateless (plain `fetch` over HTTP — no persistent
    connection to close), so this is a host-intent signal, not a transport
    teardown. `disconnect()` also clears the `capabilitiesCache` (a
    disconnected provider's cached caps are stale).
  - `'error'` — `CustomEvent<{ error: unknown; phase: 'listModels' | 'embed' }>`
    dispatched when `listModels()` or `embed()` fails (non-2xx or thrown
    `fetch` error). The original error is always re-thrown, so retry/kernel
    error-routing behavior is unchanged.
  Typed `addEventListener` overloads are provided via a declaration-merged
  `Ollama` interface backed by the `OllamaEventMap` type. `chat()` does not
  emit `'error'` (it's an async generator; error emission there is out of
  scope). No new dependency is added — `EventTarget` is built-in (Node 18+,
  browsers).
- **Credential resolution** (§ 10.4) is the host's/auth capability's job, not
  this plugin's — the driver never reads files or env vars for credentials.
  `OllamaOptions.headers` (defaults to `{}`) are forwarded on every `fetch`
  call; they are the "runtime values passed in driver options" that § 10.4
  documents as the highest-priority tier of the credential-resolution chain.
- **Capabilities cache**: `capabilities(model)` is synchronous per the
  `BHAIDriver` interface, but `/api/show` is async. Resolved by eagerly
  fetching and caching capabilities in a `Map<string, DriverCapabilities>`
  during `listModels()`/`chat()`, with conservative defaults (all booleans
  `false`, `contextWindow` `undefined`) when the cache has no entry yet.
- **Error shape**: non-2xx responses throw `{ status, body }`-shaped errors so
  TASK_0018's retry classifier can inspect `.status`. Network-level `fetch`
  failures propagate uncaught.
- **Tool-call id fallback**: Ollama's `tool_calls` entries don't always carry
  a stable `id`; the driver generates one via `crypto.randomUUID()` when the
  server doesn't supply one.

## Consumers

- `src/index.ts` re-exports this entry.
- `tsup.config.ts` builds it to `dist/plugins/ollama/index.js` + `.d.ts`.
- Hosts import `@lucasschirm/bhai/plugins/ollama` and pass the plugin to
  `bh.use()`.
