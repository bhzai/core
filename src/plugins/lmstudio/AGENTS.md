# `src/plugins/lmstudio/` — LM Studio driver plugin

## Purpose & scope

The LM Studio driver plugin — talks to a local (or remote) LM Studio server over
plain `fetch`, using LM Studio's native REST API (`/api/v0/*`). Implements
`BHZAIDriver` (from `src/types/driver.ts`) with no environment-specific
bindings, so it runs in any runtime that has `fetch` (browser, Node, Electron).

Shares the Ollama driver's posture (ARCHITECTURE.md § 10.3): no peer dependency,
no engine injection, web-standard APIs only. The difference is the wire format —
LM Studio speaks OpenAI-shaped JSON over Server-Sent Events, where Ollama speaks
its own NDJSON.

## Key files

- `index.ts` — subpath entry. Exports the `LMStudio` class (extends
  `EventTarget`, implements `BHZAIDriver`), `LMStudioOptions`,
  `LMStudioEventMap`, and the internal `LMStudioInternalOptions`
  (test-injection seam for `fetch`).
- `index.test.ts` — 36 tests covering SSE stream parsing, streamed tool-call
  accumulation (including parallel calls and the missing-id fallback),
  `listModels()` mapping, `capabilities()` cache + declared-vs-inferred flags,
  `embed()` request/response mapping and index ordering, request-body mapping
  (system prompt, tools, generation params), non-2xx error handling, abort
  handling, and connection lifecycle events. Uses a hand-written fake `fetch`
  injected via `LMStudioInternalOptions.fetchOverride`.
- `README.md` — consumer-facing usage guide with examples.

## Conventions

- **`/api/v0`, not `/v1`.** LM Studio exposes both, but only the native
  `/api/v0/models` payload carries the per-model metadata `capabilities()`
  needs (`max_context_length`, `type`, and the `capabilities` array on newer
  builds). `/v1/models` returns bare ids. The request/response bodies are
  OpenAI-shaped on both surfaces, so the chat mapping is the familiar
  `choices[].delta` one either way.
- **No peer deps**: like `ollama/`, this plugin needs only `fetch`.
- **Connection lifecycle events**: `LMStudio extends EventTarget` and dispatches
  the same three web-standard events as the Ollama driver, so a host can drive
  both from one code path:
  - `'connect'` — `CustomEvent<{ models: ModelInfo[] }>` at the end of a
    successful `listModels()`.
  - `'disconnect'` — `Event` dispatched by the public `disconnect()` method.
    The transport is stateless (plain `fetch`), so this is a host-intent
    signal, not a teardown; it also clears the `capabilitiesCache`.
  - `'error'` — `CustomEvent<{ error: unknown; phase: 'listModels' | 'embed' }>`
    when either call fails. The original error is always re-thrown.
  Typed `addEventListener` overloads come from a declaration-merged `LMStudio`
  interface backed by `LMStudioEventMap`. `chat()` does not emit `'error'`
  (it's an async generator), matching the Ollama driver.
- **Capabilities cache**: `capabilities(model)` is synchronous per the
  `BHZAIDriver` interface, but `/api/v0/models` is async. Resolved the same way
  the Ollama driver does it — an internal `Map<string, DriverCapabilities>`
  populated by `listModels()`/`chat()`, with conservative defaults when a model
  has no entry. Unlike Ollama, ONE catalogue request populates every model at
  once, so `listModels()` issues exactly one fetch.
- **`toolCalls` default deviates from Ollama on purpose.** When the server
  declares a `capabilities` array, it is authoritative
  (`includes('tool_use')`). When it does not — LM Studio builds predating that
  field — `toolCalls` falls back to `true` for any non-`embeddings` model,
  because those builds still serve tool calls through their generic tool-call
  parser. Defaulting to `false` there would silently strip every tool from
  every request. A model the cache has never seen still gets `false`; that is
  absence of data, not a declaration.
- **`availability` is always `'ready'`.** LM Studio's `state` field
  (`'loaded'` / `'not-loaded'`) is a warm-up distinction, not an availability
  one — a `not-loaded` model is JIT-loaded on the first request naming it.
  Reporting `'downloadable'` would wrongly imply the host must fetch something,
  so the raw `state` is surfaced under `meta.state` instead.
- **Tool calls are accumulated, then emitted once.** OpenAI-shaped streams send
  a tool call's id and name on the opening fragment and its JSON arguments a
  few characters at a time, keyed by `index`. The driver assembles them and
  emits one `tool-call` `DriverEvent` per index at stream end, in index order.
  It does NOT emit `tool-call-delta` — `agent-loop.ts` filters the buffer down
  to `tool-call` events anyway, so deltas would be dead weight.
- **Stop-reason override**: a turn that produced tool calls reports
  `stopReason: 'tool-calls'` even when the server closes it with
  `finish_reason: 'stop'` — some LM Studio builds do, and treating that as a
  natural stop would strand the buffered calls unexecuted.
- **Error shape**: non-2xx responses throw `{ status, body }`-shaped errors so
  the retry classifier can inspect `.status`. Network-level `fetch` failures
  propagate uncaught.
- **Credential resolution** (§ 10.4) is the host's job, not this plugin's.
  `LMStudioOptions.headers` (default `{}`) are forwarded on every request; LM
  Studio's local server is unauthenticated by default, so omitting them works.

## Consumers

- `src/index.ts` re-exports this entry.
- `tsup.config.ts` builds it to `dist/plugins/lmstudio/index.js` + `.d.ts`.
- `example/src/app/provider-controller.ts` instantiates it alongside `Ollama`
  when the user adds an LM Studio provider in the demo's providers panel.
- Hosts import `@bhzai/core/plugins/lmstudio` and pass the driver to
  `bh.addDriver()`.
