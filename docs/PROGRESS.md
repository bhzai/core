# BHZAI Implementation Progress

Tracks the implementation status of each task in the BHZAI framework build.
Source of truth for task files: `../tasks/` (parent repo).

## Legend

- [x] Complete — task file renamed to `TASK_XXXX[complete].md`
- [ ] Pending — task file is `TASK_XXXX.md`

## Phase 0 — Foundations

| Task | Title                      | Status |
| ---- | -------------------------- | ------ |
| 0001 | Repo scaffolding & tooling | [x]    |
| 0044 | Open-questions triage      | [x]    |
| 0002 | Core shared types          | [x]    |

## Phase 1 — Kernel core (plugins, events, config)

| Task | Title                                     | Status |
| ---- | ----------------------------------------- | ------ |
| 0003 | BHZAI kernel class + `use()` (forms 1 & 2) | [x]    |
| 0004 | Framework event bus                       | [x]    |
| 0005 | Plugin lifecycle (init/dispose ordering)  | [x]    |
| 0006 | Plugin configuration contract             | [x]    |
| 0007 | Decorator-based plugins                   | [x]    |

## Phase 2 — Tools & MCP

| Task | Title                                                 | Status |
| ---- | ----------------------------------------------------- | ------ |
| 0008 | Tool registry                                         | [x]    |
| 0009 | Driver interface & registry                           | [x]    |
| 0010 | Command registry                                      | [x]    |
| 0011 | MCP client — handshake & discovery                    | [x]    |
| 0012 | MCP client — resync, calls, progress, cancellation    | [x]    |
| 0013 | MCP client — human-in-the-loop & untrusted-by-default | [x]    |
| 0014 | MCP capabilities — elicitation, sampling, roots       | [x]    |
| 0015 | `addMcp()` + `getMcps`/`modelSource` hooks            | [x]    |
| 0016 | Deferred tool loading (`search_tools`)                | [x]    |
| 0017 | Tool availability filtering seam                      | [x]    |

## Phase 3 — Drivers & model selection

| Task | Title                                   | Status |
| ---- | --------------------------------------- | ------ |
| 0018 | Transport retry policy & request events | [x]    |
| 0019 | WebLLM driver plugin                    | [x]    |
| 0020 | Ollama driver plugin                    | [x]    |
| 0021 | Credential resolution chain             | [x]    |
| 0022 | Model selection & switching             | [x]    |

## Phase 4 — Conversations & the agent loop

| Task | Title                                                  | Status |
| ---- | ------------------------------------------------------ | ------ |
| 0023 | Conversation surface skeleton                          | [x]    |
| 0024 | `start` event & system-prompt layering                 | [x]    |
| 0025 | Agent loop core — sendMessage, context, message states | [x]    |
| 0026 | Tool execution in the loop                             | [x]    |
| 0027 | Loop termination & guardrails                          | [x]    |
| 0028 | Conversation serialization contract                    | [x]    |
| 0029 | Storage interfaces (no implementations)                | [x]    |
| 0030 | Steering & concurrent input                            | [x]    |
| 0031 | Compaction pipeline                                    | [x]    |

## Phase 5 — Kernel utilities & reference examples

| Task | Title                             | Status |
| ---- | --------------------------------- | ------ |
| 0032 | `complete()` one-shot LLM utility | [x]    |
| 0033 | `embed()` side channel            | [x]    |
| 0034 | `getContributions()` accessor     | [x]    |
| 0035 | `dispose()` teardown              | [x]    |
| 0036 | Example: Task-management plugin   | [x]    |
| 0037 | Example: Agent-memory plugin      | [x]    |
| 0038 | Example: RAG plugin (both shapes) | [x]    |

Note on plugin activation vs. TASK_0034/TASK_0035, which all landed independently
and are complementary rather than overlapping:

- `getContributions(key)` (TASK_0034) reads a **capability-object key**
  (`retriever`, `memoryStore`, …) across plugins.
- `listPlugins()` (activation) reports what each plugin **registered into the
  registries** — tools, commands, drivers, MCP servers, event handlers — plus
  its enabled state, backed by the kernel's ownership ledger.
- `dispose()` (TASK_0035) is whole-kernel teardown. Activation deliberately does
  not unregister anything: it hides a plugin's contributions so the toggle stays
  reversible and cannot fail. Per-plugin teardown is still unimplemented.

## Phase 6 — Interop, validation, docs

| Task | Title                                        | Status |
| ---- | --------------------------------------------- | ------ |
| 0039 | pi extension interop adapter                 | [x]    |
| 0040 | OpenCode plugin interop adapter              | [x]    |
| 0041 | Security hardening & threat-model checklist  | [x]    |
| 0042 | PEP mapping validation                       | [x]    |
| 0043 | Documentation & README (v0.1 scope)          | [x]    |
| 0044 | Open-questions triage                        | [x]    |

All 44 tasks (TASK_0001–TASK_0044) are now complete. See "Recently completed
(TASK_0039–TASK_0044, Phase 6)" below for the full writeup.

## Post-v0.1 work

| Item                                          | Status |
| --------------------------------------------- | ------ |
| Open message-field contract + `parseThink`    | [x]    |
| LM Studio driver plugin + example provider    | [x]    |
| OpenAI driver plugin + example provider       | [x]    |

## Recently completed (OpenAI driver plugin)

Post-v0.1. Adds a fourth bundled driver — the first hosted one — and a third
kind to the example's providers panel.

- **`src/plugins/openai/index.ts`** (new) — `OpenAI` class implementing
  `BHZAIDriver` over the public `/v1` REST API. `fetch`-only, no peer
  dependency and deliberately not the `openai` SDK. Covers `chat()` (SSE with
  fragment-accumulated tool calls), `listModels()`, a synchronous
  `capabilities()` backed by a one-request cache, `embed()`, and the
  `connect`/`disconnect`/`error` lifecycle events. Because the wire format is
  the de-facto standard, it also serves any OpenAI-compatible gateway via
  `baseUrl`.
- **Three deviations forced by a hosted multi-tenant platform**, all documented
  in the source and in `docs/plugins/openai-driver.md`:
  1. **Capabilities are inferred, not declared.** `GET /v1/models` returns
     `{ id, object, created, owned_by }` and nothing else, so modality,
     tool-calling, reasoning and embeddings are derived from the model id's
     family. `contextWindow` comes from an overridable, errs-low family table
     (`OpenAIOptions.contextWindows` wins) because reporting `undefined` would
     disable auto-compaction for the whole provider.
  2. **The catalogue is multi-modal.** Audio, image, moderation and embedding
     models are returned alongside chat ones, each tagged with `meta.type`, and
     the example filters the picker on it.
  3. **Tool loops are reconstructed.** OpenAI rejects a `role: 'tool'` message
     that lacks a `tool_call_id` or whose preceding assistant message does not
     advertise it — state the kernel does not record — so the driver rebuilds
     the pairing when mapping the request, replaying real arguments from a
     bounded memory of the calls it streamed.
- **Packaging** — new `./plugins/openai` export, `tsup` entry, and root-barrel
  re-export, per `.claude/rules/packaging.md`.
- **Example** — one `ProviderKind` entry plus one `createDriver()` case (the
  dialog and controller wiring were already kind-agnostic);
  `example/src/lib/models.ts` gained the `meta.type` filter so the picker is not
  flooded with non-chat models.
- **Docs** — `docs/plugins/openai-driver.md`, `src/plugins/openai/README.md` and
  `src/plugins/openai/AGENTS.md` (new); `README.md`, `AGENTS.md`,
  `docs/core/drivers.md`, `src/plugins/AGENTS.md`, `example/AGENTS.md` and
  `docs/examples/webllm-chat.md` updated.
- 63 tests in `src/plugins/openai/index.test.ts`, plus expanded
  `example/src/lib/models.test.ts`, `example/src/lib/provider-store.test.ts` and
  `example/src/components/providers-dialog.test.ts`.

### Follow-ups from smoke-testing the driver against a live gateway

Running `listModels()` against the real `https://openrouter.ai/api` catalogue
(337 models) surfaced four defects that unit tests against a fake `fetch` could
not have:

- **Unbounded model-refresh loop** (`src/core/bhzai.ts`) — drivers dispatch
  `'connect'` from inside `listModels()`, and a host that refreshes its picker on
  that event re-enters `bh.listModels()`, which polls every driver, which fires
  `'connect'` again. Reported in the wild as 5000+ requests against one gateway;
  reproduced at 200+ in a test. `bh.listModels()` now serializes the poll phase —
  concurrent callers join the in-flight poll — while keeping the snapshot
  short-circuit for the dispatch phase, where joining would deadlock. The example
  no longer refreshes from the `'connect'` handler either, since `addDriver()`
  already dispatches `models.changed`. **Pre-existing; it affected the Ollama and
  LM Studio providers equally.**
- **Gateway metadata was thrown away** — all 337 OpenRouter models report
  `context_length` and 270 declare `tools` in `supported_parameters`, none of
  which the driver read. It reported `contextWindow: undefined` for every one,
  silently disabling auto-compaction for the whole provider. Declarations now win
  over inference (`context_length` → `contextWindow`, `supported_parameters` →
  `toolCalls`/`reasoning`), matching the LM Studio driver's posture.
- **Namespaced ids defeated every inference** — gateway ids are vendor-prefixed
  (`openai/gpt-5-mini`), so no prefix test matched and all inference degraded to
  the conservative default. `familyKeys()` now matches the last path segment too.
  The id itself is left intact, since `parseModelRef` splits on the first slash.
- **Empty catalogues re-polled forever** — a catalogue that returns `data: []`
  never populates the per-model cache, so `chat()` re-fetched `/v1/models` before
  every call and never succeeded. The poll budget is now tracked by "did a fetch
  succeed", not by a per-model miss. `normalizeBaseUrl` also strips a trailing
  `/models` or `/tags`, since docs quote the full endpoint far more often than
  the root.

### Follow-ups from connecting a real OpenRouter provider in the example

- **A successful Connect gave no visible feedback** — `addProvider` leaves the
  user on the EDIT view (so a second Connect updates rather than duplicates), and
  that view had no status affordance at all. The row's green dot lives in the list
  view, behind the Back button, so the form looked identical before and after a
  successful connection. `_renderStatus()` now renders the same `.provider-dot` +
  a label at the top of the edit form.
- **`example/src/app/provider-controller.test.ts` (new)** — the controller had no
  test at all, which is why the gap survived. Four tests drive the real drivers
  through the add → probe → register → status pipeline against a fake `fetch`,
  asserting what the dialog is *told* to render, plus a regression test for the
  refresh storm.
- **Documented: "connected" does not validate credentials.** The probe is
  `listModels()`, and some gateways serve their catalogue publicly — OpenRouter's
  `/api/v1/models` returns 337 models with no key at all — so a bad token still
  goes green and the first 401 lands on the first message. Troubleshooting entries
  added to `docs/examples/webllm-chat.md` and the plugin README, including the
  `GET /api/v1/key` check that does validate an OpenRouter key.

### Kernel: tool calls recorded on the assistant message

`agent-loop.ts` now records each turn's tool calls on the assistant message that
made them, as `meta.toolCalls: ToolCallRecord[]` (`{ id, name, arguments }`, new
export from `src/types/message.ts`). The loop's buffer is per-iteration, so
without this the calls were unrecoverable from history — the OpenAI driver could
rebuild the `tool_call_id` pairing its provider demands, but not the arguments,
which degraded to `{}` after a snapshot restore. Plain JSON, so it round-trips
through `snapshot.ts`. The driver prefers the record, falls back to its own
streamed-call memory, then to `{}`.

## Recently completed (LM Studio driver plugin)

Post-v0.1. Adds a third bundled driver and generalizes the example's providers
panel from Ollama-only to multi-kind.

- **`src/plugins/lmstudio/index.ts`** (new) — `LMStudio` class implementing
  `BHZAIDriver` over LM Studio's native `/api/v0` REST API. `fetch`-only, no
  peer dependency, same posture as the Ollama driver (§ 10.3). Covers
  `chat()` (OpenAI-shaped SSE with fragment-accumulated tool calls),
  `listModels()`, a synchronous `capabilities()` backed by a one-request cache,
  `embed()`, and the `connect`/`disconnect`/`error` lifecycle events.
- **Packaging** — new `./plugins/lmstudio` export, `tsup` entry, and root-barrel
  re-export, per `.claude/rules/packaging.md`.
- **Example** — `provider-store.ts` gained a `ProviderKind` discriminator
  (storage key `bhzai.providers`, schema v2); `providers-dialog.ts` gained a
  working type selector with kind-aware field labels and per-row kind badges;
  `provider-controller.ts` was rewritten against a structural `ProviderDriver`
  type so both kinds share one code path.
- **Docs** — `docs/plugins/lmstudio-driver.md` and
  `src/plugins/lmstudio/README.md` (new); `docs/examples/webllm-chat.md` gained
  a "Local providers" section and two troubleshooting entries.
- 36 tests in `src/plugins/lmstudio/index.test.ts`, plus expanded
  `example/src/lib/provider-store.test.ts` and
  `example/src/components/providers-dialog.test.ts`.

## Recently completed (open message-field contract + `parseThink`)

Post-v0.1. Gives plugins a first-class way to attach typed per-message data, and
moves `<think>` parsing out of the WebLLM example and into the framework.

- **`src/core/message-fields.ts`** (new) — `MessageFieldRegistry` +
  `applyMessageFields()`. `bh.defineMessageField(name, { metaKey?, default? })`
  installs a non-enumerable accessor over one key of `message.meta`, so a
  plugin field persists through the existing snapshot channel without
  appearing as a stray key in the wire shape.
- **`src/types/message.ts`** — new `BHZAIMessageExtensions`, the module-
  augmentation target; `BHZAIMessage` extends it. Ships one member, `think`.
- **`src/conversation/message.ts`** (new) — `createMessage()`, now the single
  factory behind all four former construction sites (agent loop, system-prompt
  `prepend`, compaction summary, snapshot restore), plus `withMessageFields()`
  for the copy-with-patch path. Fixed two pre-existing divergences between the
  old factories (`append` block targeting, `setContent` signature).
- **`src/conversation/think-stream.ts`** (new) — `createThinkSplitter()`, moved
  from `example/src/lib/think-stream.js` and ported to TypeScript.
- **`CreateConversationOptions.parseThink`** (default `false`) — the agent loop
  splits `<think>` out of the driver's text stream, routing tag content to
  `message.think` / `kind: 'reasoning'` and the rest to the body /
  `kind: 'text'`. A driver's native `reasoning-delta` channel is unaffected.
- **`example/`** — deleted its own parser and now passes `parseThink: true`,
  switching on `kind` in the `message.delta` handler.

Gates: `pnpm lint`, `pnpm typecheck`, `pnpm test` (730 tests, 50 files), and
`pnpm build` all pass. Note `pnpm typecheck` requires `dist/` to exist, because
`examples/readme-quickstart.ts` imports the package by its public specifier.

## Recently completed (TASK_0039–TASK_0044, Phase 6)

Interop adapters, security audit, PEP mapping validation, and final docs —
the last phase of the v0.1 build. Summary:

- **TASK_0039** — `src/plugins/interop/pi/index.ts`: `runPiExtension()`, a
  thin shim translating pi coding-agent extensions' `ExtensionAPI` onto real
  BHZAI kernel primitives (event bus, tool/command registries, config
  contract, conversation surface). Implements all 15 non-`idle` rows of the
  §8.3 pi-column event-mapping table; TUI-bound calls (`ui`/`shortcuts`/
  `themes`/`session`) are recorded, call-site-specific no-ops. 9 tests in
  `pi-adapter.test.ts`, including a real registered-and-callable tool, a
  real `tool(beforeCall)` block-veto (spy-verified `execute` never runs),
  and the `sendMessage`/`sendUserMessage` loop-driving split exercised
  through the adapter's own shim methods (not the raw conversation API).
- **TASK_0040** — `src/plugins/interop/opencode/index.ts`:
  `runOpenCodePlugin()`, mapping an OpenCode-style plugin's returned hooks
  object (`tool`, `event`, `chat.message`/`chat.params`,
  `tool.execute.before`/`after`, `permission.ask`, `config`, `auth`) onto
  BHZAI primitives, including zod-like→JSON-Schema conversion via
  `.toJSONSchema()` and `permission.ask` composing with (never bypassing)
  the same `tool(beforeCall)` seam every other approver uses. 7 tests in
  `opencode-adapter.test.ts`, including both directions of native-approver
  vs. `permission.ask` composition (spy-verified `execute` never runs in
  either blocking direction) and a real `resolveCredentials()` call proving
  tier-1 runtime credentials outrank the adapter's tier-2 `auth` hook.
  **Also fixes GitHub issue #6**: `BHZAI.init()` now registers
  `plugin.capabilities.tools` via `addTool()` at the start of `init()` (2
  new tests in `src/core/lifecycle.test.ts`).
- **TASK_0041** — `docs/security-review.md`: audits all 5 ARCHITECTURE.md
  §13 security bullets. 4 verified against real, passing tests; 1 gap
  (bullet 1, "plugins are trusted / no sandbox" documentation) filed
  against and closed by TASK_0043. Added `src/tools/no-eval.test.ts` (a
  static regression guardrail — fails if `eval(`/`new Function`/string-arg
  `setTimeout` ever appears in `src/**`) and one test in
  `src/tools/availability.test.ts` proving untrusted MCP tool annotations
  never affect the `trusted` availability flag.
- **TASK_0042** — `docs/pep-mapping-validation.md`: validates all 12 rows
  of ARCHITECTURE.md §14's PEP (#1338) mapping table against real tests;
  11 verified, 1 (`Wait/continuation`, #1390) correctly marked out of scope
  for v0.1 per the roadmap. Cross-references TASK_0041's bullet 4 for the
  local-tool-blocking overlap rather than re-filing it.
- **TASK_0043** — `README.md` rewritten to reflect the finished v0.1
  framework (security callout, real shipped subpaths, 12-item v0.1
  scope list, doc pointers); `examples/readme-quickstart.ts`/`.test.ts`
  added (a real, runnable quickstart against a mocked Ollama HTTP layer,
  asserting genuinely non-empty response content); TSDoc pass over the
  public kernel API; closes the TASK_0041 bullet-1 gap (security callout
  in the README + `BHZAI.use()`'s TSDoc). **Also fixes GitHub issue #5**:
  `BHZAIConversationImpl.toJSON()` now delegates to `snapshot.ts`'s
  `toSnapshot()` instead of inlining a duplicate copy.
- **TASK_0044** — `docs/open-questions.md`: logs the 2 already-resolved
  ARCHITECTURE.md §16 items (decorator flavor, compaction summarizer
  ownership) plus decisions on all 4 open items (event granularity,
  package name, prompt-injected tool fallback — explicitly ratifying/
  extending TASK_0017's actual (non-)implementation, OAuth auth-line
  deferral).

18 new tests added across `src/plugins/interop/pi/pi-adapter.test.ts` (9),
`src/plugins/interop/opencode/opencode-adapter.test.ts` (7),
`src/core/lifecycle.test.ts` (2), `src/tools/no-eval.test.ts` (3),
`src/tools/availability.test.ts` (1), and
`examples/readme-quickstart.test.ts` (1) — note some of these were fixed
in place after an independent gate re-verification found several
originally-shipped tests were not load-bearing (weak assertions that
passed regardless of whether the underlying behavior worked); every test
now in the suite has been confirmed to actually fail when its
corresponding implementation is reverted (593 → 616). All four gates
(`typecheck`/`lint`/`test`/`build`) green.

GitHub issues #4, #5, #6 (filed during Phase 4/5 review) are resolved:
#5 and #6 fixed with passing tests (see above); #4 (system-prompt
`systemPrompt`/`appendSystemPrompt` patch-ordering across handlers) was
investigated and left open with a detailed comment explaining why a
correct fix requires either a new order-preserving `EventBus` primitive or
a breaking change to the `StartEventPatch` contract — out of scope for a
"small guardrail" fix late in the project; recommended as its own
follow-up task.

## Recently completed (TASK_0023–TASK_0031, Phase 4)

Conversations & the agent loop — see `docs/core/conversation.md` for the full
writeup. Summary:

- **TASK_0023** — `BHZAIConversationImpl` (`src/conversation/conversation.ts`):
  the conversation surface, its private mirrored `EventBus`, `bh.createConversation`/
  `bh.loadConversation`.
- **TASK_0024** — `src/conversation/system-prompt.ts`: the `start` event,
  four-layer system-prompt assembly, `prepend` message handling.
- **TASK_0025** — `src/conversation/agent-loop.ts`: `sendMessage()`/
  `addMessage()`, the `context` event (deep-copied payload), streaming
  `message.delta`, the non-tool-calls exit path.
- **TASK_0026** — tool execution in the loop: `beforeCall→call→processing*→
  complete|error`, concurrent-by-default batching with `serial`/`serialTools`
  opt-outs, original-call-order result reordering, validate-and-repair
  (`maxToolRepairs`, default 2).
- **TASK_0027** — the bounded, multi-turn loop: `maxIterations` (default 8),
  the universal `_meta['BHZAI/terminate']` hint, `turn(end)` veto via
  `continueWith`, real `abort()` semantics via a shared root `AbortController`.
- **TASK_0028** — `src/conversation/snapshot.ts`: the full versioned
  `{ v: 1, id, messages, model, params, usage, meta }` snapshot contract,
  truncated-prefix loading (host-side forking enablement).
- **TASK_0029** — `src/types/storage.ts` + `src/core/storage.ts`:
  `ConversationStore`/`MemoryStore`/`SkillResolver` interfaces (no
  implementations), auto-save on `message(sent)`, `bh.conversations.list()`.
- **TASK_0030** — `deliverAs: 'immediate' | 'steer' | 'followUp'`
  (`ConversationBusyError`, steer/followUp queues), real `waitForIdle()`,
  the `idle` event.
- **TASK_0031** — `src/conversation/compaction.ts`: `conversation.compact()`,
  auto-compaction, `conversation.emit('compact', ...)` interception (closes
  the seam `src/core/event-bus.ts` left in TASK_0004), never-delete-history
  folding via `meta.contextIncluded`.

118 new tests added across `src/conversation/*.test.ts` and
`src/core/storage.test.ts` (376 → 494). All four gates
(`typecheck`/`lint`/`test`/`build`) green.

## Recently completed (TASK_0032–TASK_0038, Phase 5)

Kernel side-channels (`complete()` / `embed()`), generic contribution
accessors, full lifecycle teardown, and three reference example plugins —
see `docs/core/kernel.md`, `docs/examples.md`, and the plugin files themselves
for full details. Summary:

- **TASK_0032** — `src/core/complete.ts`: `bh.complete(req)`, a one-shot LLM
  call side-channel detached from any conversation (zero event-bus activity,
  full model-resolution reuse, abort-signal support, synthetic message mutation
  guards, synthetic-message `append()` / `setContent()` rejection).
- **TASK_0033** — `src/core/embed.ts`: `bh.embed(req)`, embedding side-channel
  with a capability-guard pattern (throws if resolved driver lacks `embeddings`
  capability), input normalization (string → array), single-string and
  string-array arity support.
- **TASK_0034** — `bh.getContributions<T>(key)` method added to `BHZAI` class
  in `src/core/bhzai.ts`: generic multi-plugin accessor for registered capability
  contributions (e.g. `bh.getContributions<Retriever>('retriever')`), returns
  array in registration order, empty array for unregistered keys.
- **TASK_0035** — `bh.dispose()` full teardown in `src/core/bhzai.ts`:
  abort all live conversations (waits for idle), fire `dispose` event (before
  hooks per § 8.5), run plugin `dispose` hooks in reverse order, close every
  MCP session (via new optional `McpClientLike.close?()` in
  `src/core/mcp-integration.ts`, `Promise.allSettled`-based so one failure
  doesn't block others), flip `disposed` flag that rejects post-dispose calls.
  Bug fixes: `context` event patch now honors `appendSystemPrompt`, and both
  `context` / `turn(start)` event payloads now include live `conversation`
  reference.
- **TASK_0036** — `examples/task-plugin.ts` (+ test): task-management plugin
  demonstrating plugin authoring forms, event subscriptions, `context`
  injection, and `turn(end)` veto.
- **TASK_0037** — `examples/memory-plugin.ts` (+ test): agent-memory plugin
  showing lifecycle hooks, `bh.complete()` for fact extraction, start-time
  memory recall with injection-defense sentence.
- **TASK_0038** — `examples/rag-plugin.ts` (+ test): RAG plugin (single
  capability-object plugin) demonstrating both retrieval shapes from § 11.8 —
  Shape 1: an agentic `search_knowledge` tool the model calls on demand; Shape 2:
  automatic `context`-time injection on every user turn, sorted by score and
  truncated to `topK` — both sourced from `bh.getContributions<Retriever>('retriever')`,
  with a `configSchema` (`embeddingModel`, `topK`).

99 new tests added: 68 across `src/core/{complete,embed,contributions,dispose}.test.ts`,
19 across `examples/{task,memory,rag}-plugin.test.ts`, and 12 added to the
pre-existing `src/conversation/agent-loop.test.ts` (the two prerequisite kernel
fixes — layer-4 `appendSystemPrompt` support and the `context`/`turn(start)`
`conversation` field) (494 → 593). All four gates (`typecheck`/`lint`/`test`/`build`)
green.

## Recently completed (TASK_0010–TASK_0012)

### TASK_0010: Command registry

- `src/core/commands.ts` — `CommandRegistry` with `addCommand`/`listCommands`.
- `src/types/command.ts` — `BHZAICommandDefinition`, `BHZAICommandContext`.
- "Last registration wins" shadowing policy (consistent with tool/driver registries).
- 9 tests in `src/core/commands.test.ts`.

### TASK_0011: MCP client handshake & discovery

- `src/plugins/mcp/client.ts` — `McpClient` class.
- JSON-RPC 2.0 envelope over `fetch` (web-standard APIs only).
- `initialize` → `notifications/initialized` handshake.
- `MCP-Protocol-Version` / `Mcp-Session-Id` header contract.
- Paginated `tools/list` discovery with `mcp__<server>__<tool>` namespacing.
- `src/types/mcp.ts` — `McpServerConfig`.
- 17 tests in `src/plugins/mcp/client.test.ts`.

### TASK_0012: MCP client resync, calls, progress, cancellation

- Extended `McpClient` with:
  - Live re-sync via `handleListChanged()`/`pollToolsList()` (diff: added/removed/updated).
  - Real `tools/call` execute binding (replaces TASK_0011 stub).
  - `outputSchema` validation with `ajv` (graceful `isError` degradation on mismatch).
  - Per-call timeouts (configurable via `McpClientOptions.callTimeoutMs`, default 60s).
  - Progress seam (`invocation.progress(update)` callback).
  - `AbortSignal`-driven cancellation with `notifications/cancelled`.
- New error classes: `McpTimeoutError`, `McpCallError`.
- 10 additional tests (27 total in `client.test.ts`).

## Test suite status

- 159 tests across 11 test files — all passing.
- Lint (biome): clean.
- Typecheck (tsc --noEmit): clean (one pre-existing error in `decorators.test.ts` unrelated to TASK_0010–0012).
