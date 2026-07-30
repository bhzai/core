# `src/` — package source root

## Purpose & scope
Top-level source directory for `@bhzai/core`. Contains the kernel (`core/`), shared types (`types/`), the tool registry (`tools/`), and plugin subpaths (`plugins/`). Nothing here is environment-specific — every file under `src/` (except test-only Node imports gated by biome overrides) uses web-standard APIs only (ARCHITECTURE.md § 5).

## Key files
- `index.ts` — root superset barrel. Re-exports `types/`, `core/`, and every `plugins/*` subpath. Consumers wanting a minimal surface import from `@bhzai/core/core` or a specific `@bhzai/core/plugins/*` entry instead.
- `index.test.ts` — smoke test asserting the root barrel re-exports the expected surface.

## Conventions
- **Subpath exports**: every `plugins/<name>/index.ts` corresponds 1:1 to a `package.json` `exports` entry and a `tsup.config.ts` entry. Adding a plugin means updating all three together (see `.claude/rules/packaging.md`).
- **Barrels use `.js` extensions** in re-exports for strict-Node-ESM compatibility of the shipped output, even though `tsconfig.json` uses `moduleResolution: "Bundler"` (which doesn't require them on relative imports).
- **No Node built-ins** in `src/` (except test files with an explicit `biome-ignore` for `node:fs`/`node:url` regression guards). Use `globalThis.crypto` / `crypto.randomUUID()`, `fetch`, `AbortController`, `ReadableStream`, `structuredClone`, `queueMicrotask`.
- **Tests live alongside code** (see `.claude/rules/testing.md`): `<name>.test.ts` next to `<name>.ts`.

## Consumers
- `tsup.config.ts` consumes `index.ts` and each `plugins/<name>/index.ts` as entry points.
- `package.json` `exports` maps the same paths to `dist/` output.
- Downstream hosts (PEP, future WebLLM chat, CLI, Electron) import from the published package, not from `src/` directly.
