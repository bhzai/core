# `bhzai/` — `@bhzai/core` package

## Purpose & scope

The actual git repository for the `@bhzai/core` package (MIT license).
Contains the framework source (`src/`), build/test/lint tooling, and
implementation documentation (`docs/`). The parent directory holds only the
v0.1 design proposal (`ARCHITECTURE.md`) and the task breakdown (`tasks/`) —
all code lives here.

## Current state (TASK_0001–TASK_0044 complete — v0.1 build finished)

All 6 phases are implemented: foundations, kernel core, tool/driver/command
registries + MCP client, drivers & model selection, conversations & the agent
loop, kernel utilities & reference examples, and interop/validation/docs. See
`docs/PROGRESS.md` for the full task status.

Implemented:

- **Scaffolding** (`package.json`, `tsconfig.json`, `tsup.config.ts`,
  `vitest.config.ts`, `biome.json`, `husky`) — ESM-only, three-tier subpath
  exports, native TC39 stage-3 decorators.
- **Kernel** (`src/core/bhzai.ts`) — `BHZAI` class: `use(), `on()`/`emit()`,
  `init()`/`dispose()`, config contract, registry wiring, `complete()` /
  `embed()` side-channels, `getContributions()` accessor, full teardown.
- **Event bus** (`src/core/event-bus.ts`) — sequential dispatch, patch
  chaining, blockable pipelines, reserved-namespace enforcement.
- **Plugin system** (`src/core/decorators.ts`, `lifecycle.ts`, `config.ts`)
  — three forms (factory, capability object, decorated class), lifecycle
  ordering, `ajv`-based config validation.
- **Shared types** (`src/types/`) — pure type declarations, no runtime logic.
- **Tool registry** (`src/tools/registry.ts`) — single source of truth,
  shadowing, `tool.registered`/`tool.removed` events.
- **Driver registry** (`src/core/drivers.ts`) — `listModels()` merge across
  drivers.
- **Command registry** (`src/core/commands.ts`) — `addCommand`/`listCommands`.
- **MCP client** (`src/plugins/mcp/`) — streamable-HTTP JSON-RPC 2.0,
  handshake, discovery, re-sync, `tools/call`, validation, timeouts,
  progress, cancellation.
- **Transport retry** (`src/core/retry.ts`) — `callDriverWithRetry` wrapper,
  `isRetriableError` classifier, `DEFAULT_RETRY_POLICY`, `request` lifecycle
  events.
- **WebLLM driver** (`src/plugins/webllm/`) — `bhzaiDriver` implementation
  wrapping an injected MLC `MLCEngine` instance. Browser/WebGPU-only.
- **Ollama driver** (`src/plugins/ollama/`) — `bhzaiDriver` implementation
  backed entirely by web-standard `fetch`. NDJSON streaming, capabilities
  cache, `embed()`. Works in any fetch-capable runtime.
- **LM Studio driver** (`src/plugins/lmstudio/`) — `bhzaiDriver` implementation
  over LM Studio's native `/api/v0` REST API, also `fetch`-only. OpenAI-shaped
  SSE streaming with fragment-accumulated tool calls, a one-request
  capabilities cache, and `embed()`. Works in any fetch-capable runtime.
- **OpenAI driver** (`src/plugins/openai/`) — `bhzaiDriver` implementation over
  the hosted `/v1` REST API, `fetch`-only (no `openai` SDK). Same SSE shape as
  the LM Studio driver, plus what a hosted multi-tenant platform forces:
  capabilities inferred from the model id when nothing is declared
  (api.openai.com's `/v1/models` declares none) but READ from a gateway's
  `context_length` / `supported_parameters` when they are, id normalization for
  vendor-namespaced gateway ids, a `meta.type` modality tag over its multi-modal
  catalogue, an overridable context-window family table, and assistant
  `tool_calls` reconstruction so multi-iteration tool loops pass the API's
  structural validation. Serves any OpenAI-compatible gateway via `baseUrl`.
- **Credential resolution** (`src/core/credentials.ts`) —
  `resolveCredentials()` three-tier chain (runtime value → `auth` hooks →
  unauthenticated). `bh.getAuthHooks()` exposes registered resolvers.
- **Model selection** (`src/core/models.ts`) — `parseModelRef`,
  `resolveModelRef` (bare-id disambiguation), `listModels` (catalogue merge),
  `resolveConversationModel` (four-tier resolution), `setModel` (switching
  with deferred application + `model.selected` event). Error types:
  `AmbiguousModelError`, `ModelNotFoundError`, `NoModelError`,
  `ModelUnavailableError`.
- **Conversations & the agent loop** — see `docs/core/conversation.md` for
  full detail. Summary: conversation surface, system-prompt layering, the
  agent loop with tool execution, loop termination & guardrails, serialization,
  storage interfaces, concurrent input steering, and compaction pipeline.
- **Model lifecycle events** (`src/core/bhzai.ts`, `docs/core/events.md`) —
  `model.added`, `model.changed`, `model.removed`, and `models.changed` are
  dispatched on every `listModels()` refresh, including driver registration,
  `init()`, and plugin activation toggles.
- **Kernel side-channels** (`src/core/complete.ts`, `src/core/embed.ts`) —
  `complete()` one-shot LLM calls and `embed()` embedding side-channel, both
  with full model-resolution reuse and capability guarding.
- **Reference example plugins** (`examples/`) — three fitness-test plugins
  proving the kernel extension surface is complete: task-management plugin,
  agent-memory plugin, and RAG plugin (both agentic and automatic shapes),
  plus a runnable README quickstart example.
- **Interop adapters** (`src/plugins/interop/`) — `runPiExtension()`
  (`src/plugins/interop/pi/`) translates pi coding-agent extensions onto
  bhzai kernel primitives; `runOpenCodePlugin()`
  (`src/plugins/interop/opencode/`) maps OpenCode-style plugin hooks onto
  the same primitives, including zod-like→JSON-Schema conversion and
  `permission.ask` composing with the shared `tool(beforeCall)` approval
  seam.
- **Security audit** (`docs/security-review.md`) — verifies all 5
  ARCHITECTURE.md § 13 security commitments against real tests; adds a
  static no-eval regression guardrail (`src/tools/no-eval.test.ts`).
- **PEP mapping validation** (`docs/pep-mapping-validation.md`) — confirms
  every § 14 (#1338) mapping row against real tests.
- **Open-questions decision log** (`docs/open-questions.md`) — resolves the
  4 open items from § 16 plus 2 already-resolved items, logged for
  traceability.

All 44 tasks complete. See "Recently completed (TASK_0039–TASK_0044, Phase 6)"
in `docs/PROGRESS.md` for the full Phase 6 writeup, including GitHub issue
#5/#6 fixes and issue #4's disposition (investigated, left open with
rationale).

## Key files

- `package.json` — package manifest, three-tier `exports`, scripts. See
  `.claude/rules/packaging.md`.
- `src/index.ts` — root superset barrel (re-exports `core/`, `types/`, and
  every `plugins/*` subpath).
- `src/core/bhzai.ts` — the `BHZAI` kernel class. See `docs/core/kernel.md`.
- `docs/core/events.md` — full catalogue of framework and conversation events.
- `docs/` — implementation documentation. See `docs/ARCHITECTURE.md` for the
  index of per-subsystem docs.
- `example/` — WebLLM chat browser example (distinct from `examples/`). A
  Lit 3 + TypeScript browser app demonstrating streaming, live telemetry,
  reasoning block parsing, and MCP server management via reusable custom
  elements. See `example/AGENTS.md` and `docs/examples/webllm-chat.md`.
- `tsup.config.ts` — multi-entry ESM build; entry list mirrors `package.json`
  `exports` 1:1.

## Conventions

- **All code is TypeScript.** Strict mode, ES2022, `moduleResolution:
"Bundler"`, native TC39 stage-3 decorators (no `experimentalDecorators`).
- **Web-standard APIs only** in `src/core/` and `src/types/` — `fetch`,
  `AbortController`, `ReadableStream`, `crypto.randomUUID`,
  `structuredClone`, `queueMicrotask`. No Node built-ins, no DOM.
- **`ajv` is the only runtime dependency** in the core (config + MCP
  `outputSchema` validation). Heavy deps like `@mlc-ai/web-llm` are peer
  dependencies scoped to their plugin subpath, injected at runtime.
- **Tests co-located with code**: `<name>.test.ts` next to `<name>.ts`.
- **Stubs throw, never no-op**: unimplemented § 6 methods throw with a
  `TODO(TASK_XXXX)` comment naming the owning task.
- **Barrels use `.js` extensions** in re-exports for strict-Node-ESM
  compatibility of the shipped output.
- **Code comments follow JSDoc format.**

## Commands

```bash
pnpm install          # install dependencies
pnpm build            # tsup — multi-entry ESM build + .d.ts
pnpm typecheck        # tsc --noEmit
pnpm lint             # biome check .
pnpm format           # biome format --write .
pnpm test             # vitest run
pnpm test <path>      # run a single test file
pnpm test:watch       # vitest watch mode
```

## Consumers

- Downstream hosts (PEP, future WebLLM chat, CLI, Electron) import from the
  published package, not from `src/` directly.
- The parent repo's `tasks/` directory drives implementation order; this
  package's `docs/PROGRESS.md` tracks completion status.

## Rules

- `.claude/rules/packaging.md` — subpath exports, dependency policy,
  tree-shaking rules.
- `.claude/rules/workspace.md` — workspace structure (code in `bhzai/`,
  tasks in `tasks/`).
- `.claude/rules/testing.md` — test conventions.
- `.claude/rules/docs.md` — keep documentation current with code changes.
