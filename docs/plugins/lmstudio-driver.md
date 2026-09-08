# LM Studio driver plugin

> Subpath: `@bhzai/core/plugins/lmstudio`
> Source: `src/plugins/lmstudio/index.ts`

## Overview

The `LMStudio` driver implements `BHZAIDriver` on top of a local or
remote [LM Studio](https://lmstudio.ai) server, using only web-standard
`fetch`. It works unmodified in any fetch-capable runtime (browser, Node,
Electron) — no Node-specific HTTP client, no peer dependency.

It is the third bundled driver, and the second of the two plain-HTTP ones. Where
WebLLM runs inference in-page over WebGPU (peer dep on `@mlc-ai/web-llm`),
`LMStudio` and `Ollama` both talk to a local server over `fetch`; they differ
only in wire format and in what per-model metadata each server exposes.

## Installation

No peer dependency to install — `fetch` is the only requirement.

```typescript
import { LMStudio } from "@bhzai/core/plugins/lmstudio"

const driver = new LMStudio({
  baseUrl: "http://localhost:1234", // default
  headers: {},                      // default (local LM Studio needs no auth)
})

bh.addDriver(driver)
```

Start the server from LM Studio's Developer tab (or `lms server start`).
Browser hosts additionally need CORS enabled in LM Studio's Developer settings.

## Why `/api/v0` and not `/v1`

LM Studio exposes two HTTP surfaces: an OpenAI-compatible `/v1` and its native
`/api/v0`. This driver uses `/api/v0` because only its `models` payload carries
the per-model metadata needed to answer `capabilities()` — `max_context_length`,
`type` (`'llm' | 'vlm' | 'embeddings'`), and, on newer builds, a `capabilities`
array. `/v1/models` returns bare ids, which would force every capability flag to
a conservative default.

The request and streaming-response bodies are OpenAI-shaped on both surfaces, so
the chat mapping is the familiar `choices[].delta` one regardless.

## API

### `LMStudio` class

Implements `BHZAIDriver` in full:

| Method | Endpoint | Notes |
|---|---|---|
| `chat(request)` | `POST /api/v0/chat/completions` | SSE streaming; async iterable of `DriverEvent` |
| `listModels()` | `GET /api/v0/models` | Returns `ModelInfo[]`; also fills the capabilities cache |
| `capabilities(model)` | — (cached) | Synchronous; reads from the internal cache |
| `embed(request)` | `POST /api/v0/embeddings` | Returns `{ embeddings, usage? }` |

Plus one non-interface method:

| Method | Notes |
|---|---|
| `disconnect()` | Host-intent signal: clears the capabilities cache and fires `'disconnect'`. No network I/O — the transport is stateless HTTP. |

### `LMStudioOptions`

```typescript
interface LMStudioOptions {
  baseUrl?: string                  // default 'http://localhost:1234'
  headers?: Record<string, string>  // default {}; forwarded on every request
}
```

`baseUrl` is the server **root** — the driver appends `/api/v0/…` itself.

`headers` are forwarded on every request to the backend server. The
driver does NOT implement the resolution chain itself. LM Studio's local server
is unauthenticated by default (its API token is opt-in), so `headers` defaults
to `{}` and every request works unauthenticated when omitted.

## Capabilities cache

`capabilities(model)` is synchronous per the `BHZAIDriver` interface, but
`GET /api/v0/models` is inherently asynchronous. This driver resolves that
tension the same way the Ollama driver does — by caching into an internal
`Map<string, DriverCapabilities>` and reading from it synchronously.

The difference: LM Studio returns the **whole catalogue with per-model metadata
in one response**, so a single request populates the cache for every model.
`listModels()` therefore issues exactly one fetch, and `chat()` issues at most
one extra (skipped when its model is already cached).

### Capability mapping

| Field | Source | Fallback when absent |
|---|---|---|
| `streaming` | — | always `true` |
| `toolCalls` | `capabilities.includes('tool_use')` | `type !== 'embeddings'` |
| `reasoning` | `capabilities.includes('reasoning')` | `false` |
| `embeddings` | `type === 'embeddings'` | `false` |
| `contextWindow` | `max_context_length` | `undefined` |

When a model is **not in the cache at all** (no prior `listModels()`/`chat()`,
or the catalogue lookup failed), `capabilities()` returns the fully conservative
default: every boolean `false`, `contextWindow` `undefined`.

### Why `toolCalls` deviates from Ollama's conservative default

If the server declares a `capabilities` array, it is authoritative — an explicit
empty array means "no tools", and the driver honors that.

If it does **not** declare one — LM Studio builds predating that field — the
driver falls back to `true` for any non-`embeddings` model, rather than the
`false` the Ollama driver would use. Those builds still serve tool calls through
their generic tool-call parser, so defaulting to `false` would silently strip
every tool from every request against them. Forwarding tools to a model that
then ignores them is the cheaper failure.

## `listModels()` availability mapping

Every returned entry is `availability: 'ready'`.

LM Studio's `state` field distinguishes `'loaded'` (resident in memory) from
`'not-loaded'` (downloaded but idle). That is a *warm-up* distinction, not an
availability one — LM Studio JIT-loads a `not-loaded` model on the first request
that names it. Reporting `'downloadable'` would wrongly suggest the host must
fetch something first, so the raw value is surfaced under `meta.state` instead.

`meta` also carries `type`, `publisher`, `arch`, `quantization`,
`compatibilityType`, and `maxContextLength`.

## SSE stream parsing

`chat()` issues a `POST /api/v0/chat/completions` with `{ stream: true }` and
`stream_options: { include_usage: true }`, reads `response.body` as a stream,
splits on newlines, and parses each `data:` frame. Blank separators, `event:`
lines, and `:` comments are skipped; `data: [DONE]` terminates the stream.

Each chunk maps to zero or more `DriverEvent`s:

- `choices[0].delta.content` → `{ type: 'delta', text }`
- `choices[0].delta.reasoning_content` → `{ type: 'reasoning-delta', text }`
- `choices[0].delta.tool_calls` → accumulated, not emitted yet (see below)
- `choices[0].finish_reason` → recorded for the terminal `done` event
- `usage` → recorded; emitted once at the end

At stream end the driver emits, in order: every accumulated `tool-call`, then
`usage` (if any chunk carried it), then `done`.

### Tool-call accumulation

OpenAI-shaped streams send a tool call's `id` and function `name` on the opening
fragment, then the JSON arguments a few characters at a time, all keyed by
`index`. The driver assembles fragments per index and emits a single
`{ type: 'tool-call', toolCallId, name, input }` event per call at stream end,
in ascending index order — so parallel tool calls stay separate.

`input` is the raw accumulated JSON argument **string**, matching the Ollama
driver; the conversation layer validates and repairs it.

The driver does not emit `tool-call-delta` events. `agent-loop.ts` filters its
buffer down to `tool-call` events before execution, so deltas would be dead
weight.

**Id fallback**: when no fragment for an index carries an `id`, one is generated
via `crypto.randomUUID()` so the call is still addressable.

### Stop reason mapping

| `finish_reason` | BHZAI `stopReason` |
|---|---|
| `'length'` | `'length'` |
| `'tool_calls'` | `'tool-calls'` |
| any value, when the turn produced tool calls | `'tool-calls'` |
| `'stop'` or absent, no tool calls | `'stop'` |
| (signal already aborted) | `'abort'` |

The tool-call override matters because some LM Studio builds close a
tool-calling turn with `finish_reason: 'stop'`; treating that as a natural stop
would strand the buffered calls unexecuted.

## Error handling

- **Non-2xx HTTP**: throws a `{ status, body }`-shaped error so the retry
  classifier can inspect `.status`. Body is parsed as JSON if possible,
  otherwise raw text.
- **Network-level `fetch` failure** (thrown `TypeError`): propagates uncaught,
  letting the retry wrapper classify it. In a browser this is the usual shape
  of a CORS rejection.
- **Failed catalogue lookup inside `chat()`**: swallowed on purpose. A chat call
  must not be aborted because the metadata request failed; `capabilities()`
  falls back to conservative defaults and the chat request itself surfaces any
  real connectivity problem.

## Connection lifecycle events

`LMStudio extends EventTarget` and dispatches the same three events as the
Ollama driver, so a host can drive both from one code path:

| Event | Payload | Fires when |
|---|---|---|
| `'connect'` | `CustomEvent<{ models: ModelInfo[] }>` | `listModels()` succeeds |
| `'disconnect'` | `Event` | `disconnect()` is called |
| `'error'` | `CustomEvent<{ error: unknown; phase: 'listModels' \| 'embed' }>` | either call fails |

The original error is always re-thrown after `'error'` fires, so retry and
kernel error-routing behavior is unchanged. `chat()` does not emit `'error'` —
it is an async generator, and errors propagate to the consumer directly.

Typed `addEventListener` overloads are provided via a declaration-merged
`LMStudio` interface backed by `LMStudioEventMap`.

## `embed()`

`POST /api/v0/embeddings` with `{ model, input }` (always array form). The
response is an OpenAI-shaped `data` array carrying an explicit `index`; the
driver sorts by it rather than trusting arrival order, so results line up
positionally with `input`.

Embedding calls have no "output tokens" concept, so `outputTokens` is hardcoded
to `0` when usage is reported.

Only call `embed()` for models whose `capabilities(model).embeddings` is `true`;
calling it for a non-embedding model still forwards the request (LM Studio
itself will error) — gatekeeping is a host/kernel-level concern, not this
driver's job.

## See also

- [`ollama-driver.md`](./ollama-driver.md) — the sibling local-HTTP driver.
- [`webllm-driver.md`](./webllm-driver.md) — the in-browser WebGPU driver.
- [`../core/drivers.md`](../core/drivers.md) — the driver registry and the
  `'<driverId>/<modelId>'` ref format.
