# `examples/` — reference plugins & fitness tests

## Purpose & scope

Example plugins proving the kernel's extension surface (ARCHITECTURE.md §§ 6–11) needs no new kernel API. These are NOT published package code — not in `package.json` `exports`, not built by `tsup`, not imported by anything in `src/`. Each example is deliberately authored using ONLY already-shipped kernel API; if one requires a kernel change to work, that's a kernel bug, not something to patch around here. These files ARE typechecked (via `tsconfig.json` `include`) and test-run (via `vitest.config.ts` `test.include`) as part of the normal `pnpm typecheck`/`pnpm test` gates — inert example code would defeat the purpose.

## Key files

- `task-plugin.ts` + `task-plugin.test.ts` (6 tests) — a task-management plugin (ARCHITECTURE.md § 11.7). Demonstrates plugin authoring forms, event subscriptions, and per-conversation state. TASK_0036.
- `memory-plugin.ts` + `memory-plugin.test.ts` (6 tests) — an agent-memory plugin (§ 11.7). Shows how to hook into conversation lifecycle and build memory features on top of kernel events. TASK_0037.
- `rag-plugin.ts` + `rag-plugin.test.ts` (7 tests) — a single capability-object RAG plugin demonstrating both RETRIEVAL shapes from § 11.8: Shape 1, an agentic `search_knowledge` tool the model calls on demand, and Shape 2, automatic `context`-time injection (sorted by score, truncated to `topK`) on every user turn — not two plugin-authoring forms. TASK_0038.
- `readme-quickstart.ts` + `readme-quickstart.test.ts` (1 test) — the exact code embedded in the root `README.md`'s "Quickstart" fenced block (kept byte-identical to it). Constructs a `BHZAI` instance, registers the real Ollama driver plugin and one custom tool, and drives `sendMessage()` through the real agent loop against a mocked Ollama HTTP layer, asserting a genuinely non-empty assistant response. TASK_0043.

## Conventions

- **Kernel API only**: every example uses ONLY public kernel exports (`BHZAI`, `Conversation`, plugin decorators, event types, etc.) from `@bhzai/core` or `@bhzai/core/core`. No imports from `src/plugins/**`, no environment-specific assumptions, no private APIs.
- **Package-name imports resolve to `src/`, not `dist/`**: `vitest.config.ts` aliases `@bhzai/core` (and its `/core` and `/plugins/*` subpaths) to the matching `src/**/index.ts` barrels, so `pnpm test` never requires a prior `pnpm build` (CI runs tests without building). Do not rely on built output existing when authoring examples.
- **Each example is a fitness test**: if an example cannot be written without a kernel change, that indicates the kernel's extension surface is incomplete or broken. Examples are as load-bearing as any integration test.
- **Colocated tests**: each plugin file has a sibling `.test.ts` file in the same directory, following the repo's test conventions.

## Consumers

- `tsconfig.json` `include` compiles both `src` and `examples` to ensure type coverage.
- `vitest.config.ts` `test.include` runs both `src/**/*.test.ts` and `examples/**/*.test.ts`, so examples' test suites are part of the normal CI gate.
- Plugin authors and kernel reviewers reference these examples as working proof that the § 6–11 extension API is complete and usable.
