# `@bhzai/core/plugins/vllm`

A `BHZAIDriver` for [vLLM](https://docs.vllm.ai)'s OpenAI-compatible server.
Plain `fetch` — no SDK, no peer dependency — so it runs in any fetch-capable
runtime (browser, Node, Electron).

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

## Why not just point the OpenAI driver at vLLM?

You can — vLLM is OpenAI-compatible and `new OpenAI({ baseUrl })` mostly works.
This driver exists because three things differ in ways that matter:

1. **`driver.id`.** `bh.addDriver()` shadows by id, so an `OpenAI` instance
   aimed at vLLM and another aimed at api.openai.com cannot both be live. With
   `id === 'vllm'` you can run both at once.
2. **vLLM declares its context window.** `GET /v1/models` returns
   `max_model_len` per model — a real number off the wire, where the OpenAI
   driver has to guess from a model-id family table. This matters beyond
   display: auto-compaction is disabled for a model that reports no
   `contextWindow`.
3. **Reasoning arrives on a different field.** Current vLLM streams thinking
   text as `delta.reasoning`; the OpenAI driver only reads
   `delta.reasoning_content`, so reasoning would be dropped. This driver reads
   both.

## Options

| Option      | Type                     | Default                   | Notes                                                        |
| ----------- | ------------------------ | ------------------------- | ------------------------------------------------------------ |
| `baseUrl`   | `string`                 | `http://localhost:8000`   | The server **root** — the driver appends `/v1/…` itself.      |
| `headers`   | `Record<string, string>` | `{}`                      | Forwarded on every request. Only needed with `--api-key`.     |
| `toolCalls` | `boolean`                | `true` for non-embeddings | Force the tool-call capability. See below.                    |
| `reasoning` | `boolean`                | `false`                   | Force the reasoning capability. See below.                    |
| `prefixProvider` | `boolean`           | `false`                   | Prepend `'vllm/'` to the model name on the wire. See below.   |

### Why `toolCalls` and `reasoning` are overridable

vLLM serves tool calls only when launched with
`--enable-auto-tool-choice --tool-call-parser <parser>`, and emits separated
reasoning only with `--reasoning-parser <parser>`. **Neither flag is visible on
the wire**, so the driver has to pick a default:

- **`toolCalls` defaults to `true`** for non-embedding models. Defaulting to
  `false` would silently strip every tool from every request against a correctly
  configured server — a silent failure. Defaulting to `true` against a server
  *without* the flags produces a loud 400 that names the missing flag. If you
  know your server has no tool-call parser, set `toolCalls: false`.
- **`reasoning` defaults to `false`**, since a server with no reasoning parser
  is the common case and the flag only gates whether hosts offer a thinking
  control.

```ts
new VLLM({
  baseUrl: "http://localhost:8000",
  toolCalls: false, // server started without --enable-auto-tool-choice
  reasoning: true, // server started with --reasoning-parser deepseek_r1
});
```

### Model name on the wire (`prefixProvider`)

The kernel passes the **bare model id** (e.g. `meta-llama/Llama-3.1-8B-Instruct`)
as `ChatRequest.model` — not the qualified `vllm/<model>` ref. A stock vLLM
server expects exactly what `GET /v1/models` published (the bare id), so the
default is `prefixProvider: false` and the bare id is sent directly.

Set `prefixProvider: true` only when pointing at a gateway that keys its model
registry by the qualified ref:

```ts
new VLLM({
  baseUrl: "https://my-gateway.example.com",
  prefixProvider: true, // send 'vllm/meta-llama/...' instead of 'meta-llama/...'
});
```

## Endpoints used

| Method | Path                   | Used by                            |
| ------ | ---------------------- | ---------------------------------- |
| `GET`  | `/v1/models`           | `listModels()`, `capabilities()`   |
| `POST` | `/v1/chat/completions` | `chat()` (SSE streaming)           |
| `POST` | `/v1/embeddings`       | `embed()`                          |

## Capabilities

| Flag            | Source                                                                |
| --------------- | --------------------------------------------------------------------- |
| `streaming`     | Always `true`.                                                        |
| `toolCalls`     | `options.toolCalls`, else `true` for non-embedding models.             |
| `reasoning`     | `options.reasoning`, else `false`.                                     |
| `embeddings`    | Inferred from the model id (`embed`, `bge-`, `gte-`, `e5-`, `nomic-embed`). |
| `contextWindow` | `max_model_len`, verbatim. A LoRA adapter inherits its parent's value. |

`capabilities()` is synchronous (per `BHZAIDriver`) and reads a cache filled by
`listModels()`/`chat()`. A model it has never seen returns conservative defaults
rather than throwing.

## Reasoning

vLLM has no `reasoning_effort` parameter — thinking is toggled through the
model's chat template. BHZAI's six-level `params.reasoning` scale collapses to a
boolean, and both spellings in circulation are sent:

```jsonc
// params.reasoning: "high"  ->
{ "chat_template_kwargs": { "enable_thinking": true, "thinking": true } }
```

`enable_thinking` is the Qwen3 convention, `thinking` is Granite's; a template
that uses neither ignores both. The kwargs are sent only when `params.reasoning`
is explicitly set, so they never appear on an ordinary request.

Separated reasoning text is emitted as `reasoning-delta` events. A server with
no `--reasoning-parser` leaves `<think>` tags inline in the content stream —
that is the conversation layer's `parseThink` option to handle, not the
driver's.

## Tool calls

Streamed fragments are accumulated by `index` and emitted as one `tool-call`
event per call at stream end (never `tool-call-delta`, which the agent loop
discards). A turn that produced tool calls always reports
`stopReason: 'tool-calls'`, even when vLLM closes it with
`finish_reason: 'stop'` — several of its tool-call parsers do exactly that, and
trusting it would leave the calls unexecuted.

Multi-iteration tool loops are reconstructed: vLLM renders the conversation
through the model's Jinja chat template, which pairs a `tool` message to the
`tool_calls` on the assistant turn before it. The kernel does not record those
on the assistant message, so the driver rebuilds them from
`meta.toolCalls`, then from its own memory of calls it streamed, then from `{}`.

## LoRA adapters

Adapters loaded alongside the base model appear as their own catalogue entries,
carrying `meta.parent` (the base model) and `meta.root` (the adapter artifact).
An adapter that reports no `max_model_len` inherits its parent's.

## CORS — required for browser hosts

vLLM sends **no CORS headers by default**, so a browser page fails with an
opaque `TypeError: Failed to fetch` even when `curl` against the same address
works. Start the server with the origins you serve the page from:

```bash
vllm serve <model> --allowed-origins '["http://localhost:5173"]'
```

Verify before debugging anything else — `curl` bypasses CORS entirely, so a
passing `curl` proves nothing:

```bash
curl -s -D - -o /dev/null -H "Origin: http://localhost:5173" \
  http://localhost:8000/v1/models | grep -i access-control \
  || echo "NO CORS HEADERS — the browser will block this"
```

## Authentication

A server started with `--api-key <key>` expects a bearer token. Credentials are
**forwarded, never resolved** (ARCHITECTURE.md § 10.4) — the driver never reads
an environment variable or a file:

```ts
new VLLM({ headers: { Authorization: "Bearer <key>" } });
```

## Errors

Non-2xx responses throw `{ status, body }` so the kernel's retry classifier can
read `.status`. Network-level `fetch` failures propagate uncaught. An aborted
signal yields `{ type: 'done', stopReason: 'abort' }`.

## Connection lifecycle events

`VLLM extends EventTarget` and dispatches three events, so a host can drive it
through the same code path as every other HTTP driver:

| Event        | Detail                                          | When                            |
| ------------ | ----------------------------------------------- | ------------------------------- |
| `connect`    | `{ models: ModelInfo[] }`                       | successful `listModels()`       |
| `disconnect` | —                                               | `disconnect()` (host intent)    |
| `error`      | `{ error, phase: 'listModels' \| 'embed' }`     | either call fails; then rethrows |

```ts
const driver = new VLLM();
driver.addEventListener("connect", (e) => console.log(e.detail.models.length));
driver.addEventListener("error", (e) => console.error(e.detail.phase, e.detail.error));
```

## Embeddings

Only meaningful against a server started for an embedding task
(`vllm serve <model> --task embed`). Results are ordered by the response's
`index` field, so they line up positionally with the input array.

```ts
const { embeddings } = await driver.embed({ model: "BAAI/bge-large-en-v1.5", input: ["a", "b"] });
```
