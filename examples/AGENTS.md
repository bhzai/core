# `examples/` — reference plugins & fitness tests

## Purpose & scope

Example plugins and quickstarts proving the harness extension surface needs no private kernel APIs. Each example is authored using ONLY public exports from `@bhzai/core`.

## Key files

- `task-plugin.ts` — re-exports task-management plugin from `@bhzai/core/plugins/examples`.
- `memory-plugin.ts` — re-exports agent-memory plugin from `@bhzai/core/plugins/examples`.
- `rag-plugin.ts` — re-exports RAG plugin from `@bhzai/core/plugins/examples`.
- `readme-quickstart.ts` + `readme-quickstart.test.ts` (1 test) — runnable quickstart matching the root `README.md`. Constructs a harness instance with core plugins, registers an Ollama driver and custom tool, and runs a turn.

## Conventions

- **Public API only**: every example uses public `@bhzai/core` exports.
- **Fitness tests**: each example demonstrates real extension patterns.
- **Colocated tests**: verified by vitest in the normal test gate.

## Consumers

- `tsconfig.json` `include` checks `examples/` for type safety.
- `vitest.config.ts` runs example tests.
