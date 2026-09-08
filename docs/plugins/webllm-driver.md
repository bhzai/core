# WebLLM Driver Plugin (`src/plugins/webllm/`)

Documentation for the WebLLM driver plugin.

## Overview

The `WebLLM` class implements the `BHZAIDriver` interface (from
`src/types/driver.ts`) on top of `@mlc-ai/web-llm`'s `MLCEngine`, which the
host injects at runtime. It runs LLM inference entirely in-browser over
WebGPU, making it suitable for browser-based hosts (WebLLM chat pages,
Electron apps with WebGPU access).

The `@mlc-ai/web-llm` package is declared as an **optional peer dependency**
— the core bundle never forces it. The host supplies the `MLCEngine`
instance (or constructor); this plugin wraps it as a `BHZAIDriver`.

## Constructor

```ts
import { WebLLM } from "@bhzai/core/plugins/webllm"

// Form 1: constructor injection — the driver instantiates and manages
// the engine's init/download lifecycle itself.
const driver = new WebLLM({ engine: MLCEngine })

// Form 2: pre-warmed instance — the host has already constructed and
// warmed up the engine.
const driver = new WebLLM({ engine: mlcEngineInstance })
```

### Options

- `engine` — Either an `MLCEngine` constructor (the driver instantiates and
  manages the engine's init/download lifecycle) or an already-constructed,
  pre-warmed `MLCEngine` instance. Detection: `typeof engine === 'function'`
  → constructor form; otherwise → instance form.
- `appConfig` — Optional host override for model artifact/lib URLs. When
  supplied, it **fully replaces** (not merges with) the engine's
  `getAppConfig()` result.
- `dispatch` — Optional framework-event dispatch used to fire
  `driver.progress` events during engine init/download.

## Model loading

Model loading is **lazy** — triggered by the first `chat()` call that
references a not-yet-loaded model, not eagerly in the constructor. The
driver calls `engine.reload(modelId)` when the requested model differs from
the currently-loaded one. Constructing a `WebLLM` driver never blocks or
downloads anything by itself.

Model references accept **both forms**:
- Bare `model_id` (e.g., `"test-model"`) — used directly in unit tests and
  by callers with unqualified ids.
- Qualified `"webllm/<model_id>"` form (e.g., `"webllm/test-model"`) — as passed
  by the agent loop, which always qualifies `ChatRequest.model` with the driver id.

Both forms resolve to the same model. Normalization is transparent; the driver
tracks `loadedModelId` using the normalized (bare) form internally, so repeated
calls with either form for the same underlying model are recognized as "already
loaded" and do not re-trigger `reload`.

## `listModels()`

Reflects the engine's prebuilt app config (or the host-supplied `appConfig`
override), mapped into `ModelInfo[]`. Every model is reported as
`availability: 'downloadable'` (a future task may refine this if MLC exposes
a reliable cache-check API).

## `capabilities(model)`

Per-model capability flags derived from the app-config entry's `overrides`:

- `streaming`: always `true`
- `toolCalls`: from `overrides.toolCalls` (default `false`)
- `reasoning`: always `false` (no bundled WebLLM model in scope is a
  reasoning model)
- `embeddings`: always `false` (this driver does not implement `embed()`)
- `contextWindow`: from `overrides.context_window_size` if present

The `model` argument accepts both the bare `model_id` and the qualified
`"webllm/<model_id>"` form (as passed by the agent loop); both resolve to the
same model.

## `chat(request)`

Maps the BHZAI `ChatRequest` into MLC's OpenAI-compatible
`chat.completions.create({ stream: true, ... })` and translates the
resulting async iterable into the framework's `DriverEvent` shape:

- Text deltas → `{ type: 'delta', text }`
- Tool calls → `{ type: 'tool-call', toolCallId, name, input }` (arguments
  JSON-parsed; invalid JSON yields `{ type: 'done', stopReason: 'error' }`)
- Usage → `{ type: 'usage', inputTokens, outputTokens }`
- Finish reason → `{ type: 'done', stopReason }` (`'stop'`→`'stop'`,
  `'tool_calls'`→`'tool-calls'`, `'length'`→`'length'`)
- Abort → `{ type: 'done', stopReason: 'abort' }` when the signal fires

Unexpected engine exceptions propagate uncaught so the transport retry wrapper
can classify and retry them.

## `driver.progress` events

Engine init progress is surfaced as framework `driver.progress` events so
chat UIs can render download/compile progress bars. The driver registers an
init-progress callback on the engine (constructor form) and forwards each
report through the injected `dispatch` function.
