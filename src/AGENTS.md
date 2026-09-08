# `src/` — package source root

## Purpose & scope
Top-level source directory for `@bhzai/core`. Contains the harness microkernel (`kernel/`), sessions (`sessions/`), LLM seam (`llm/`), tools (`tools/`), commands (`commands/`), agent loop (`loop/`), context tracker (`context/`), compaction pipeline (`compaction/`), core types (`types/`), and plugins (`plugins/`). Uses web-standard APIs only.

## Key files
- `index.ts` — root superset barrel. Re-exports harness, plugins, drivers, and types.
- `index.test.ts` — smoke test asserting the root barrel re-exports the expected surface.

## Conventions
- **Subpath exports**: every `plugins/<name>/index.ts` corresponds 1:1 to a `package.json` `exports` entry and a `tsup.config.ts` entry.
- **Barrels use `.js` extensions** in re-exports for strict-Node-ESM compatibility of the shipped output.
- **No Node built-ins** in `src/`. Use `globalThis.crypto` / `crypto.randomUUID()`, `fetch`, `AbortController`, `ReadableStream`, `structuredClone`, `queueMicrotask`.
- **Tests live alongside code**: `<name>.test.ts` next to `<name>.ts`.

## Consumers
- `tsup.config.ts` consumes `index.ts` and each `plugins/<name>/index.ts` as entry points.
- `package.json` `exports` maps the same paths to `dist/` output.
- Downstream hosts import from the published package (`@bhzai/core`).
