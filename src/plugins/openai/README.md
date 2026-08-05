# OpenAI driver plugin

> Subpath: `@bhzai/core/plugins/openai`

A `BHZAIDriver` that runs your prompts against the [OpenAI platform](https://platform.openai.com)
— or anything that speaks its `/v1` API (OpenRouter, Together, vLLM, LiteLLM, a
proxy of your own). Plain `fetch` only: the official `openai` SDK is deliberately
not a dependency, so this works in any fetch-capable runtime (browser, Node,
Electron) with nothing to install.

## Prerequisites

An API key from <https://platform.openai.com/api-keys>. Unlike the Ollama and LM
Studio drivers, every request here is authenticated — a driver constructed
without an `Authorization` header fails its first call with 401.

## Usage

```typescript
import { BHZAI } from "@bhzai/core"
import { OpenAI } from "@bhzai/core/plugins/openai"

const bh = new BHZAI()

bh.addDriver(
  new OpenAI({
    baseUrl: "https://api.openai.com",            // default — the API ROOT, not /v1
    headers: { Authorization: `Bearer ${apiKey}` }, // required in practice
  }),
)

await bh.init()

const conversation = await bh.createConversation({ model: "openai/gpt-4o-mini" })
await conversation.sendMessage("Say hello in one sentence.")
```

`baseUrl` is the API **root**. The driver appends `/v1/…` itself, so passing
`https://api.openai.com/v1` would produce a doubled path.

### ⚠️ Never ship an API key to a browser

This driver runs in a browser because the kernel is environment-agnostic, not
because doing so is safe. A key in page JavaScript is readable by anyone who
opens the page, and it bills your account. For a browser host, point `baseUrl` at
a server-side proxy that injects the key:

```typescript
new OpenAI({ baseUrl: "https://myapp.example/openai" }) // proxy adds the key
```

The demo in `example/` accepts a key in the providers panel because it is a local
demo; it stores that key in `localStorage` in plaintext. Use a throwaway,
spend-limited project key there.

### Options

```typescript
interface OpenAIOptions {
  /** API root. Default: 'https://api.openai.com'. */
  baseUrl?: string
  /** Headers forwarded on every request — this is where the key goes. Default: {}. */
  headers?: Record<string, string>
  /** Per-model context-window overrides, keyed by bare model id. Default: {}. */
  contextWindows?: Record<string, number>
}
```

`headers` is also where the optional organization/project scoping goes:

```typescript
new OpenAI({
  headers: {
    Authorization: `Bearer ${apiKey}`,
    "OpenAI-Organization": "org-…",
    "OpenAI-Project": "proj_…",
  },
})
```

Per ARCHITECTURE.md § 10.4 these are "runtime values passed in driver options",
the highest-priority tier of the credential chain. The driver forwards them; it
never reads files or environment variables itself — `OPENAI_API_KEY` is the
host's job to read and pass in.

## Listing models

```typescript
const models = await bh.listModels()
// [{ ref: 'openai/gpt-4o-mini',
//    driver: 'openai',
//    id: 'gpt-4o-mini',
//    capabilities: { streaming: true, toolCalls: true, reasoning: false,
//                    embeddings: false, contextWindow: 128000 },
//    availability: 'ready',
//    meta: { type: 'chat', ownedBy: 'system', created: 1721172741 } }, …]
```

Every listed model is `availability: 'ready'` — a hosted model is usable the
moment the key can see it, and models the key cannot reach are simply absent from
the response.

### The catalogue is multi-modal

`GET /v1/models` returns speech, image, moderation and embedding models
alongside the chat ones. They are all returned (filtering the catalogue is a host
decision), each tagged with an inferred `meta.type`:

| `meta.type` | Example ids |
|---|---|
| `chat` | `gpt-4o-mini`, `gpt-5`, `o3` |
| `embeddings` | `text-embedding-3-small` |
| `audio` | `whisper-1`, `tts-1`, `gpt-4o-mini-tts` |
| `image` | `dall-e-3`, `gpt-image-1`, `sora-2` |
| `moderation` | `omni-moderation-latest` |
| `completion` | `davinci-002`, `babbage-002` |

A chat UI keeps `type === 'chat'` — that is what `example/src/lib/models.ts`
does. An id matching no known modality is treated as `chat`, so a newly released
model shows up rather than being hidden.

### Using it with a gateway

```typescript
// OpenRouter: pass the API ROOT, not the /v1 endpoint.
new OpenAI({
  baseUrl: "https://openrouter.ai/api",
  headers: { Authorization: `Bearer ${openRouterKey}` },
})
```

The driver appends `/v1/models` itself, so passing
`https://openrouter.ai/api/v1` yields `/v1/v1/models` and a 404 with an HTML
body. The example's providers panel normalizes this for you — it strips a
trailing `/v1`, `/api/v0`, `/api`, `/models` or `/tags` before handing the
address to the driver — but a host calling the driver directly must pass the
root.

## Capabilities: declared if possible, inferred otherwise

Against api.openai.com the model object is `{ id, object, created, owned_by }`
and nothing more — no modality, no context length, no capability list — so every
flag has to be derived from the model id's family. Most **OpenAI-compatible
gateways enrich the same endpoint**, and a real declaration always beats a guess:

| Flag | Declared (gateway) | Inferred (api.openai.com) |
|---|---|---|
| `streaming` | — | Always `true`. |
| `toolCalls` | `supported_parameters` includes `tools` | `true` for chat models, `false` otherwise. |
| `reasoning` | `supported_parameters` includes `reasoning`/`reasoning_effort` | `true` for the `o`-series, GPT-5 and codex families. |
| `embeddings` | — | `true` for `text-embedding-*`. |
| `contextWindow` | `context_length` (or `top_provider.context_length`) | `contextWindows[id]` → family table → `undefined`. |

`contextWindows[id]` outranks everything, including a gateway's own number.

Two id shapes are normalized before any of this runs: fine-tunes
(`ft:gpt-4o-mini-2024-07-18:acme::AbC123`) resolve through their base model, and
vendor-namespaced gateway ids (`openai/gpt-5-mini`, `deepseek/deepseek-v4`) are
matched on their last path segment as well as in full. The namespaced id itself
is never rewritten — `parseModelRef` splits a ref on its first slash, so
`openai/deepseek/deepseek-v4` addresses the `deepseek/deepseek-v4` model on the
`openai` driver exactly as it should.

### Overriding `contextWindow`

The built-in family table errs low on purpose: under-reporting makes compaction
fire early, while over-reporting lets a conversation grow past the real limit and
fail. Correct or extend it per model — an exact id match always wins:

```typescript
new OpenAI({
  headers: { Authorization: `Bearer ${apiKey}` },
  contextWindows: { "my-proxied-model": 32_000 },
})
```

This matters beyond display: auto-compaction is disabled for models that report
no `contextWindow` at all. You rarely need it against a gateway — OpenRouter, for
one, reports a real `context_length` for every model it serves, and the driver
uses that.

### "Connected" is not proof the key works

The driver probes with `listModels()`, i.e. `GET /v1/models`. On api.openai.com
that requires the key, so a successful probe does validate it. **On some gateways
it does not** — OpenRouter serves `/api/v1/models` publicly, so `listModels()`
returns its full catalogue even with a garbage token and the first 401 arrives on
the first completion instead.

Validate separately if you need certainty up front. For OpenRouter:

```bash
curl -s -H "Authorization: Bearer $KEY" https://openrouter.ai/api/v1/key
# valid   -> {"data":{"label":…,"usage":…}}
# invalid -> {"error":{"message":"User not found.","code":401}}
```

## Tool calling

Tools are forwarded only when `capabilities(model).toolCalls` is `true`. OpenAI
streams a tool call's arguments in fragments; the driver assembles them and emits
one `tool-call` event per call once the stream ends, so tool plugins and MCP
servers work unchanged:

```typescript
import { createMcpPlugin } from "@bhzai/core/plugins/mcp"

const mcp = createMcpPlugin()
bh.use(mcp.plugin)
await bh.init()
await bh.addMcp({ url: "http://localhost:3000/mcp" })

// MCP tools are now advertised to the OpenAI model on every turn.
```

**Multi-iteration tool loops need a rebuilt request.** OpenAI validates
conversation structure: a `role: 'tool'` message must carry a `tool_call_id` and
must follow an assistant message whose `tool_calls` contains that id, or the
request fails with 400 before the model sees it. The kernel records the id on the
tool-result message but not the calls on the assistant message, so this driver
rebuilds them when mapping the request — attaching the calls to the preceding
assistant message, or inserting a synthetic one. Arguments are replayed from the
calls this driver streamed; when it did not stream them (a conversation restored
from a snapshot, or calls made by another driver) they fall back to `{}`, which
the API accepts. No host action is needed either way.

## Embeddings

```typescript
const { embeddings, usage } = await bh.embed({
  model: "openai/text-embedding-3-small",
  input: ["hello", "world"],
})
```

Results are ordered to line up positionally with `input`.

## Reasoning models

For the `o`-series and GPT-5 families, `params.reasoning` maps onto OpenAI's
`reasoning_effort`:

```typescript
await bh.complete({
  model: "openai/o3-mini",
  prompt: "Plan a migration.",
  params: { reasoning: "high" },
})
```

The scales line up one to one, except `'off'` which becomes `'none'`. The
parameter is sent only to models whose `capabilities().reasoning` is `true`.

Two caveats that come from the platform, not this driver:

- **Reasoning models reject a custom `temperature`.** Omit `params.temperature`
  for them; the driver forwards what you pass rather than silently dropping it.
- **Reasoning text is not streamed by Chat Completions.** api.openai.com keeps
  reasoning summaries in the Responses API, so no `reasoning-delta` events arrive
  from OpenAI itself. Compatible gateways that do emit `reasoning_content` are
  handled, and inline `<think>`-tag models are covered by the conversation's
  `parseThink` option.

`params.maxTokens` is sent as `max_completion_tokens` (the deprecated
`max_tokens` is rejected outright by reasoning models).

## Connection lifecycle events

`OpenAI` extends `EventTarget`, so a host can show connection state without
reaching into driver internals — the same surface the Ollama and LM Studio
drivers expose:

```typescript
const driver = new OpenAI({ headers: { Authorization: `Bearer ${apiKey}` } })

driver.addEventListener("connect", (event) => {
  console.log(`connected, ${event.detail.models.length} models`)
})
driver.addEventListener("error", (event) => {
  console.error(`${event.detail.phase} failed`, event.detail.error)
})

// Probe before registering, so a bad key never enters the catalogue.
try {
  await driver.listModels()
  bh.addDriver(driver)
} catch {
  // The 'error' event already fired with the details (401 for a bad key).
}

driver.disconnect() // clears the caches, fires 'disconnect'
```

`disconnect()` is a host-intent signal: the transport is stateless HTTPS, so
there is no socket to close.

## Endpoints used

| Method | Endpoint | Used by |
|---|---|---|
| `chat(request)` | `POST /v1/chat/completions` | SSE streaming |
| `listModels()` | `GET /v1/models` | also fills the capabilities cache |
| `capabilities(model)` | — (cached) | synchronous read |
| `embed(request)` | `POST /v1/embeddings` | `{ embeddings, usage? }` |

## See also

- [`docs/plugins/openai-driver.md`](../../../docs/plugins/openai-driver.md) —
  full reference, including the capability-inference table and error semantics.
- [`docs/plugins/lmstudio-driver.md`](../../../docs/plugins/lmstudio-driver.md) —
  the sibling SSE driver, for a local server that *does* declare its metadata.
