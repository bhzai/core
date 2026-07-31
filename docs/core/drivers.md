# Driver Registry (`src/core/drivers.ts`)

Documentation for the BHZAI driver registry. Architecture reference:
ARCHITECTURE.md § 10.1.

## Overview

The `DriverRegistry` stores `BHZAIDriver` instances keyed by `id`. It is
the kernel-side store of model-provider drivers (WebLLM, Ollama, LM Studio,
or any future provider). It does **not** implement any actual driver — those
are TASK_0019 (WebLLM), TASK_0020 (Ollama), and the post-v0.1 LM Studio
plugin (`src/plugins/lmstudio/`). It implements the registry
that drivers plug into and the merge logic that aggregates their model
catalogues.

## Public API

```typescript
import { BHZAI, type BHZAIDriver, type ModelInfo } from "@bhzai/core";

const bh = new BHZAI();

bh.addDriver({
  id: "webllm",
  listModels: async () => [/* ModelInfo[] */],
  capabilities: (model) => ({ streaming: true, toolCalls: true, reasoning: false }),
  chat: (request) => /* AsyncIterable<DriverEvent> */,
  // embed: async (req) => ({ embeddings: [], usage: {} }), // optional
});

const models = await bh.listModels(); // ModelInfo[] — merged across all drivers
```

### `BHZAIDriver` interface

```typescript
interface BHZAIDriver {
  id: string; // 'webllm', 'ollama', 'lmstudio', ...
  listModels(): Promise<ModelInfo[]>;
  capabilities(model: string): DriverCapabilities;
  chat(request: ChatRequest): AsyncIterable<DriverEvent>;
  embed?(request: { model: string; input: string[]; signal?: AbortSignal }):
    Promise<{ embeddings: number[][]; usage?: Usage }>;
}
```

- `id` — unique driver identifier. Re-registering with the same `id`
  replaces the previous entry ("last wins" shadowing, consistent with
  the tool and command registries).
- `listModels()` — returns the driver's catalogue of `ModelInfo` records.
- `capabilities(model)` — returns `DriverCapabilities`
  (`{ streaming, toolCalls, reasoning, embeddings?, contextWindow? }`).
- `chat(request)` — returns an `AsyncIterable<DriverEvent>` stream. The
  actual streaming protocol is the driver's concern; the kernel just
  consumes the iterable.
- `embed?` — optional. Only drivers whose
  `capabilities(model).embeddings === true` are expected to implement it.

### `addDriver(driver: BHZAIDriver): void`

Inserts (or replaces) the entry under `driver.id` and fires the
`driver.registered` framework event with `{ driver }` (not blockable,
per § 8.1).

### `listModels(): Promise<ModelInfo[]>`

Calls every registered driver's `listModels()` in parallel
(`Promise.all`) and concatenates the results into one flat array. This
is what makes `bh.listModels()` a single merged catalogue regardless of
how many drivers are contributing.

**Seam for TASK_0015**: the merge will be extended to also include
`modelSource` plugin hook results. See the inline seam comment in
`drivers.ts`.

## Conventions

- **"Last registration wins"** shadowing: re-registering a driver with
  an existing `id` replaces the stored entry. Consistent with the tool
  and command registries.
- **`driver.registered` event** fires on every `addDriver` call,
  including shadowing replacements (the event carries the new driver
  definition; there is no separate `driver.removed` event for shadowing,
  mirroring the tool registry's shadowing policy).

## Environment boundary

`drivers.ts` uses only web-standard APIs. No driver is imported here —
the registry stores instances it's handed; concrete drivers live in
`src/plugins/webllm/` and `src/plugins/ollama/` (TASK_0019/0020), plus
`src/plugins/lmstudio/` (added post-v0.1).

## Test coverage

13 tests in `src/core/drivers.test.ts`:

- `addDriver` storage and `listModels()` merge across multiple drivers.
- Shadowing (re-registration replaces the entry under `id`).
- `driver.registered` event firing (including on shadowing).
- Parallel `listModels()` aggregation.
- Empty registry returns `[]`.
- `capabilities()` passthrough (the registry does not interpret it).
