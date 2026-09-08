# Ollama driver plugin

> Subpath: `@bhzai/core/plugins/ollama`
> Source: `src/plugins/ollama/index.ts`

## Overview

The `Ollama` driver implements `BHZAIDriver` on top of a local or
remote Ollama server, using only web-standard `fetch`. It works unmodified in
any fetch-capable runtime (browser, Node, Electron) — no Node-specific HTTP
client, no peer dependency.

Unlike the WebLLM
driver (browser-only, WebGPU-accelerated, peer dep on `@mlc-ai/web-llm`),
Ollama gives BHZAI a zero-install, environment-agnostic local-inference story.

## Installation

No peer dependency to install — `fetch` is the only requirement.

```typescript
import { Ollama } from "@lucassirm/BHZAI/plugins/ollama"

const driver = new Ollama({
  baseUrl: "http://localhost:11434", // default
  headers: {},                       // default (local Ollama needs no auth)
})

bh.addDriver(driver)
```

## API

### `Ollama` class

Implements `BHZAIDriver` in full:

| Method | Endpoint | Notes |
|---|---|---|
| `chat(request)` | `POST /api/chat` | NDJSON streaming; async iterable of `DriverEvent` |
| `listModels()` | `GET /api/tags` | Returns `ModelInfo[]` with `availability: 'ready'` |
| `capabilities(model)` | `GET /api/show` (cached) | Synchronous; reads from internal cache |
| `embed(request)` | `POST /api/embed` | Returns `{ embeddings, usage? }` |

### `OllamaOptions`

```typescript
interface OllamaOptions {
  baseUrl?: string  // default 'http://localhost:11434'
  headers?: Record<string, string>  // default {}; forwarded on every request
}
```

`headers` are forwarded on every request.
Since local Ollama needs no auth,
`headers` defaults to `{}` and every request works unauthenticated when
omitted.

## Capabilities cache

`capabilities(model)` is synchronous per the `BHZAIDriver` interface, but
`GET /api/show` is inherently asynchronous. This driver resolves that tension
by eagerly fetching and caching `/api/show` results per model id the first
time `listModels()` or `chat()` references that model (populating an internal
`Map<string, DriverCapabilities>`). The synchronous `capabilities(model)`
method reads from that cache, falling back to conservative defaults when the
cache has no entry yet.

### Conservative defaults

When `/api/show`'s response omits the `capabilities` array or a specific
sub-string, or `model_info` lacks a recognizable context-length key, the
driver defaults to the safe/conservative value:

| Field | Default | Source |
|---|---|---|
| `streaming` | `true` | every `/api/chat` call streams |
| `toolCalls` | `false` | `capabilities.includes('tools')` |
| `reasoning` | `false` | `capabilities.includes('thinking')` |
| `embeddings` | `false` | `capabilities.includes('embedding')` |
| `contextWindow` | `undefined` | first `*.context_length` in `model_info` |

## NDJSON stream parsing

`chat()` issues a `POST /api/chat` with `{ stream: true }`, reads
`response.body` as a stream, splits on newlines, and `JSON.parse`s each
non-empty line. Each line maps to zero or more `DriverEvent`s:

- `message.content` (non-empty) → `{ type: 'delta', text }`
- `message.tool_calls` (per entry) → `{ type: 'tool-call', toolCallId, name, input }`
- `done: true` → `{ type: 'usage', ... }` (if token counts present) then
  `{ type: 'done', stopReason }`

### Tool-call id fallback

Ollama's `tool_calls` entries do not carry a stable `id` field in all server
versions. The driver generates one via `crypto.randomUUID()` when the server
doesn't supply one, and uses the server-supplied id when it does.

### Stop reason mapping

| Ollama `done_reason` | BHZAI `stopReason` |
|---|---|
| `'stop'` or absent (no tool calls) | `'stop'` |
| `'length'` | `'length'` |
| `'load'` or absent-but-had-tool-calls | `'tool-calls'` |
| (abort mid-stream) | `'abort'` |

## Error handling

- **Non-2xx HTTP**: throws `{ status, body }`-shaped error so retry
  classifiers can inspect `.status`. Body is parsed as JSON if possible,
  otherwise raw text.
- **Network-level `fetch` failure** (thrown `TypeError`): propagates uncaught
  out of the generator, allowing the transport retry wrapper to classify and retry.

## `listModels()` boundary

`listModels()` only ever returns `'ready'` entries (mapped from `/api/tags`).
Only pulled models are reported by this driver directly — Ollama's HTTP API does not expose a "known but unpulled"
catalogue endpoint.

## `embed()`

`POST /api/embed` with `{ model, input }` (always array form). Response shape
`{ embeddings, prompt_eval_count? }`. Embedding calls have no "output tokens"
concept, so `outputTokens` is hardcoded to `0` when usage is reported.

Only call `embed()` for models whose `capabilities(model).embeddings` is
`true`; calling it for a non-embedding model still forwards the request
(Ollama itself will error) — gatekeeping is a host/kernel-level concern, not
this driver's job.
