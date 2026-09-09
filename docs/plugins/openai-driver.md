# OpenAI driver plugin

> Subpath: `@bhzai/core/plugins/openai`
> Source: `src/plugins/openai/index.ts`

## Overview

The `OpenAI` driver implements `BHZAIDriver` on top of the
[OpenAI platform](https://platform.openai.com)'s public `/v1` REST API, using
only web-standard `fetch`. It works unmodified in any fetch-capable runtime
(browser, Node, Electron) — no Node-specific HTTP client, no peer dependency, and
notably **not** the official `openai` SDK, which would have to be a peer
dependency and injected for the sake of three endpoints.

It is the fourth bundled driver and the first hosted one. WebLLM runs inference
in-page over WebGPU (peer dep on `@mlc-ai/web-llm`); `Ollama` and `LMStudio` talk
to a local server; `OpenAI` talks to a remote, authenticated, multi-tenant
platform. That last difference drives every design decision below.

Because the wire format is the de-facto standard, the same driver serves any
OpenAI-compatible gateway — OpenRouter, Together, vLLM, LiteLLM, a proxy of your
own — by changing `baseUrl`.

## Installation

No peer dependency to install — `fetch` is the only requirement.

```typescript
import { OpenAI } from "@bhzai/core/plugins/openai"

const driver = new OpenAI({
  baseUrl: "https://api.openai.com",             // default
  headers: { Authorization: `Bearer ${apiKey}` }, // required in practice
})

bh.addDriver(driver)
```

### Credentials and the browser

`headers` are forwarded directly on outbound requests. The driver
does NOT implement resolution from ambient environment: it never reads
`process.env.OPENAI_API_KEY`, a config file, or any other ambient source.

Unlike the local-server drivers, omitting them is not a working configuration —
api.openai.com rejects every unauthenticated request with 401.

**A key in browser JavaScript is a public key.** Anyone who opens the page can
read it, and it bills your account. For browser hosts, point `baseUrl` at a
server-side proxy that injects the key. The bundled demo accepts a key in its
providers panel and stores it in `localStorage` in plaintext, which is acceptable
only because it is a local demo; use a throwaway, spend-limited project key
there.

## Why capabilities are inferred — and when they are not

This is the sharpest divergence from the LM Studio driver, and against OpenAI
itself it is forced by the API rather than chosen.

LM Studio exposes a metadata-rich native catalogue next to its OpenAI-compatible
one, so its driver reads `max_context_length`, `type` and a `capabilities` array
straight off the wire. api.openai.com publishes exactly one catalogue endpoint,
and a model object there is:

```json
{ "id": "gpt-4o-mini", "object": "model", "created": 1721172741, "owned_by": "system" }
```

No modality, no context length, no capability list. There is no richer endpoint
to prefer, so every flag is derived from the model id's family, and the one field
that cannot be derived safely (`contextWindow`) is host-overridable.

**Gateways are a different story.** Most OpenAI-compatible gateways add real
metadata to that same response, and the driver reads it in preference to any
guess — `context_length` / `top_provider.context_length` for the window, and
`supported_parameters` for tool-calling and reasoning. Measured against a live
OpenRouter catalogue: 337 of 337 models report a context length, and 270 declare
`tools`. Inferring instead of reading would have thrown all of that away and
disabled auto-compaction for every model on the provider.

## API

### `OpenAI` class

Implements `BHZAIDriver` in full:

| Method | Endpoint | Notes |
|---|---|---|
| `chat(request)` | `POST /v1/chat/completions` | SSE streaming; async iterable of `DriverEvent` |
| `listModels()` | `GET /v1/models` | Returns `ModelInfo[]`; also fills the capabilities cache |
| `capabilities(model)` | — (cached) | Synchronous; reads from the internal cache |
| `embed(request)` | `POST /v1/embeddings` | Returns `{ embeddings, usage? }` |

Plus one non-interface method:

| Method | Notes |
|---|---|
| `disconnect()` | Host-intent signal: clears the capabilities cache, the tool-call memory and the catalogue-fetched flag, then fires `'disconnect'`. No network I/O — the transport is stateless HTTPS. |

### `OpenAIOptions`

```typescript
interface OpenAIOptions {
  baseUrl?: string                        // default 'https://api.openai.com'
  headers?: Record<string, string>        // default {}; forwarded on every request
  contextWindows?: Record<string, number> // default {}; per-model overrides
}
```

`baseUrl` is the API **root** — the driver appends `/v1/…` itself.

## Capabilities cache

`capabilities(model)` is synchronous per the `BHZAIDriver` interface, but
`GET /v1/models` is inherently asynchronous. This driver resolves that tension
the same way the LM Studio driver does — by caching into an internal
`Map<string, DriverCapabilities>` and reading from it synchronously. One
catalogue request populates every model, so `listModels()` issues exactly one
fetch and `chat()` issues at most one extra — see [Catalogue polling](#catalogue-polling).

### Capability mapping

| Field | Declared by the provider | Inferred when nothing is declared |
|---|---|---|
| `streaming` | — | Always `true` |
| `toolCalls` | `supported_parameters` includes `tools` | `meta.type === 'chat'` |
| `reasoning` | `supported_parameters` includes `reasoning` or `reasoning_effort` | Chat model whose id starts with `o1`/`o3`/`o4`/`gpt-5`/`codex` |
| `embeddings` | — | `meta.type === 'embeddings'` |
| `contextWindow` | `context_length` or `top_provider.context_length` | family table |

`contextWindows[id]` outranks both columns. An explicit but empty
`supported_parameters` array is a statement ("supports nothing"), not missing
data — the same rule the LM Studio driver applies to its `capabilities` array.

### Id normalization

Two id shapes are normalized before any id-based test runs:

- **Fine-tunes** — `ft:gpt-4o-mini-2024-07-18:acme::AbC123` resolves through its
  base model, inheriting its family.
- **Vendor namespacing** — every gateway id looks like `openai/gpt-5-mini` or
  `deepseek/deepseek-v4`, so each id is matched both in full and on its last path
  segment. Without this, a raw prefix test matches nothing and *all* inference
  silently degrades to the conservative default.

The id itself is never rewritten. `parseModelRef` splits a ref on its FIRST
slash, so the ref `openai/deepseek/deepseek-v4` correctly addresses model
`deepseek/deepseek-v4` on driver `openai`.

When a model is **not in the cache at all** (no prior `listModels()`/`chat()`, or
the catalogue lookup failed), `capabilities()` returns the fully conservative
default: every boolean `false`, `contextWindow` `undefined`.

### Why `toolCalls` deviates from the conservative default

The same reasoning the LM Studio driver documents, for a stronger reason: the API
declares nothing at all, and every current OpenAI chat model supports tool
calling. Defaulting to `false` would silently strip every tool from every
request. Forwarding tools to a model that ignores them is the cheaper failure.

A model the cache has never seen still reports `toolCalls: false` — that is
absence of data, not an inference.

### The context-window table

This is the last resort, used only when neither the host nor the provider
supplies a number.

api.openai.com reports no context length, and a model that reports no
`contextWindow` disables auto-compaction. Returning `undefined` for the whole provider
would quietly turn that feature off, so the driver ships a family table matched
longest-prefix — `gpt-4o` (128k) beats `gpt-4` (8k) for `gpt-4o-mini`, and
`gpt-4.1` (1M) beats both.

Every value errs **low**: it is the published window of the family's baseline
member, and a newer member is assumed to be at least as large. Under-reporting
makes compaction fire early, which costs a little quality; over-reporting would
let a conversation grow past the real limit and fail the request outright.

The catalogue changes faster than this package ships, and proxied or fine-tuned
ids need not follow any family, so the table is overridable per model:

```typescript
new OpenAI({
  headers: { Authorization: `Bearer ${apiKey}` },
  contextWindows: { "my-proxied-model": 32_000 },
})
```

An exact id match always wins. A model matching neither an override nor a family
reports `undefined`.

## Catalogue polling

`listModels()` always fetches. `chat()` fetches at most **once per connection**,
to fill the capabilities cache before deciding whether to advertise tools.

That budget is tracked by "has a catalogue fetch succeeded", not by "is this
model in the cache". The distinction matters: a model missing from a catalogue
that loaded fine is legitimately missing — gateways routinely serve models they
do not list, and some return an empty `data` array — so keying off the per-model
miss re-polls `/v1/models` before every single `chat()` call and never succeeds
in filling the gap.

A *failed* fetch does not consume the budget, so the next call retries.
`disconnect()` re-arms it.

## `listModels()` availability and modality

Every returned entry is `availability: 'ready'`. A hosted model is usable the
moment the key can see it — there is nothing to download and no warm-up state.
Models the key cannot reach are simply absent from the response rather than
listed as `'unavailable'`.

`meta` carries `type` (the inferred modality), `ownedBy` and `created`.

### The catalogue is multi-modal

`GET /v1/models` returns speech, image, moderation and embedding models
alongside chat ones. All of them are returned — filtering a catalogue is a host
decision, not a driver one — but each is tagged so hosts can filter:

| `meta.type` | Inferred from | Example ids |
|---|---|---|
| `embeddings` | id contains `embedding` | `text-embedding-3-small` |
| `moderation` | id contains `moderation` | `omni-moderation-latest` |
| `image` | id starts with `dall-e`/`gpt-image`/`sora` | `dall-e-3` |
| `audio` | id starts with `whisper`/`tts-`, or contains `-tts`/`-transcribe`/`-realtime` | `whisper-1`, `gpt-4o-mini-tts` |
| `completion` | id starts with `babbage-`/`davinci-` | `davinci-002` |
| `chat` | everything else | `gpt-4o-mini`, `o3`, `gpt-5` |

An id matching no probe falls through to `'chat'` deliberately: OpenAI ships new
chat models far more often than new modalities, and a chat model wrongly hidden
from a picker is a worse failure than a non-chat model wrongly offered, which
errors visibly on first use.

`example/src/lib/models.ts` keeps only conversational types (`chat`, plus LM
Studio's `llm`/`vlm`), and keeps every entry that carries no `meta.type` at all.

## SSE stream parsing

`chat()` issues a `POST /v1/chat/completions` with `{ stream: true }` and
`stream_options: { include_usage: true }`, reads `response.body` as a stream,
splits on newlines, and parses each `data:` frame. Blank separators, `event:`
lines, and `:` comments are skipped; `data: [DONE]` terminates the stream.

Each `chat.completion.chunk` maps to zero or more `DriverEvent`s:

- `choices[0].delta.content` → `{ type: 'delta', text }`
- `choices[0].delta.refusal` → `{ type: 'delta', text }` (see below)
- `choices[0].delta.reasoning_content` → `{ type: 'reasoning-delta', text }`
- `choices[0].delta.tool_calls` → accumulated, not emitted yet (see below)
- `choices[0].finish_reason` → recorded for the terminal `done` event
- `usage` → recorded; emitted once at the end

At stream end the driver emits, in order: every accumulated `tool-call`, then
`usage` (if any chunk carried it), then `done`.

**Refusals** arrive on their own field rather than as content. They are surfaced
as ordinary `delta` text so a refused turn renders as an explanation instead of
an empty assistant message.

**Reasoning text** is not emitted by api.openai.com on this surface — reasoning
summaries live in the Responses API. `reasoning_content` is read for the benefit
of OpenAI-compatible gateways that do emit it. Models that wrap thinking in
inline `<think>` tags are the conversation layer's `parseThink` job, not the
driver's.

### Tool-call accumulation

OpenAI sends a tool call's `id` and function `name` on the opening fragment, then
the JSON arguments a few characters at a time, all keyed by `index`. The driver
assembles fragments per index and emits a single
`{ type: 'tool-call', toolCallId, name, input }` event per call at stream end, in
ascending index order — so parallel tool calls stay separate.

`input` is the raw accumulated JSON argument **string**, matching the other
drivers; the conversation layer validates and repairs it.

The driver does not emit `tool-call-delta` events. `agent-loop.ts` filters its
buffer down to `tool-call` events before execution, so deltas would be dead
weight.

**Id fallback**: when no fragment for an index carries an `id`, one is generated
via `crypto.randomUUID()` so the call is still addressable.

### Rebuilding the tool loop

OpenAI validates conversation structure, and this is the one place where a
`{ role, content }` map — enough for Ollama and LM Studio — produces a hard 400.

A `role: 'tool'` message must carry a `tool_call_id`, and it must follow an
assistant message whose `tool_calls` array contains that id. The kernel records
the id on the tool-result message's `meta.toolCallId`
but does **not** record the calls on the
assistant message that made them, so the second iteration of every tool loop
would fail before the model saw it.

The driver therefore rebuilds the pairing while mapping the request:

1. Each `tool` message becomes `{ role: 'tool', tool_call_id, content }`. A
   message with no recorded id gets a generated one, used on both sides.
2. The run of consecutive tool messages is walked back to the message in front of
   it. If that is an assistant message, the reconstructed call records are
   appended to its `tool_calls` (parallel calls share one assistant message); an
   assistant message left with empty content drops `content` entirely, which the
   API requires when `tool_calls` is present.
3. If it is not an assistant message, a synthetic content-less assistant message
   is spliced in to carry them.

**Arguments** come from three sources, in descending order of authority:

1. **`meta.toolCalls` on the assistant message.** The agent loop records every
   turn's tool calls there as `ToolCallRecord[]`, precisely so they can be
   replayed. It is plain JSON, so it survives the snapshot round-trip — a restored
   conversation replays the model's real arguments.
2. **A bounded map of calls this driver instance streamed** (256 entries, evicted
   oldest-first, cleared by `disconnect()`), covering messages that carry no
   record — one a host injected by hand, for instance.
3. **`'{}'`** as a last resort. Ids and names are still correct, which is what the
   API validates; only the argument text is lost.

A call already advertised from source 1 is never re-added when its result is
paired up, so the two paths cannot double up.

Hosts need do nothing for any of this.

### Stop reason mapping

| `finish_reason` | BHZAI `stopReason` |
|---|---|
| `'length'` | `'length'` |
| `'tool_calls'` | `'tool-calls'` |
| any value, when the turn produced tool calls | `'tool-calls'` |
| `'stop'`, `'content_filter'` or absent, no tool calls | `'stop'` |
| (signal already aborted) | `'abort'` |

The tool-call override matters because compatible gateways can close a
tool-calling turn with `finish_reason: 'stop'`; treating that as a natural stop
would strand the buffered calls unexecuted.

## Generation parameters

| `ChatRequest.params` | Wire field | Notes |
|---|---|---|
| `temperature` | `temperature` | Forwarded as given. Reasoning models accept only the default — omit it for them. |
| `maxTokens` | `max_completion_tokens` | NOT `max_tokens`, which is deprecated and rejected by reasoning models. |
| `stop` | `stop` | |
| `reasoning` | `reasoning_effort` | Sent only when `capabilities().reasoning` is `true`. |

The six-level `reasoning` scale maps one-to-one onto OpenAI's
`reasoning_effort` enum, except `'off'` which becomes `'none'`. Not every
reasoning model accepts every value; one that rejects a value errors visibly
rather than silently ignoring it, which is what a host can act on.

## Error handling

- **Non-2xx HTTP**: throws a `{ status, body }`-shaped error so the retry
  classifier can inspect `.status`. Body is parsed as JSON if possible, otherwise
  raw text. The two statuses worth handling specially here are `401` (bad or
  missing key) and `429` (rate limit or exhausted quota).
- **Network-level `fetch` failure** (thrown `TypeError`): propagates uncaught,
  letting the retry wrapper classify it.
- **Failed catalogue lookup inside `chat()`**: swallowed on purpose. A chat call
  must not be aborted because the metadata request failed; `capabilities()` falls
  back to conservative defaults and the chat request itself surfaces any real
  problem — including a bad key, which fails both calls the same way.

## Connection lifecycle events

`OpenAI extends EventTarget` and dispatches the same three events as the other
HTTP drivers, so a host can drive all of them from one code path:

| Event | Payload | Fires when |
|---|---|---|
| `'connect'` | `CustomEvent<{ models: ModelInfo[] }>` | `listModels()` succeeds |
| `'disconnect'` | `Event` | `disconnect()` is called |
| `'error'` | `CustomEvent<{ error: unknown; phase: 'listModels' \| 'embed' }>` | either call fails |

The original error is always re-thrown after `'error'` fires, so retry and kernel
error-routing behavior is unchanged. `chat()` does not emit `'error'` — it is an
async generator, and errors propagate to the consumer directly.

Typed `addEventListener` overloads are provided via a declaration-merged `OpenAI`
interface backed by `OpenAIEventMap`.

## `embed()`

`POST /v1/embeddings` with `{ model, input }` (always array form). The response
`data` array carries an explicit `index`; the driver sorts by it rather than
trusting arrival order, so results line up positionally with `input`.

Embedding calls have no "output tokens" concept, so `outputTokens` is hardcoded
to `0` when usage is reported.

Only call `embed()` for models whose `capabilities(model).embeddings` is `true`;
calling it for a non-embedding model still forwards the request (OpenAI itself
will error) — gatekeeping is a host/kernel-level concern, not this driver's job.

## See also

- [`lmstudio-driver.md`](./lmstudio-driver.md) — the sibling SSE driver, for a
  local server that *does* declare its metadata.
- [`ollama-driver.md`](./ollama-driver.md) — the NDJSON local-HTTP driver.
- [`webllm-driver.md`](./webllm-driver.md) — the in-browser WebGPU driver.
- [`../core/drivers.md`](../core/drivers.md) — the driver registry and the
  `'<driverId>/<modelId>'` ref format.
