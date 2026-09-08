# `src/plugins/webllm/` — WebLLM driver plugin

## Purpose & scope

The WebLLM driver plugin — runs LLM inference in-browser via WebGPU (ARCHITECTURE.md § 10.2). Implements `BHZAIDriver` (from `src/types/driver.ts`) on top of `@mlc-ai/web-llm`'s `MLCEngine`, which the host injects at runtime (never statically imported by the core).

## Key files

- `index.ts` — subpath entry. Exports the `WebLLM` class implementing `BHZAIDriver`, plus supporting types (`MLCEngineInstance`, `MLCEngineConstructor`, `AppConfig`, `WebLLMOptions`, `DriverProgressDispatch`). Implemented by TASK_0019.
- `index.test.ts` — unit tests using a hand-written fake `MLCEngineInstance`.

## Conventions

- **Peer dep, not a runtime dep**: `@mlc-ai/web-llm` is declared as an optional peer dependency (`peerDependencies` + `peerDependenciesMeta.optional: true`), so the core bundle never forces it. The host supplies the `MLCEngine` instance; this plugin wraps it as a `BHZAIDriver`.
- **No static import of `@mlc-ai/web-llm`**: the adapter does NOT statically import the real package — the engine is injected by the host, keeping the core bundle free of the browser/WebGPU-only dependency.
- **WebGPU is environment-specific**: this is one of the few places where a non-web-standard API (WebGPU) is touched. That's why it's a plugin subpath, not part of the core harness.
- **Constructor detection heuristic**: `typeof options.engine === 'function'` → constructor form (driver instantiates and manages init lifecycle); otherwise → pre-warmed instance form.

## Consumers

- `src/index.ts` re-exports this entry.
- `tsup.config.ts` builds it to `dist/plugins/webllm/index.js` + `.d.ts`.
- Hosts running in a WebGPU-capable browser import `@bhzai/core/plugins/webllm` and pass the plugin to `bh.use()`.
