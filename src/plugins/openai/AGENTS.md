# `src/plugins/openai/` — OpenAI driver plugin

## Purpose & scope

The OpenAI driver plugin — talks to the OpenAI platform (or any OpenAI-compatible
gateway) over plain `fetch`, using the public `/v1/*` REST API. Implements
`BHZAIDriver` (from `src/types/driver.ts`) with no environment-specific bindings,
so it runs in any runtime that has `fetch` (browser, Node, Electron).

Shares the LM Studio driver's posture (ARCHITECTURE.md § 10.3): no peer
dependency, no engine injection, web-standard APIs only, OpenAI-shaped JSON over
Server-Sent Events. The official `openai` SDK is deliberately NOT used — it would
have to be a peer dependency and injected, and the three endpoints this driver
needs are a plain `fetch` away.

## Key files

- `index.ts` — subpath entry. Exports the `OpenAI` class (extends `EventTarget`,
  implements `BHZAIDriver`), `OpenAIOptions`, `OpenAIEventMap`, the
  `OpenAIModelType` modality union, and the internal `OpenAIInternalOptions`
  (test-injection seam for `fetch`).
- `index.test.ts` — 63 tests covering SSE stream parsing, streamed tool-call
  accumulation (including parallel calls and the missing-id fallback), the
  assistant `tool_calls` reconstruction, `listModels()` mapping and modality
  tagging, `capabilities()` resolution (gateway declarations, families,
  fine-tunes, namespaced ids, host overrides), the catalogue-poll budget, cache, `embed()` request/response mapping and index ordering, request-body
  mapping (system prompt, tools, params, `reasoning_effort`), non-2xx error
  handling, abort handling, and connection lifecycle events. Uses a hand-written
  fake `fetch` injected via `OpenAIInternalOptions.fetchOverride`.
- `README.md` — consumer-facing usage guide with examples.

## Conventions

- **`/v1` is the only surface there is.** Unlike LM Studio (which exposes a
  metadata-rich native API next to its OpenAI-compatible one), OpenAI publishes a
  single catalogue endpoint whose model object is
  `{ id, object, created, owned_by }`. There is nothing richer to prefer, which
  is why capabilities are inferred against OpenAI itself (below). Gateways serving
  the same path may add fields, and those are read when present.
- **No peer deps**: like `ollama/` and `lmstudio/`, this plugin needs only
  `fetch`.
- **Declaration beats inference.** api.openai.com declares nothing, so
  `streaming`/`toolCalls`/`reasoning`/`embeddings` are inferred from the model id
  via `classifyModel()` and `REASONING_PREFIXES`. OpenAI-compatible **gateways**
  commonly enrich the same endpoint, and those fields win when present:
  `supported_parameters` (→ `toolCalls`/`reasoning`, with an explicit empty array
  meaning "nothing", as in the LM Studio driver) and `context_length` /
  `top_provider.context_length` (→ `contextWindow`). Verified against a live
  OpenRouter catalogue: 337/337 models report a context length that the
  family table alone would have missed entirely.
- **Ids are normalized before any id-based test**, by `familyKeys()`: fine-tunes
  through `baseModelId()`, and vendor-namespaced gateway ids (`openai/gpt-5-mini`)
  by also matching their last path segment. Without that, every OpenRouter id
  fails every prefix test and all inference silently degrades. The id itself is
  never rewritten — `parseModelRef` splits refs on the FIRST slash, so a
  namespaced id round-trips correctly inside a ref. Extending a family means
  touching the module constants — not the class.
- **`toolCalls` defaults to `true` for chat models on purpose** when nothing is
  declared, the same deviation the LM Studio driver documents. api.openai.com
  declares nothing, and every current OpenAI chat model supports tool calling, so
  `false` would silently strip every tool from every request. A model the cache has never seen still gets
  `false` — that is absence of data, not an inference.
- **`contextWindow` resolution order**: `OpenAIOptions.contextWindows[id]` →
  provider-reported `context_length` → `FAMILY_CONTEXT_WINDOWS`, matched
  longest-prefix (so `gpt-4o` beats `gpt-4`). Table values err LOW deliberately:
  under-reporting makes compaction fire early, over-reporting lets a conversation
  exceed the real limit and fail. A model matching no family reports `undefined`,
  which disables auto-compaction for it.
- **`meta.type` tags the modality.** The catalogue mixes chat with audio, image,
  moderation and embedding models. All are returned — filtering is a host
  decision — and `example/src/lib/models.ts` keeps only the conversational ones.
  An unrecognized id is classified `'chat'`, so a newly released model appears
  rather than being hidden.
- **`availability` is always `'ready'`.** A hosted model is usable the moment the
  key can see it; models the key cannot reach are absent from the response rather
  than listed as `'unavailable'`.
- **Tool loops are RECONSTRUCTED, and this is the driver's most load-bearing
  deviation from `{ role, content }` mapping.** OpenAI rejects a `role: 'tool'`
  message that lacks a `tool_call_id` or whose preceding assistant message does
  not advertise that id in `tool_calls`. The kernel records the id on the
  tool-result message's `meta.toolCallId` but does NOT record the calls on the
  assistant message, so `mapMessages()`/`attachToolCall()` rebuild them: append to
  the preceding assistant message, or splice in a synthetic one. Arguments come
  from three sources in order: the assistant message's own `meta.toolCalls`
  record (`ToolCallRecord[]`, written by the agent loop for exactly this purpose
  and snapshot-safe — read via `readToolCallRecords()`), then `toolCallMemory`
  (populated as `chat()` emits each `tool-call`, capped at `TOOL_CALL_MEMORY`
  entries, evicted oldest-first), then `'{}'`. `attachToolCall()` skips any id the
  assistant message already advertises, so the two paths never double up.
- **Connection lifecycle events**: `OpenAI extends EventTarget` and dispatches the
  same three web-standard events as the other HTTP drivers, so a host can drive
  all of them from one code path:
  - `'connect'` — `CustomEvent<{ models: ModelInfo[] }>` at the end of a
    successful `listModels()`.
  - `'disconnect'` — `Event` dispatched by the public `disconnect()` method. The
    transport is stateless, so this is a host-intent signal, not a teardown; it
    also clears `capabilitiesCache`, `toolCallMemory` and `catalogueLoaded`.
  - `'error'` — `CustomEvent<{ error: unknown; phase: 'listModels' | 'embed' }>`
    when either call fails. The original error is always re-thrown.
  Typed `addEventListener` overloads come from a declaration-merged `OpenAI`
  interface backed by `OpenAIEventMap`. `chat()` does not emit `'error'` (it's an
  async generator), matching the other drivers.
- **Capabilities cache**: `capabilities(model)` is synchronous per the
  `BHZAIDriver` interface, but `/v1/models` is async. Resolved the same way the LM
  Studio driver does it — an internal `Map<string, DriverCapabilities>` populated
  by `listModels()`/`chat()`, with conservative defaults when a model has no
  entry. One catalogue request populates every model at once.
- **`chat()` polls the catalogue AT MOST ONCE per connection**, tracked by
  `catalogueLoaded` rather than by a per-model cache miss. A model absent from a
  catalogue that loaded fine is legitimately absent (gateways serve models they
  do not list; some return an empty `data` array), so keying off the miss re-polls
  `/v1/models` before every single `chat()` call and never succeeds. A FAILED
  fetch does not set the flag, so it retries; `listModels()` always re-fetches;
  `disconnect()` re-arms it.
- **Tool calls are accumulated, then emitted once.** Fragments arrive keyed by
  `index`; the driver assembles them and emits one `tool-call` `DriverEvent` per
  index at stream end, in index order. It does NOT emit `tool-call-delta` —
  `agent-loop.ts` filters those out anyway.
- **Stop-reason override**: a turn that produced tool calls reports
  `stopReason: 'tool-calls'` even when the stream closes with
  `finish_reason: 'stop'`, which compatible gateways do; treating that as a
  natural stop would strand the buffered calls unexecuted.
- **Parameter names follow the current API**: `max_completion_tokens` (not the
  deprecated `max_tokens`, which reasoning models reject) and `reasoning_effort`
  (gated on `capabilities().reasoning`; `'off'` maps to `'none'`).
- **`delta.refusal` is surfaced as ordinary `delta` text**, so a refused turn does
  not render as an empty assistant message.
- **Error shape**: non-2xx responses throw `{ status, body }`-shaped errors so the
  retry classifier can inspect `.status` (401 for a bad key, 429 for rate limits).
  Network-level `fetch` failures propagate uncaught.
- **Credential resolution** (§ 10.4) is the host's job, not this plugin's.
  `OpenAIOptions.headers` (default `{}`) are forwarded on every request. The
  driver never reads `process.env.OPENAI_API_KEY` or any file. Unlike the local
  drivers, omitting the header is not a working configuration — api.openai.com
  401s every unauthenticated request.

## Consumers

- `src/index.ts` re-exports this entry.
- `tsup.config.ts` builds it to `dist/plugins/openai/index.js` + `.d.ts`.
- `example/src/app/provider-controller.ts` instantiates it alongside `Ollama` and
  `LMStudio` when the user adds an OpenAI provider in the demo's providers panel;
  `example/src/lib/models.ts` filters its non-chat models out of the picker.
- Hosts import `@bhzai/core/plugins/openai` and pass the driver to
  `bh.addDriver()`.
