# `bhzai/` — `@bhzai/core` package

## Purpose & scope

The git repository for the `@bhzai/core` package (MIT license).
Contains the framework source (`src/`), build/test/lint tooling, reference
example plugins (`examples/`), browser chat example (`example/`), and
implementation documentation (`docs/`).

## Current state (v0.2 architecture complete)

Greenfield core rewrite implementing the "everything is a plugin" design with
a minimal privileged harness kernel and append-only session event logs.

Implemented:

- **Scaffolding** (`package.json`, `tsconfig.json`, `tsup.config.ts`,
  `vitest.config.ts`, `biome.json`, `husky`) — ESM-only subpath exports,
  native TC39 stage-3 decorators.
- **Kernel** (`src/kernel/`) — `createHarness` / `HarnessImpl`, plugin lifecycle,
  topological dependency ordering, exclusive service claims (`ctx.claim()`),
  reversible effect scopes, unified event bus (`createEventBus`). Backwards-compatible
  `BHZAI` facade.
- **Sessions** (`src/sessions/`) — `sessionPlugin`, append-only immutable
  event log, pure message projection (`deriveMessages(log)`), session
  persistence abstraction.
- **LLM Seam** (`src/llm/`) — `llmPlugin`, driver registration, qualified model
  resolution, streaming chat completion dispatch, one-shot `complete()`.
- **Tools** (`src/tools/`) — `toolsPlugin`, unified tool registry, parameter
  validation, execution wrapper.
- **Commands** (`src/commands/`) — `commandsPlugin`, slash command registry and
  execution pipeline.
- **Agent Loop** (`src/loop/`) — `agentLoopPlugin`, single deterministic
  termination rule (concludes when model produces a response without requesting
  tool calls), step streaming, tool call execution.
- **Context Tracking** (`src/context/`) — `contextPlugin`, usage-based context
  accounting anchored to driver-reported tokens.
- **Compaction** (`src/compaction/`) — `compactionPlugin`, context compaction
  pipeline and boundary event emission.
- **MCP Client & Service** (`src/plugins/mcp/`) — streamable-HTTP JSON-RPC 2.0
  client, tool discovery, dynamic registration, connection lifecycle management.
- **IndexedDB Persistence** (`src/plugins/idb/`) — browser-targeted session
  persistence over IndexedDB.
- **Bundled Drivers** — `WebLLM` (`plugins/webllm/`), `Ollama` (`plugins/ollama/`),
  `LMStudio` (`plugins/lmstudio/`), `OpenAI` (`plugins/openai/`), `VLLM` (`plugins/vllm/`).
- **Reference Example Plugins** (`src/plugins/examples/`, `examples/`) —
  task-management plugin, agent-memory plugin, RAG plugin, and quickstart example.

## Key files

- `package.json` — package manifest, subpath `exports`, scripts.
- `src/index.ts` — root superset barrel (re-exports kernel, plugins, drivers, types).
- `src/kernel/` — harness micro-kernel and event bus.
- `docs/ARCHITECTURE.md` — v0.2 architecture specification.
- `example/` — WebLLM browser chat application using v0.2 Harness APIs.
- `tsup.config.ts` — multi-entry ESM build matching `package.json` `exports`.

## Conventions

- **All code is TypeScript.** Strict mode, ES2022, `moduleResolution: "Bundler"`,
  native TC39 stage-3 decorators.
- **Web-standard APIs only** in `src/` — `fetch`, `AbortController`,
  `ReadableStream`, `crypto.randomUUID`, `structuredClone`, `queueMicrotask`.
  No Node built-ins, no DOM in core.
- **`ajv` is the only runtime dependency** in the core. Heavy dependencies like
  `@mlc-ai/web-llm` are scoped peer dependencies.
- **Tests co-located with code**: `<name>.test.ts` next to `<name>.ts`.
- **Barrels use `.js` extensions** in re-exports for strict-Node-ESM compatibility
  of the shipped output.
- **Code comments follow JSDoc format.**

## Commands

```bash
pnpm install          # install dependencies
pnpm build            # tsup — multi-entry ESM build + .d.ts
pnpm typecheck        # tsc --noEmit && tsc --noEmit -p example
pnpm lint             # biome check . && node scripts/check-quality-gates.mjs
pnpm format           # biome format --write .
pnpm test             # vitest run
pnpm test <path>      # run a single test file
pnpm test:watch       # vitest watch mode
```

## Consumers

- Downstream hosts import from the published package (`@bhzai/core`).

