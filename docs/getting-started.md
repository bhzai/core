# Getting Started & Tooling (`package.json`, `tsconfig.json`, `tsup.config.ts`, `vitest.config.ts`, `biome.json`)

Documentation for the `@bhzai/core` package scaffolding and tooling setup.

## Package identity

- **Name**: `@bhzai/core`
- **Version**: `0.2.0`
- **License**: MIT
- **Type**: `"module"` — ESM only.
- **`sideEffects: false`** — enables tree-shaking of unused subpath exports.
- **`engines.node`**: `">=20"` (native `fetch`, `structuredClone`, modern ESM resolution for local dev/test; the shipped library targets web-standard APIs at runtime).
- **`packageManager`**: `pnpm@9.15.0`.
- **`files`**: `["dist"]` — only build output is published.

## Subpath exports

```json
{
  "exports": {
    ".":                      { "types": "./dist/index.d.ts",                       "import": "./dist/index.js" },
    "./plugins/webllm":       { "types": "./dist/plugins/webllm/index.d.ts",        "import": "./dist/plugins/webllm/index.js" },
    "./plugins/ollama":       { "types": "./dist/plugins/ollama/index.d.ts",        "import": "./dist/plugins/ollama/index.js" },
    "./plugins/lmstudio":     { "types": "./dist/plugins/lmstudio/index.d.ts",      "import": "./dist/plugins/lmstudio/index.js" },
    "./plugins/openai":       { "types": "./dist/plugins/openai/index.d.ts",        "import": "./dist/plugins/openai/index.js" },
    "./plugins/vllm":         { "types": "./dist/plugins/vllm/index.d.ts",          "import": "./dist/plugins/vllm/index.js" },
    "./plugins/mcp":          { "types": "./dist/plugins/mcp/index.d.ts",           "import": "./dist/plugins/mcp/index.js" },
    "./plugins/idb":          { "types": "./dist/plugins/idb/index.d.ts",           "import": "./dist/plugins/idb/index.js" },
    "./plugins/examples":     { "types": "./dist/plugins/examples/index.d.ts",      "import": "./dist/plugins/examples/index.js" }
  }
}
```

1. **Root `.`** — batteries-included superset. Re-exports harness, plugins, drivers, and types:
   `import { createHarness, sessionPlugin, llmPlugin, Ollama } from '@bhzai/core';`
2. **`./plugins/*`** — one entry per plugin, each independently importable:
   `import { Ollama } from '@bhzai/core/plugins/ollama';`

Top-level `main` / `types` fallbacks point at `dist/index.js` / `dist/index.d.ts` for tooling that ignores `exports`.

## npm scripts

```bash
pnpm build        # tsup — multi-entry ESM build + .d.ts bundling
pnpm typecheck    # tsc --noEmit && tsc --noEmit -p example
pnpm lint         # biome check . && node scripts/check-quality-gates.mjs
pnpm format       # biome format --write .
pnpm test         # vitest run
pnpm test:watch   # vitest
```

## Tooling choices

### `tsup` (build)

Multi-entry ESM build with `.d.ts` bundling. The `tsup.config.ts` entry list mirrors the `package.json` `exports` map 1:1.

### `tsc` (typecheck)

`tsconfig.json`:

- `"strict": true` (all component flags enabled).
- `"target": "ES2022"` — stable baseline with native class fields and top-level await.
- `"module": "ESNext"`, `"moduleResolution": "Bundler"` — modern ESM module resolution.
- `"declaration": true`, `"declarationMap": true` — source maps for `.d.ts`.
- **Native TC39 stage-3 decorators only** — `experimentalDecorators` and `emitDecoratorMetadata` are NOT set in the core library.

### `vitest` (test runner)

Tests co-located with implementation (`<name>.test.ts` next to `<name>.ts`).

### `biome` (linter + formatter)

Replaces ESLint + Prettier in a single fast toolchain.

### `husky` (git hooks)

Wired via `pnpm prepare`. Pre-commit hooks run lint/format checks.

## Dependencies

- **Runtime**: `ajv` (pure-JS JSON Schema validator used by config validation and MCP tool calling schema validation). No other runtime dependency is permitted in the core.
- **Peer (plugin-scoped)**: `@mlc-ai/web-llm` is declared as a peer dependency scoped to `./plugins/webllm`. It is injected at runtime and never bundled into the core.
- **Dev**: `typescript`, `tsup`, `vitest`, `@biomejs/biome`, `husky`.

## Source layout

```
src/
  index.ts                      # root superset barrel
  kernel/                       # harness kernel, lifecycle, dependencies, event bus
  sessions/                     # append-only event log and projection
  llm/                          # driver registry and streaming seam
  tools/                        # tool registry and execution
  commands/                     # slash command registry
  loop/                         # single-turn agent execution loop
  context/                      # usage-anchored context tracking
  compaction/                   # context-window compaction pipeline
  types/                        # core data types and interfaces
  plugins/
    webllm/                     # WebLLM browser driver
    ollama/                     # Ollama fetch driver
    lmstudio/                   # LM Studio fetch driver
    openai/                     # OpenAI-compatible gateway driver
    vllm/                       # vLLM driver
    mcp/                        # Model Context Protocol client plugin
    idb/                        # IndexedDB session persistence
    examples/                   # reference example plugins
```

## Environment boundary

`src/` uses only web-standard APIs: `fetch`, `AbortController`, `ReadableStream`, `crypto.randomUUID`, `structuredClone`, `queueMicrotask`. No Node built-ins, no DOM. Environment-specific features (WebGPU, IndexedDB) live in modular plugin subpaths.
