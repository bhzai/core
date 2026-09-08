# `src/plugins/` — plugin subpaths

## Purpose & scope

Holds the plugin subpath entry points shipped from the same package. Each subdirectory corresponds to a `package.json` `exports` entry and a `tsup.config.ts` entry, so consumers can import `@bhzai/core/plugins/<name>` without pulling in plugins they don't use. Tree-shaking (`sideEffects: false`) drops unused re-exports from the root barrel.

## Layout

- `webllm/` — WebLLM driver plugin (browser/WebGPU). Peer dep: `@mlc-ai/web-llm`.
- `ollama/` — Ollama driver plugin (plain `fetch`).
- `lmstudio/` — LM Studio driver plugin (plain `fetch`, LM Studio `/api/v0` REST API).
- `openai/` — OpenAI driver plugin (plain `fetch`, hosted `/v1` REST API).
- `vllm/` — vLLM driver plugin (plain `fetch`, self-hosted vLLM `/v1` REST API).
- `mcp/` — Model Context Protocol streamable-HTTP client & management service.
- `idb/` — IndexedDB-backed session persistence plugin (`IdbSessionPersistence`).
- `examples/` — Reference example plugins (tasks, memory recall, RAG).

## Conventions

- **One `index.ts` per subpath**: the entry file is always `<name>/index.ts`, re-exporting the plugin's public surface. Subpath barrels use `.js` extensions in re-exports for strict-Node-ESM compatibility.
- **Heavy deps stay peer dependencies**: model engines (e.g. `MLCEngine`) are injected by the host, never imported directly by the core.
- **Adding a plugin** means updating `package.json` `exports`, `tsup.config.ts` `entry`, and `src/plugins/index.ts`.

## Consumers

- `src/index.ts` re-exports plugins so the root barrel is a superset.
- `tsup.config.ts` builds each subpath entry to `dist/plugins/<name>/index.js` + `.d.ts`.
- Hosts import plugins via `@bhzai/core/plugins/<name>`.
