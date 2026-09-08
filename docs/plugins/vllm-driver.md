# vLLM driver plugin

Subpath: `@bhzai/core/plugins/vllm`
Source: `src/plugins/vllm/index.ts`

## Overview

A `BHZAIDriver` implementation over [vLLM](https://docs.vllm.ai)'s
OpenAI-compatible server (`/v1/*`), speaking plain `fetch`. Like the Ollama, LM
Studio and OpenAI drivers it has no peer dependency and injects no engine — it
touches only web-standard APIs (`fetch`, `AbortSignal`, `ReadableStream`,
`TextDecoder`, `crypto.randomUUID`), so it runs unchanged in a browser, Node or
Electron.

vLLM speaks OpenAI-shaped JSON over Server-Sent Events, so the streaming shape
is the familiar `choices[].delta` one.

## Installation

No install beyond the package — the driver is bundled.

```bash
vllm serve meta-llama/Llama-3.1-8B-Instruct
```

```ts
import { BHZAI } from "@bhzai/core";
import { VLLM } from "@bhzai/core/plugins/vllm";

const bh = new BHZAI();
bh.addDriver(new VLLM({ baseUrl: "http://localhost:8000" }));

const conversation = await bh.createConversation({
  model: "vllm/meta-llama/Llama-3.1-8B-Instruct",
});
await conversation.sendMessage("Explain PagedAttention in one sentence.");
```

## Why a dedicated driver rather than `OpenAI({ baseUrl })`

The OpenAI driver can be pointed at a vLLM server and will mostly work. Three
differences justify a first-class driver:

1. **`driver.id`.** `bh.addDriver()` shadows by `driver.id`, so an `OpenAI`
   instance aimed at vLLM and one aimed at api.openai.com cannot both be live —
   the second replaces the first in the catalogue. `id === 'vllm'` lets a host
   run both simultaneously.
2. **`max_model_len`.** vLLM reports a real per-model context window on
   `/v1/models`. The OpenAI driver falls back to a model-id family table, which
   has no entry for an arbitrary HuggingFace repo id — and a model reporting no
   `contextWindow` has auto-compaction disabled entirely. This is behavioral, not cosmetic.
3. **`delta.reasoning`.** Current vLLM names the separated-thinking channel
   `reasoning`. The OpenAI driver reads only `reasoning_content`, so reasoning
   output would be silently dropped.

## Why `/v1/models` is the right endpoint

Unlike LM Studio — which exposes a metadata-rich native `/api/v0` alongside its
OpenAI-compatible surface — vLLM publishes exactly one catalogue endpoint. It is
not metadata-poor, though: vLLM extends the standard model object with
`max_model_len`, `root` and `parent` (the latter two expressing LoRA-adapter
lineage), all of which this driver reads. There is nothing richer to prefer.

```jsonc
{
  "object": "list",
  "data": [
    {
      "id": "meta-llama/Llama-3.2-3B-Instruct",
      "object": "model",
      "created": 1715644056,
      "owned_by": "vllm",
      "root": "meta-llama/Llama-3.2-3B-Instruct",
      "parent": null,
      "max_model_len": 131072
    },
    {
      "id": "sql-lora",
      "root": "jeeejeee/llama32-3b-text2sql-spider",
      "parent": "meta-llama/Llama-3.2-3B-Instruct"
    }
  ]
}
```

## API

### `VLLM` class

| Member                 | Signature                                             | Notes                                            |
| ---------------------- | ----------------------------------------------------- | ------------------------------------------------ |
| `id`                   | `'vllm'`                                              | The `'<driverId>/<modelId>'` ref prefix.          |
| `listModels()`         | `Promise<ModelInfo[]>`                                | `GET /v1/models`; fills the capabilities cache.   |
| `capabilities(model)`  | `DriverCapabilities`                                  | **Synchronous**; cache-backed.                    |
| `chat(request)`        | `AsyncIterable<DriverEvent>`                          | `POST /v1/chat/completions`, SSE.                 |
| `embed(request)`       | `Promise<{ embeddings, usage? }>`                     | `POST /v1/embeddings`.                            |
| `disconnect()`         | `void`                                                | Host-intent signal; clears caches, fires event.   |

### `VLLMOptions`

| Option      | Type                     | Default                   | Notes                                                    |
| ----------- | ------------------------ | ------------------------- | -------------------------------------------------------- |
| `baseUrl`   | `string`                 | `http://localhost:8000`   | The server **root** — the driver appends `/v1/…`.         |
| `headers`   | `Record<string, string>` | `{}`                      | Forwarded on every request; needed only with `--api-key`. |
| `toolCalls` | `boolean`                | `true` for non-embeddings | Force the tool-call capability.                           |
| `reasoning` | `boolean`                | `false`                   | Force the reasoning capability.                           |
| `prefixProvider` | `boolean`           | `false`                   | Prepend `'vllm/'` to the model name on the wire.          |

`VLLMInternalOptions` adds a `fetchOverride` test seam; it is not part of the
public API.

### Model name on the wire (`prefixProvider`)

The kernel passes the **bare model id** (e.g. `meta-llama/Llama-3.1-8B-Instruct`)
as `ChatRequest.model` — not the qualified `vllm/<model>` ref. The driver knows
its own id via `this.id` and decides how to format the model name on the wire.
A stock vLLM server expects exactly what `GET /v1/models` published (the bare
id), so the default is `prefixProvider: false` and the bare id is sent directly
on both `chat()` and `embed()`. Set `prefixProvider: true` only when pointing at
a gateway that keys its model registry by the qualified ref.

## Capabilities cache

`BHZAIDriver.capabilities(model)` is synchronous, but its data source
(`GET /v1/models`) is asynchronous. Resolved the same way as in the Ollama, LM
Studio and OpenAI drivers: an internal `Map<string, DriverCapabilities>` filled
eagerly by `listModels()` and by `chat()` (via `refreshCapabilitiesCache`), read
synchronously, returning conservative defaults on a miss:

```ts
{ streaming: true, toolCalls: false, reasoning: false, embeddings: false, contextWindow: undefined }
```

It never throws. `chat()` polls the catalogue at most once per connection —
tracked by an internal `catalogueLoaded` flag rather than a per-model cache miss,
so a model the server serves but does not list does not trigger a poll before
every call. A failed poll does not set the flag (so it retries), `listModels()`
always re-fetches, and `disconnect()` re-arms it. A metadata lookup that fails
inside `chat()` never aborts the chat request.

### Capability mapping

| Flag            | Source                                                                      |
| --------------- | --------------------------------------------------------------------------- |
| `streaming`     | Always `true` — `/v1/chat/completions` streams.                              |
| `toolCalls`     | `options.toolCalls`, else `true` for non-embedding models.                   |
| `reasoning`     | `options.reasoning`, else `false`.                                           |
| `embeddings`    | Id matches `embed`, `bge-`, `gte-`, `e5-`, `-e5` or `nomic-embed`.           |
| `contextWindow` | `max_model_len` verbatim; a LoRA adapter inherits its `parent`'s value.      |

### Two capabilities are server-launch flags

vLLM serves tool calls only when started with
`--enable-auto-tool-choice --tool-call-parser <parser>`, and emits separated
reasoning only with `--reasoning-parser <parser>`. **Neither is reported on the
wire**, so the driver has to guess — which is why both are overridable.

**`toolCalls` deviates from the conservative default** (`true` for non-embedding
models), matching the precedent set by the LM Studio and OpenAI drivers. The
trade-off is asymmetric:

- Defaulting to `false` against a correctly configured server silently strips
  every tool from every request — nothing errors, tools simply never work.
- Defaulting to `true` against a server without the flags produces a loud 400
  that names the missing flag — actionable in seconds.

Set `toolCalls: false` when you know the server has no tool-call parser. A model
the cache has never seen still reports `toolCalls: false`; that is an absence of
data, not an inference.

## `listModels()` availability mapping

Every entry is `'ready'`. vLLM loads its model into GPU memory at startup and
only begins serving afterwards, so anything the catalogue lists is usable
immediately — there is nothing to download, and no warm-up state to report
(unlike LM Studio's `not-loaded`).

Each entry carries `meta`:

| `meta` key    | Source                                            |
| ------------- | ------------------------------------------------- |
| `type`        | `'chat'` or `'embeddings'`, inferred from the id.  |
| `ownedBy`     | `owned_by` (`'vllm'` on a stock server).           |
| `created`     | `created` (Unix seconds).                          |
| `root`        | `root` — the served artifact.                      |
| `parent`      | `parent` — the base model, for a LoRA adapter.     |
| `maxModelLen` | `max_model_len`, raw.                              |

Hosts filter their pickers on `meta.type`, never on `availability` — the WebLLM
driver reports `'downloadable'` for its whole catalogue, so an availability
filter would empty the picker.

Model ids keep their slashes (`meta-llama/Llama-3.1-8B-Instruct` →
`vllm/meta-llama/Llama-3.1-8B-Instruct`). `parseModelRef` splits on the **first**
slash only, so this round-trips correctly.

## SSE stream parsing

`response.body` is read via `getReader()`, decoded with `TextDecoder` and
`{ stream: true }`, buffered and split on `\n`. Lines not starting with `data:`
are skipped (dropping blank separators, `event:` lines and `:` comments), and
`data: [DONE]` terminates.

Per chunk:

| Chunk field                        | Emitted as                             |
| ---------------------------------- | -------------------------------------- |
| `delta.reasoning`                  | `reasoning-delta`                      |
| `delta.reasoning_content`          | `reasoning-delta` (older-build fallback) |
| `delta.content`                    | `delta`                                |
| `delta.tool_calls`                 | accumulated; emitted at stream end     |
| `choices[0].finish_reason`         | folded into the terminal `done`        |
| `usage`                            | `usage` (last one seen wins)           |

`stream_options: { include_usage: true }` is always requested; builds that do not
understand it simply omit the usage chunk and the event is skipped.

**Two reasoning field names.** Current vLLM streams thinking text as
`delta.reasoning`; older builds and several downstream forks use
`delta.reasoning_content`. Both are read, in that order, so reasoning is never
silently dropped. A server with **no** `--reasoning-parser` leaves `<think>` tags
inline in `content` — that is the conversation layer's `parseThink` job, and the
driver never strips tags.

### Tool-call accumulation

Fragments arrive keyed by `index`: the first carries `id` and `function.name`,
later ones carry `function.arguments` a few characters at a time. The driver
accumulates them into a `Map<number, PendingToolCall>`, treats a missing `index`
as `0`, falls back to `crypto.randomUUID()` for a missing id, and emits one
`tool-call` per index in ascending order at stream end.

It never emits `tool-call-delta` — `agent-loop.ts` filters those out before
executing. `input` is the **raw accumulated JSON string**; the conversation layer
validates and repairs it, so the driver does not parse it.

Terminal order is always **tool-calls → usage → done**, with exactly one `done`
on every exit path.

### Stop reason mapping

| vLLM `finish_reason`                     | BHZAI `stopReason` |
| ---------------------------------------- | ------------------ |
| `length`                                 | `length`           |
| `tool_calls`, or any turn with tool calls | `tool-calls`       |
| `stop`, absent                           | `stop`             |
| `signal.aborted`                         | `abort`            |

The "any turn with tool calls" override matters: several vLLM tool-call parsers
extract the call from text the model ended normally, closing the turn with
`finish_reason: 'stop'`. Trusting that would strand the buffered calls
unexecuted.

## Reasoning: a chat-template kwarg, not an effort enum

vLLM has no `reasoning_effort` parameter — thinking is toggled through the
model's Jinja chat template. BHZAI's six-level `params.reasoning` scale collapses
to a boolean (the same posture as Ollama's `think`), and both spellings in
circulation are sent:

```jsonc
// params.reasoning: "high" | "medium" | ... ->
{ "chat_template_kwargs": { "enable_thinking": true, "thinking": true } }
// params.reasoning: "off" ->
{ "chat_template_kwargs": { "enable_thinking": false, "thinking": false } }
```

`enable_thinking` is the Qwen3 convention and `thinking` is Granite's; a template
using neither ignores both, since an unused kwarg is inert in Jinja.

The kwargs are sent **only when the host explicitly set `params.reasoning`**, and
deliberately **not** gated on `capabilities().reasoning` — that flag defaults to
`false` precisely because the server's `--reasoning-parser` setting is
undetectable, so gating on it would make the control dead against every default
configuration.

## Tool-loop message reconstruction

vLLM renders the conversation through the model's chat template. The tool
templates (`llama3_json`, `hermes`, and friends) read `tool_calls` off the
assistant turn to render the call, and pair a `role: 'tool'` message to it by
`tool_call_id`. The kernel records the id on the tool-result message's
`meta.toolCallId` but does **not** record the calls on the assistant message that
made them — so a naive `{ role, content }` mapping renders a tool result with no
antecedent, and the model sees an answer to a question it never asked.

`mapMessages()` / `attachToolCall()` rebuild the pairing, walking each run of
consecutive `tool` messages and attaching the matching `tool_calls` to the
assistant message in front of it (splicing in a synthetic one when there is
none). Arguments come from three sources, in descending authority:

1. **`meta.toolCalls`** on the assistant message (`ToolCallRecord[]`, written by
   the agent loop and snapshot-safe) — a restored conversation replays the
   model's real arguments.
2. **`toolCallMemory`** — calls this driver instance streamed, capped at
   `TOOL_CALL_MEMORY` (256) entries and evicted oldest-first.
3. **`'{}'`** — last resort; the id and name are still correct.

## LoRA adapters

Adapters loaded alongside the base model appear as their own catalogue entries,
with `meta.parent` naming the base model and `meta.root` the adapter artifact. An
adapter that reports no `max_model_len` inherits its parent's, since it is served
through the base model's weights and shares its sequence limit.

## Error handling

Non-2xx responses throw `{ status, body }` so the transport retry classifier
can inspect `.status` (the body is JSON-parsed when possible, else raw text).
Network-level `fetch` failures (`TypeError`) propagate uncaught. An aborted
signal yields `{ type: 'done', stopReason: 'abort' }` — checked once per read-loop
iteration.

## CORS — required for browser hosts

vLLM sends **no CORS headers by default**, so a browser page fails with an opaque
`TypeError: Failed to fetch` even when `curl` against the same address succeeds.
`curl` bypasses CORS entirely, so a passing `curl` proves nothing.

```bash
vllm serve <model> --allowed-origins '["http://localhost:5173"]'
```

Diagnose by checking for the header, not the status:

```bash
curl -s -D - -o /dev/null -H "Origin: http://localhost:5173" \
  http://localhost:8000/v1/models | grep -i access-control \
  || echo "NO CORS HEADERS — the browser will block this"
```

## Credentials

Credentials are **forwarded, never resolved**. `VLLMOptions.headers`
are sent with outbound requests; the driver never
reads an environment variable or a file. A vLLM server started without
`--api-key` accepts every request unauthenticated, so `headers` defaults to `{}`.

```ts
new VLLM({ headers: { Authorization: "Bearer <key>" } });
```

## Connection lifecycle events

`VLLM extends EventTarget`, so a host can drive it through the same code path as
every other HTTP driver:

| Event        | Detail                                       | When                             |
| ------------ | -------------------------------------------- | -------------------------------- |
| `connect`    | `{ models: ModelInfo[] }`                    | successful `listModels()`        |
| `disconnect` | —                                            | `disconnect()` (host intent)     |
| `error`      | `{ error, phase: 'listModels' \| 'embed' }`  | either call fails; then rethrows |

`disconnect()` performs no network I/O — the transport is stateless — but clears
`capabilitiesCache`, `toolCallMemory` and `catalogueLoaded`. `chat()` does not
emit `'error'` (it is an async generator), matching the other drivers.

Typed `addEventListener` overloads come from a declaration-merged `VLLM`
interface backed by `VLLMEventMap`.

## `embed()`

`POST /v1/embeddings`, meaningful only against a server started for an embedding
task (`vllm serve <model> --task embed`). Rows are sorted by the response's
explicit `index` rather than arrival order, so results line up positionally with
`request.input`. `outputTokens` is hardcoded to `0` when usage is reported —
embedding calls have no output-token concept, and the shared `Usage` type
requires both fields.

Calling it for a non-embedding model still forwards the request; gatekeeping
which models may embed is a host/kernel concern, not the driver's.

## See also

- [`openai-driver.md`](./openai-driver.md) — the closest sibling; same SSE shape,
  different metadata story.
- [`lmstudio-driver.md`](./lmstudio-driver.md) — the other SSE driver.
- [`ollama-driver.md`](./ollama-driver.md) — NDJSON instead of SSE.
- [`../core/drivers.md`](../core/drivers.md) — the driver contract itself.
- `src/plugins/vllm/README.md` — consumer-facing quick start.
