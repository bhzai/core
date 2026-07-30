# Getting Started & Tooling (`package.json`, `tsconfig.json`, `tsup.config.ts`, `vitest.config.ts`, `biome.json`)

Documentation for the BHZAI package scaffolding and tooling setup
established by TASK_0001. Architecture reference: ARCHITECTURE.md § 5.

## Package identity

- **Name**: `@bhzai/core`
- **Version**: `0.1.0`
- **License**: MIT
- **Type**: `"module"` — ESM only, per § 5.
- **`sideEffects: false`** — enables tree-shaking of unused subpath
  exports. This is what lets `import { BHZAI } from '@bhzai/core'`
  drop unused plugins even though the root barrel re-exports all of
  them.
- **`engines.node`**: `">=20"` (native `fetch`, `structuredClone`, modern
  ESM resolution for local dev/test; the shipped library targets
  web-standard APIs at runtime).
- **`packageManager`**: `pnpm@9.15.0`.
- **`files`**: `["dist"]` — only build output is published.

## Subpath exports (three tiers)

```json
{
  "exports": {
    ".":                      { "types": "./dist/index.d.ts",                       "import": "./dist/index.js" },
    "./core":                 { "types": "./dist/core/index.d.ts",                  "import": "./dist/core/index.js" },
    "./plugins/webllm":       { "types": "./dist/plugins/webllm/index.d.ts",        "import": "./dist/plugins/webllm/index.js" },
    "./plugins/ollama":       { "types": "./dist/plugins/ollama/index.d.ts",        "import": "./dist/plugins/ollama/index.js" },
    "./plugins/mcp":          { "types": "./dist/plugins/mcp/index.d.ts",           "import": "./dist/plugins/mcp/index.js" },
    "./plugins/interop/pi":   { "types": "./dist/plugins/interop/pi/index.d.ts",    "import": "./dist/plugins/interop/pi/index.js" },
    "./plugins/interop/opencode": { "types": "./dist/plugins/interop/opencode/index.d.ts", "import": "./dist/plugins/interop/opencode/index.js" }
  }
}
```

1. **Root `.`** — batteries-included superset. Re-exports core + every
   plugin. `import { BHZAI, WebLLM } from '@bhzai/core';`
2. **`./core`** — the kernel only. Minimal surface, zero plugin code.
   `import BHZAI from '@bhzai/core/core';`
3. **`./plugins/*`** — one entry per plugin, each independently
   importable. `import WebLLM from '@bhzai/core/plugins/webllm';`

Top-level `main` / `types` fallbacks point at `dist/index.js` /
`dist/index.d.ts` for older tooling that ignores `exports`.

## npm scripts

```bash
pnpm build        # tsup — multi-entry ESM build + .d.ts bundling
pnpm typecheck    # tsc --noEmit
pnpm lint         # biome check .
pnpm format       # biome format --write .
pnpm test         # vitest run
pnpm test:watch   # vitest
```

## Tooling choices

### `tsup` (build)

Multi-entry ESM build with `.d.ts` bundling. The `tsup.config.ts` entry
list mirrors the `package.json` `exports` map 1:1 — adding a subpath
means updating both files (see `.claude/rules/packaging.md`).

### `tsc` (typecheck)

`tsconfig.json`:

- `"strict": true` (and all component flags — none selectively disabled).
- `"target": "ES2022"` — stable, broadly-supported baseline with native
  class fields and top-level await support in bundlers.
- `"module": "ESNext"`, `"moduleResolution": "Bundler"` — avoids
  `NodeNext`'s mandatory explicit `.js` extension requirement on
  relative imports (friction-heavy for a from-scratch codebase; `tsup`
  handles bundling).
- `"declaration": true`, `"declarationMap": true` — source maps for
  `.d.ts`, per § 5's "TypeScript-first with `.d.ts` maps" rule.
- **Native TC39 stage-3 decorators only** — `experimentalDecorators`
  and `emitDecoratorMetadata` are NOT set. The architecture doc (§ 7.2
  form 3) is explicit that BHZAI uses TC39 stage-3 decorators, which
  require TypeScript ≥ 5.0.

### `vitest` (test runner)

Tests co-located with implementation (`<name>.test.ts` next to
`<name>.ts`). See `.claude/rules/testing.md`.

### `biome` (linter + formatter)

Replaces ESLint + Prettier. Single tool, no plugin bridge needed.

### `husky` (git hooks)

Wired via `pnpm prepare`. Pre-commit hooks run lint/format checks.

## Dependencies

- **Runtime**: `ajv` (added retroactively by TASK_0006 — pure-JS JSON
  Schema validator used by config validation and MCP `outputSchema`
  validation). No other runtime dependency is permitted in the core.
- **Peer (plugin-scoped)**: `@mlc-ai/web-llm` will be declared as a
  peer dependency scoped to `./plugins/webllm` by TASK_0019. It is NOT
  a root dependency, NOT a devDependency, and NOT imported by the core.
  The root barrel can safely re-export the WebLLM plugin because the
  plugin is glue code that **receives** the engine (injected, never
  imported), so re-exporting it from root does not pull
  `@mlc-ai/web-llm` into anyone's bundle.
- **Dev**: `typescript`, `tsup`, `vitest`, `@biomejs/biome`, `husky`.

## Source layout

```
src/
  index.ts                      # root superset barrel (re-exports only)
  core/                         # kernel (see core/kernel.md)
  types/                        # shared types (see core/types.md)
  tools/                        # tool registry (see core/tool-registry.md)
  plugins/
    webllm/index.ts             # stub (TASK_0019)
    ollama/index.ts             # stub (TASK_0020)
    mcp/index.ts                # MCP client plugin (see plugins/mcp-client.md)
    interop/
      pi/index.ts               # stub (future)
      opencode/index.ts         # stub (future)
```

## Environment boundary

`src/core/` and `src/types/` use only web-standard APIs: `fetch`,
`AbortController`, `ReadableStream`, `crypto.randomUUID`,
`structuredClone`, `queueMicrotask`. No Node built-ins, no DOM.
Anything environment-specific (WebGPU, stdio) lives in a
driver/plugin subpath instead.

## Test coverage

1 smoke test in `src/index.test.ts` — asserts the root barrel
re-exports the expected public surface (kernel + types + each plugin
subpath).
