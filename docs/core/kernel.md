# BHZAI Kernel (`src/core/bhzai.ts`)

Documentation for the `BHZAI` kernel class — the framework entry point every
host instantiates and every plugin registers onto. Architecture reference:
ARCHITECTURE.md § 6.

## Overview

`BHZAI` is the single class a host constructs. It owns:

1. **Plugin registration** via `use()` (TASK_0003) — normalizes the three
   accepted plugin forms (factory function, capability object, decorated
   class instance) into one canonical internal `BHZAIPlugin` shape
   `{ name, setup(bh), capabilities? }`.
2. **The framework event bus** (TASK_0004) exposed as `on()`/`emit()`.
3. **Plugin lifecycle** (TASK_0005): `init()` runs every plugin's
   `initialize` hook in registration order and fires the `initialize`
   framework event; `dispose()` runs `dispose` hooks in reverse order and
   fires `dispose`. (Full teardown semantics are TASK_0035's job; this is
   the partial lifecycle implementation.)
4. **Plugin configuration** (TASK_0006): `declareConfig`/`setConfig`/`getConfig`
   with `ajv`-based JSON Schema validation and defaulting during `init()`,
   plus `config.changed` event emission for post-init updates.
5. **Tool registry** wiring (TASK_0008): `addTool`/`removeTool`/`listTools`.
6. **Driver registry** wiring (TASK_0009): `addDriver`/`listModels`, with
   model lifecycle events (`model.added`, `model.changed`, `model.removed`,
   `models.changed`) dispatched on every catalogue refresh.
7. **Command registry** wiring (TASK_0010): `addCommand`/`listCommands`.
8. **Message-field registry**: `defineMessageField` — the open message
   contract (plugin-declared accessors over `message.meta`).

8. **Conversation lifecycle** (TASK_0023, TASK_0028): `createConversation`/
   `loadConversation` — see `docs/core/conversation.md` for the full
   conversation surface and agent loop this hands off to.

**TASK_0032–TASK_0035**: `complete()` (one-shot LLM calls, TASK_0032),
`embed()` (embeddings side-channel, TASK_0033), `getContributions()` (generic
multi-plugin accessor, TASK_0034), and full `dispose()` teardown (TASK_0035)
are fully implemented. `addMcp()` is implemented (TASK_0015).

## Public API

```typescript
import { BHZAI, type BHZAIHostOptions } from "@bhzai/core";

const bh = new BHZAI({ defaultModel: "webllm/Llama-3.2-3B" });

bh.use(myFactoryPlugin);          // form 1: bare factory function
bh.use({ name: "cap", tools: [] }); // form 2: capability object
bh.use(myDecoratedPluginInstance); // form 3: @Plugin-decorated class instance

await bh.init();
// ... use bh ...
await bh.dispose();
```

### Constructor: `BHZAIHostOptions`

- `config?: Record<string, Record<string, unknown>>` — per-plugin config
  values keyed by plugin name (§ 7.4). Equivalent to calling `setConfig`
  before `init()`.
- `defaultModel?: string` — qualified `'<driver>/<model>'` ref. Wired up
  by TASK_0009 / TASK_0023.
- `systemPrompt?: string` — base system prompt injected into conversation
  preambles (TASK_0023 / § 11.6).

### `use(plugin: BHZAIPluginLike): this`

Accepts one of three forms and normalizes it to the canonical
`BHZAIPlugin` shape:

- **Form 1 — factory function** (`(bh) => void | Promise<void>`): the
  function IS the plugin's `setup`; runs immediately at `use()` time.
- **Form 2 — capability object**: a plain object with well-known keys
  (`name`, `initialize`, `dispose`, `modelSource`, `getMcps`, `tools`,
  `commands`, `configSchema`, `auth`, `retriever`, `skillResolver`,
  `conversationStore`, `memoryStore`). Keys outside this allowlist are
  rejected synchronously so typos like `initalize` fail fast.
- **Form 3 — `@Plugin`-decorated class instance** (added by TASK_0007):
  detected at runtime via a `bhzai_PLUGIN_META` symbol stamped by the
  `@Plugin` decorator, not by structural typing.

Duplicate `use()` calls with the same plugin name are ignored. Returns
`this` for chaining.

### Event surface: `on()` / `emit()`

Backed by an internal `EventBus` instance (see `event-bus.md`). The public
`emit()` enforces the reserved-namespace list (§ 8.4); the kernel uses an
internal `dispatch()` bypass to fire reserved events like `initialize`,
`dispose`, `error`, `config.changed`, `tool.registered`, `tool.removed`,
`driver.registered`, `mcp.attached`, and the model lifecycle events
(`model.added`, `model.changed`, `model.removed`, `models.changed`).

### Side channels: `complete()` / `embed()`

Two detached async utilities for one-shot LLM operations outside conversation
lifecycle (TASK_0032 / TASK_0033):

**`complete(req: CompleteRequest): Promise<CompleteResult>`** — single LLM
call with no conversation. The `req` shape mirrors `ChatRequest` (model,
messages, systemPrompt, params, signal). The `messages` field accepts either
a string (normalized to single user message) or a `BHZAIMessage[]` array.
Returns `{ text: string, usage: { inputTokens, outputTokens } }`. Model
resolution uses the same four-tier resolver as conversations, including
default-model fallback. **Zero conversation-bus events fire** (`message`,
`tool`, `context`, `loop`, `turn`). Synthetic messages reject `append()` and
`setContent()` mutations to maintain purity.

**`embed(req: EmbedRequest): Promise<EmbedResult>`** — embedding side-channel
with capability guarding. The `req` shape includes `model`, `input` (string
or string[]), and optional `signal`. Returns `{ embeddings: number[][], usage?: { inputTokens, outputTokens } }`.
**Throws** if the resolved driver's `embeddings` capability is false or
undefined (not declared or explicitly disabled) — never silent fallback. If
`embeddings` is true but the driver's `embed()` is undefined, throws with
a distinct internal-consistency error. Input normalization: single strings
become `[string]`; arrays pass through. Output always preserves array-of-arrays
shape (single input → `[[...]]`, not `[...]`). Usage is passed through
from the driver or omitted if not provided.

Both methods reuse the model-resolution machinery (four-tier: explicit model
ref → default → host option → first available), so they respect the same
resolution contracts as conversations.

### `getContributions<T>(key: string): T[]`

Generic multi-plugin accessor for registered capability contributions
(TASK_0034). Returns all contributions under a given key in registration
order. For example, `bh.getContributions<Retriever>('retriever')` returns
an array of every `Retriever` object passed via `bh.use({ retriever })`.
Returns an empty array if no contributions exist under the key. Unregistered
keys do not throw — they simply return `[]`. The returned array is a
snapshot at call time and is safe for immediate iteration. Factory-form
plugins (bare functions) are silently skipped since they have no capability
keys to contribute.

### Lifecycle: `init()` / `dispose()`

- `init(): Promise<void>` — runs each capability-object plugin's
  `initialize` hook in **registration order**, fires the `initialize`
  framework event, then runs config validation/defaulting (TASK_0006).
- `dispose(): Promise<void>` — **full teardown** (TASK_0035): (1) aborts all
  live conversations (waits for `idle` state), (2) fires the `dispose` event,
  (3) runs each plugin's `dispose` hook in **reverse registration order**,
  (4) closes every registered MCP session (via optional `McpClientLike.close?()`
  with `Promise.allSettled` so one failure doesn't block others), (5) sets
  an internal `disposed` flag that rejects subsequent calls to `use()`,
  `addTool()`, `addDriver()`, `addCommand()`, `addMcp()`, `createConversation()`,
  `loadConversation()`, `complete()`, and `embed()` with a "disposed" error.
  The `dispose` event fires **before** plugin hooks run (per ARCHITECTURE.md
  § 8.5 "hooks run after it" wording).

### Config: `declareConfig` / `setConfig` / `getConfig`

- `declareConfig(pluginName, schema: JSONSchema)` — declares a plugin's
  config schema. Typically called from inside a plugin's `setup()`.
- `setConfig(pluginName, values)` — sets/merges config values. Pre-init
  calls accumulate initial values; post-init calls fire `config.changed`.
- `getConfig(pluginName)` — returns the merged (host-supplied + defaulted)
  config for a plugin. Validates against the declared schema during
  `init()` using `ajv`.

### Tools: `addTool` / `removeTool` / `listTools`

See `tools.md`. Two `addTool` overloads: full `BHZAIToolDefinition` form
and a sugar form `addTool(name, parameters, execute)` (description
defaults to `''`).

### Drivers: `addDriver` / `listModels`

See `drivers.md`. `listModels()` merges catalogues from every registered
driver in parallel.

### Messages: `defineMessageField`

`defineMessageField(name, { metaKey?, default? })` declares a message field —
the open message contract. It installs a **non-enumerable** accessor on every
`BHZAIMessage` the kernel builds, reading and writing one key inside the
message's `meta` bag. Plugins get `message.myField` ergonomics while the value
persists through `meta`, which already round-trips via
`toPlainMessage`/`fromSnapshot`; non-enumerability keeps the accessor out of
`JSON.stringify` and the snapshot wire shape.

Throws on a reserved name (`id`, `role`, `content`, `blocks`, `time`, `meta`,
`append`, `setContent`), on a duplicate registration, and after `dispose()`.
Call it from a plugin's `setup()` or `initialize` hook — fields registered after
a message exists do not retroactively appear on it.

Pair it with a module augmentation of `BHZAIMessageExtensions` (see
`types.md`) so the field typechecks. Core registers one field itself, `think`,
which `CreateConversationOptions.parseThink` populates.

See `message-fields.ts` for the registry and `conversation/message.ts` for the
factory that applies it.

### Commands: `addCommand` / `listCommands`

See `command-registry.md`.

## Environment boundary

`bhzai.ts` uses only web-standard APIs (`crypto.randomUUID()`). `ajv` is
the only runtime dependency in `src/core/` — a pure-JS JSON Schema
validator with no environment-specific bindings.

## Test coverage

21 tests in `src/core/bhzai.test.ts` (core lifecycle, registration, event bus wiring, config).

TASK_0032–TASK_0035 add new test files:
- 22 tests in `src/core/complete.test.ts` (one-shot LLM utility, model resolution, abort signals, synthetic message mutation guards).
- 25 tests in `src/core/embed.test.ts` (embedding capability guarding, input/output arity, default model resolution, abort signals, driver error handling).
- 6 tests in `src/core/contributions.test.ts` (multi-plugin accessors, registration order, unregistered keys).
- 15 tests in `src/core/dispose.test.ts` (full teardown sequence, conversation abortion, MCP session closing, plugin hook ordering, post-dispose call guards).
