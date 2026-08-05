# `src/plugins/` — plugin subpaths

## Purpose & scope

Holds the plugin subpath entry points shipped from the same package (ARCHITECTURE.md § 5). Each subdirectory is a `package.json` `exports` entry and a `tsup.config.ts` entry, so consumers can import `@bhzai/core/plugins/<name>` without pulling in plugins they don't use. Tree-shaking (`sideEffects: false`) drops unused re-exports from the root barrel.

## Layout

- `webllm/` — WebLLM driver plugin (browser/WebGPU). Peer dep: `@mlc-ai/web-llm`. TASK_0019.
- `ollama/` — Ollama driver plugin (plain `fetch`). TASK_0020.
- `lmstudio/` — LM Studio driver plugin (plain `fetch`, LM Studio's native
  `/api/v0` REST API, OpenAI-shaped SSE streaming).
- `openai/` — OpenAI driver plugin (plain `fetch`, the hosted `/v1` REST API,
  OpenAI-shaped SSE streaming). Also serves any OpenAI-compatible gateway.
- `vllm/` — vLLM driver plugin (plain `fetch`, a self-hosted vLLM server's
  OpenAI-compatible `/v1` REST API, OpenAI-shaped SSE streaming). Separate from
  `openai/` for its own `driver.id`, the real `max_model_len` context window,
  and vLLM's `delta.reasoning` field.
- `mcp/` — MCP streamable-HTTP client plugin (spec rev 2025-11-25). TASK_0011-0016.
- `interop/pi/` — adapter for a subset of pi coding-agent extensions. Future task.
- `interop/opencode/` — adapter for a subset of OpenCode plugins. Future task.

## Conventions

- **One `index.ts` per subpath**: the entry file is always `<name>/index.ts`, re-exporting the plugin's public surface. Subpath barrels use `.js` extensions in re-exports for strict-Node-ESM compatibility.
- **Heavy deps stay peer dependencies**: model engines (e.g. `MLCEngine`) are injected by the host, never imported directly by the core. A plugin subpath may declare its own peer deps alongside its entry, but the core bundle never forces them.
- **Adding a plugin** means updating three files together (see `.claude/rules/packaging.md`): `package.json` `exports`, `tsup.config.ts` `entry`, and `src/index.ts` (append one `export * from "./plugins/<name>/index.js"` line).
- **Currently stubs**: every `index.ts` here is a placeholder (`export {}` with a comment naming the owning task) until the implementing task lands. **Exception**: `mcp/index.ts` is implemented (TASK_0011 + TASK_0012) and exports `McpClient`, `McpHandshakeError`, `McpCallError`, `McpTimeoutError`, `McpClientOptions`, and `ToolListDiff`.

## Consumers

- `src/index.ts` re-exports each `plugins/<name>/index.ts` so the root barrel is a superset.
- `tsup.config.ts` builds each subpath entry to `dist/plugins/<name>/index.js` + `.d.ts`.
- Hosts import plugins via `@bhzai/core/plugins/<name>` and pass them to `bh.use()`.
