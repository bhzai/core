# `src/plugins/interop/` — interop adapter subpaths

## Purpose & scope
Adapters that bridge external coding-agent/plugin ecosystems onto BHZAI's plugin surface (ARCHITECTURE.md § 12). Each subdirectory is its own subpath export, so a consumer who doesn't need interop pays no bundle cost for it.

## Layout
- `pi/` — adapter for a subset of pi coding-agent extensions. Stub (`export {}`) until the owning task lands.
- `opencode/` — adapter for a subset of OpenCode plugins. Stub (`export {}`) until the owning task lands.

## Conventions
- Same as the parent `src/plugins/` conventions: one `index.ts` per subpath, `.js` extensions in re-exports, three-file update (package.json + tsup + root barrel) when adding a new interop target.
- **MCP is the zero-adapter interop path** (§ 12): an MCP server re-export needs no interop adapter here — it goes through `src/plugins/mcp/`. These adapters are only for ecosystems that don't speak MCP natively.

## Consumers
- `src/index.ts` re-exports each `interop/<name>/index.ts`.
- `tsup.config.ts` builds each to `dist/plugins/interop/<name>/index.js` + `.d.ts`.
