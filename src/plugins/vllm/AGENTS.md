# `src/plugins/vllm/` — vLLM driver plugin

## Purpose & scope

The vLLM driver plugin — talks to a self-hosted [vLLM](https://docs.vllm.ai)
OpenAI-compatible server over plain `fetch`, using its `/v1/*` REST API.
Implements `BHZAIDriver` (from `src/types/driver.ts`) with no
environment-specific bindings, so it runs in any runtime that has `fetch`
(browser, Node, Electron).

Shares the LM Studio and OpenAI drivers' posture (ARCHITECTURE.md § 10.3): no
peer dependency, no engine injection, web-standard APIs only, OpenAI-shaped JSON
over Server-Sent Events.

**Why this exists separately from `openai/`**, which can already be pointed at a
vLLM server via `baseUrl` — three concrete differences, in order of weight:

1. **`driver.id`.** `bh.addDriver()` shadows by id, so an `OpenAI` instance
   aimed at vLLM and one aimed at api.openai.com cannot both be live. `'vllm'`
   lets a host run both.
2. **`max_model_len`.** vLLM reports a real per-model context window; the OpenAI
   driver falls back to an id-prefix family table that has no entry for an
   arbitrary HuggingFace repo id. A model reporting no `contextWindow` has
   auto-compaction disabled (`src/conversation/agent-loop.ts`), so this is
   behavioral, not cosmetic.
3. **`delta.reasoning`.** Current vLLM names the separated-thinking channel
   `reasoning`; the OpenAI driver reads only `reasoning_content`, so reasoning
   output would be silently dropped.

## Key files

- `index.ts` — subpath entry. Exports the `VLLM` class (extends `EventTarget`,
  implements `BHZAIDriver`), `VLLMOptions`, `VLLMEventMap`, the `VLLMModelType`
  modality union, and the internal `VLLMInternalOptions` (test-injection seam
  for `fetch`).
- `index.test.ts` — 51 tests covering SSE stream parsing, both reasoning field
  names, streamed tool-call accumulation (fragmented, parallel, missing id),
  assistant `tool_calls` reconstruction, `listModels()` mapping and LoRA
  lineage, `capabilities()` resolution and overrides, `embed()` request/response
  mapping and index ordering, request-body mapping (system prompt, tools,
  params, `chat_template_kwargs`), non-2xx error handling, abort handling, and
  connection lifecycle events. Uses a hand-written fake `fetch` injected via
  `VLLMInternalOptions.fetchOverride`.
- `README.md` — consumer-facing usage guide with examples.

## Conventions

- **`/v1` is the only surface vLLM has**, but it is NOT metadata-poor the way
  api.openai.com's is: vLLM extends the standard model object with
  `max_model_len`, `root` and `parent`. All three are read. There is nothing
  richer to prefer.
- **No peer deps**: like `ollama/`, `lmstudio/` and `openai/`, this plugin needs
  only `fetch`. `globalThis.fetch` is `.bind(globalThis)`-ed in the constructor —
  storing it unbound and calling it as a property makes `this` the driver
  instance, which native fetch rejects with "Illegal invocation".
- **Two capabilities are server-launch flags, invisible on the wire.** Tool
  calling needs `--enable-auto-tool-choice --tool-call-parser`; separated
  reasoning needs `--reasoning-parser`. Nothing in `/v1/models` reports either,
  so both are guesses with explicit `VLLMOptions` escape hatches
  (`toolCalls`, `reasoning`).
- **`toolCalls` defaults to `true` for non-embedding models on purpose** — the
  same deviation the LM Studio and OpenAI drivers document. `false` would
  silently strip every tool from every request against a correctly configured
  server; `true` against a misconfigured one produces a loud 400 naming the
  missing flag. A model the cache has never seen still gets `false` — that is
  absence of data, not an inference.
- **`contextWindow` comes off the wire**, not from a table: `max_model_len`
  verbatim. A LoRA adapter that omits it inherits its `parent`'s value, since it
  is served through the base model's weights and shares its sequence limit.
- **`meta.type` tags the modality**, inferred from the id via `classifyModel()`
  and `EMBEDDING_MARKERS`, because vLLM never reports its serving task. An
  unrecognized id is classified `'chat'`, so a chat model is never wrongly
  hidden from a picker; `example/src/lib/models.ts` filters on this field.
- **`availability` is always `'ready'`.** vLLM loads its model into GPU memory at
  startup and only begins serving afterwards, so anything listed is usable now.
  There is no warm-up state to report, unlike LM Studio's `not-loaded`.
- **Reasoning is a chat-template kwarg, not an effort enum.** vLLM has no
  `reasoning_effort`. The six-level `params.reasoning` scale collapses to a
  boolean (Ollama's `think` posture) and is sent as
  `chat_template_kwargs: { enable_thinking, thinking }` — the Qwen3 and Granite
  spellings respectively; an unused kwarg is inert in Jinja. Sent only when the
  host explicitly set `params.reasoning`, and deliberately NOT gated on
  `capabilities().reasoning`, which defaults `false` precisely because the
  server flag is undetectable — gating on it would make the control dead against
  every default configuration.
- **Both reasoning field names are read**: `delta.reasoning` (current) then
  `delta.reasoning_content` (older builds and forks). Inline `<think>` tags are
  left in the content stream for the conversation layer's `parseThink`; the
  driver never strips tags.
- **Tool loops are RECONSTRUCTED**, the same way the OpenAI driver does it and
  for a related reason: vLLM renders through the model's Jinja chat template,
  whose tool templates read `tool_calls` off the assistant turn and pair a
  `tool` message to it by id. The kernel does not record the calls on the
  assistant message, so `mapMessages()`/`attachToolCall()` rebuild them —
  arguments from `meta.toolCalls` (`ToolCallRecord[]`, snapshot-safe), then
  `toolCallMemory` (capped at `TOOL_CALL_MEMORY`, evicted oldest-first), then
  `'{}'`.
- **Tool calls are accumulated, then emitted once.** Fragments arrive keyed by
  `index`; one `tool-call` `DriverEvent` per index is emitted at stream end, in
  index order. Never `tool-call-delta` — `agent-loop.ts` filters those out.
- **Stop-reason override**: a turn that produced tool calls reports
  `stopReason: 'tool-calls'` even when the stream closes with
  `finish_reason: 'stop'`, which several vLLM tool-call parsers do; treating it
  as a natural stop would strand the calls unexecuted.
- **`max_tokens`, not `max_completion_tokens`** — vLLM accepts both on current
  builds but only the former on older ones, and there is no reasoning-model
  exception here the way there is on api.openai.com.
- **Model name on the wire (`prefixProvider`)**: the kernel passes the BARE
  model id as `ChatRequest.model` (not the qualified `vllm/<model>` ref). A
  stock vLLM server expects exactly what `GET /v1/models` published, so the
  default (`prefixProvider: false`) sends the bare id directly via the
  `wireModel()` helper. Set `prefixProvider: true` for gateways that key their
  model registry by the qualified ref — the helper then prepends `'vllm/'`.
  The same logic applies to `embed()`.
- **Capabilities cache**: `capabilities(model)` is synchronous per the
  `BHZAIDriver` interface, but `/v1/models` is async. Resolved as in the other
  HTTP drivers — an internal `Map<string, DriverCapabilities>` filled by
  `listModels()`/`chat()`, conservative defaults on a miss, never throws.
- **`chat()` polls the catalogue AT MOST ONCE per connection**, tracked by
  `catalogueLoaded` rather than a per-model cache miss, so a model the server
  serves but does not list does not re-poll before every call. A FAILED fetch
  does not set the flag, so it retries; `listModels()` always re-fetches;
  `disconnect()` re-arms it. A metadata failure never aborts a `chat()` call.
- **Connection lifecycle events**: `VLLM extends EventTarget` and dispatches
  `'connect'` (`CustomEvent<{ models }>` after a successful `listModels()`),
  `'disconnect'` (`Event`, from the public `disconnect()`, which also clears
  `capabilitiesCache`, `toolCallMemory` and `catalogueLoaded`), and `'error'`
  (`CustomEvent<{ error, phase }>`, then re-throws). Typed `addEventListener`
  overloads come from a declaration-merged `VLLM` interface backed by
  `VLLMEventMap`. `chat()` does not emit `'error'` (it is an async generator),
  matching the other drivers.
- **Error shape**: non-2xx responses throw `{ status, body }` so the retry
  classifier can inspect `.status`. Network-level `fetch` failures propagate
  uncaught.
- **Credential resolution** (§ 10.4) is the host's job. `VLLMOptions.headers`
  (default `{}`) are forwarded on every request; the driver never reads an env
  var or a file. A server without `--api-key` works unauthenticated.
- **CORS is the usual browser failure.** vLLM sends no CORS headers by default;
  the server needs `--allowed-origins`. `curl` bypasses CORS, so a passing
  `curl` proves nothing about the browser.

## Consumers

- `src/index.ts` re-exports this entry.
- `tsup.config.ts` builds it to `dist/plugins/vllm/index.js` + `.d.ts`.
- `example/src/app/provider-controller.ts` instantiates it alongside `Ollama`,
  `LMStudio` and `OpenAI` when the user adds a vLLM provider in the demo's
  providers panel; `example/src/lib/models.ts` filters its non-chat models out of
  the picker.
- Hosts import `@bhzai/core/plugins/vllm` and pass the driver to
  `bh.addDriver()`.
