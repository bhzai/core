# LM Studio driver plugin

> Subpath: `@bhzai/core/plugins/lmstudio`

A `BHZAIDriver` that runs your prompts against a local (or remote)
[LM Studio](https://lmstudio.ai) server. Plain `fetch` only — no peer
dependency, no engine to inject, works in any fetch-capable runtime (browser,
Node, Electron).

## Prerequisites

Start LM Studio's server (Developer tab → **Start Server**, or `lms server
start`). It listens on `http://localhost:1234` by default. Load or download at
least one model; LM Studio JIT-loads an idle model on the first request that
names it.

Calling it **from a browser page** also needs CORS enabled in LM Studio's
Developer settings, otherwise the request fails with an opaque
`TypeError: Failed to fetch`.

## Usage

```typescript
import { BHZAI } from "@bhzai/core"
import { LMStudio } from "@bhzai/core/plugins/lmstudio"

const bh = new BHZAI()

bh.addDriver(
  new LMStudio({
    baseUrl: "http://localhost:1234", // default — the server ROOT, not /api/v0
    headers: {},                      // default — LM Studio needs no auth locally
  }),
)

await bh.init()

const conversation = await bh.createConversation({
  model: "lmstudio/meta-llama-3.1-8b-instruct",
})
await conversation.sendMessage("Say hello in one sentence.")
```

`baseUrl` is the server **root**. The driver appends `/api/v0/…` itself, so
passing `http://localhost:1234/api/v0` would produce a doubled path.

### Options

```typescript
interface LMStudioOptions {
  /** Server root. Default: 'http://localhost:1234'. */
  baseUrl?: string
  /** Headers forwarded on every request (e.g. Authorization). Default: {}. */
  headers?: Record<string, string>
}
```

Use `headers` when the server sits behind auth — LM Studio's optional API token
is opt-in, and remote deployments are usually proxied:

```typescript
new LMStudio({
  baseUrl: "https://lmstudio.internal",
  headers: { Authorization: `Bearer ${token}` },
})
```

Per ARCHITECTURE.md § 10.4 these are "runtime values passed in driver options",
the highest-priority tier of the credential chain. The driver forwards them; it
never reads files or environment variables itself.

## Listing models

```typescript
const models = await bh.listModels()
// [{ ref: 'lmstudio/meta-llama-3.1-8b-instruct',
//    driver: 'lmstudio',
//    id: 'meta-llama-3.1-8b-instruct',
//    capabilities: { streaming: true, toolCalls: true, reasoning: false,
//                    embeddings: false, contextWindow: 131072 },
//    availability: 'ready',
//    meta: { type: 'llm', publisher: 'lmstudio-community', arch: 'llama',
//            quantization: 'Q4_K_M', compatibilityType: 'gguf',
//            state: 'not-loaded', maxContextLength: 131072 } }, …]
```

Every listed model is `availability: 'ready'`. LM Studio's `state` field
(`'loaded'` vs `'not-loaded'`) is about whether the model is resident in memory,
not whether it is usable — an idle model is loaded on demand — so the raw value
is surfaced under `meta.state` instead.

## Tool calling

Tools are forwarded only when `capabilities(model).toolCalls` is `true`. LM
Studio streams a tool call's arguments in fragments; the driver assembles them
and emits one `tool-call` event per call once the stream ends, so tool plugins
and MCP servers work unchanged:

```typescript
import { createMcpPlugin } from "@bhzai/core/plugins/mcp"

const mcp = createMcpPlugin()
bh.use(mcp.plugin)
await bh.init()
await bh.addMcp({ url: "http://localhost:3000/mcp" })

// MCP tools are now advertised to the LM Studio model on every turn.
```

## Embeddings

```typescript
const { embeddings, usage } = await bh.embed({
  model: "lmstudio/text-embedding-nomic-embed-text-v1.5",
  input: ["hello", "world"],
})
```

Models whose `type` is `embeddings` report `capabilities.embeddings === true`.
Results are ordered to line up positionally with `input`.

## Reasoning models

Models that stream thinking on a separate channel (`reasoning_content`) surface
it as `reasoning-delta` events, which the conversation layer routes to
`message.delta` with `kind: 'reasoning'`. Models that instead wrap thinking in
inline `<think>` tags are handled by the conversation's `parseThink` option:

```typescript
const conversation = await bh.createConversation({
  model: "lmstudio/qwen3-8b",
  parseThink: true,
})
```

## Connection lifecycle events

`LMStudio` extends `EventTarget`, so a host can show connection state without
reaching into driver internals — the same surface the Ollama driver exposes:

```typescript
const driver = new LMStudio({ baseUrl })

driver.addEventListener("connect", (event) => {
  console.log(`connected, ${event.detail.models.length} models`)
})
driver.addEventListener("error", (event) => {
  console.error(`${event.detail.phase} failed`, event.detail.error)
})

// Probe before registering, so a dead server never enters the catalogue.
try {
  await driver.listModels()
  bh.addDriver(driver)
} catch {
  // The 'error' event already fired with the details.
}

driver.disconnect() // clears the capabilities cache, fires 'disconnect'
```

`disconnect()` is a host-intent signal: the transport is stateless HTTP, so
there is no socket to close.

## Endpoints used

| Method | Endpoint | Used by |
|---|---|---|
| `chat(request)` | `POST /api/v0/chat/completions` | SSE streaming |
| `listModels()` | `GET /api/v0/models` | also fills the capabilities cache |
| `capabilities(model)` | — (cached) | synchronous read |
| `embed(request)` | `POST /api/v0/embeddings` | `{ embeddings, usage? }` |

## See also

- [`docs/plugins/lmstudio-driver.md`](../../../docs/plugins/lmstudio-driver.md) —
  full reference, including the capability-mapping table and error semantics.
- [`docs/plugins/ollama-driver.md`](../../../docs/plugins/ollama-driver.md) —
  the sibling local-HTTP driver.
