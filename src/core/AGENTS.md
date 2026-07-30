# `src/core/` — BHZAI kernel

## Purpose & scope

The kernel: the `BHZAI` class (framework entry point, ARCHITECTURE.md § 6), the event bus (§ 8), plugin normalization + decorators (§ 7), plugin config (§ 7.4), lifecycle (§ 7.3), and the driver registry (§ 10.1). Everything a host instantiates and every plugin registers onto lives here. Web-standard APIs only (§ 5) — no Node built-ins, no DOM, no imports from `src/plugins/**`.

## Key files

- `bhzai.ts` — the `BHZAI` class. Constructor + `use()` (TASK_0003), `on()`/`emit()` (TASK_0004), `init()`/`dispose()` (TASK_0005), `declareConfig`/`setConfig`/`getConfig` (TASK_0006), `addTool`/`removeTool`/`listTools` (TASK_0008), `addDriver`/`listModels` (TASK_0009) with model lifecycle events (`model.added`, `model.changed`, `model.removed`, `models.changed`), `addCommand`/`listCommands` (TASK_0010), `bh.conversations.list()` (TASK_0029), `getContributions()` (TASK_0034), `complete()`/`embed()` (TASK_0032/0033), full `dispose()` teardown (TASK_0035), and plugin activation: `enablePlugin`/`disablePlugin`/`isPluginEnabled`/`listPlugins`/`runAs`.
- **`getContributions()` vs. `listPlugins()` — different questions.** `getContributions(key)` reads a *capability-object key* (`retriever`, `memoryStore`, …) across plugins; `listPlugins()` reports what each plugin *registered into the registries* (tools, commands, drivers, MCP servers, event handlers) plus its activation state. Neither subsumes the other.
- `event-bus.ts` — `EventBus` class (§ 8). Sequential awaited dispatch, patch chaining, blockable pipelines, reserved-namespace enforcement on public `emit()`, internal `dispatch()` bypass for kernel-originated events, global per-bus FIFO serialization.
- `decorators.ts` — TC39 stage-3 decorators (`@Plugin`, `@On`, `@Tool`) for plugin form 3 (§ 7.2). Native decorators only — no `experimentalDecorators`.
- `drivers.ts` — `DriverRegistry` (TASK_0009, § 10.1). Stores `BHZAIDriver` instances keyed by `id`, fires `driver.registered`, merges `listModels()` across drivers. `modelSource` hook merge is TASK_0015's job (see seam comment).
- `commands.ts` — `CommandRegistry` (TASK_0010, § 6). Stores `BHZAICommandDefinition` records keyed by `name`, implements "last registration wins" shadowing (consistent with tool/driver registries), exposes `addCommand`/`listCommands`. No events fired for command registration/replacement.
- `storage.ts` — kernel-side wiring for conversation persistence (TASK_0029, § 11.4). `resolveActiveConversationStore()` finds the last-registered `conversationStore` capability among plugins. `wireAutoSave()` subscribes to `bh.on('conversation.message', ...)` to call `store.save()` on every `message(sent)` event. `createConversationsAccessor()` returns the `bh.conversations` object, which delegates `list(query?)` to the store or throws if absent. No concrete store implementations — only kernel wiring + interfaces.
- `complete.ts` (TASK_0032) — `complete()` one-shot LLM call side-channel, detached from conversations (zero event-bus activity). Reuses model-resolution machinery. Returns `{ text, usage }`.
- `embed.ts` (TASK_0033) — `embed()` embedding side-channel with capability-guarding pattern. Input normalization (string → array). Reuses model-resolution machinery.
- `mcp-integration.ts` — MCP-kernel integration wiring. Updated in TASK_0035: `McpClientLike` interface now includes optional `close?(): Promise<void>` for full teardown support.
- `index.ts` — core barrel. Re-exports the public kernel surface.

## Conventions

- **Stubs throw, never no-op**: an unimplemented § 6 method throws with `Error("bh.<method>(): not implemented — see TASK_XXXX")` so accidental use surfaces immediately.
- **Plugin attribution is ambient and synchronous.** `bhzai.ts` sets `attributionScope` around a plugin's `setup()` and around each `initialize` hook; every registration made in that window is credited to the plugin via the reverse ownership indexes (`toolOwners`, `commandOwners`, …). Registries never learn what a plugin is — each is handed a name predicate instead. Two consequences to preserve when touching this: **any new registration path must call `attribute()`** or its contributions become permanently ungatable, and **the window does not survive a form-1 factory's `await`** (`use()` does not await `setup()`), which is what `runAs()` exists to work around. MCP attachment does not use the window at all — it attributes explicitly, after the await, from the handle.
- **Unowned means always on.** A registration made outside any plugin scope belongs to the host and is never gated. This is what keeps activation backward compatible, so do not "fix" unowned contributions by inventing a default owner.
- **`defineMessageField()` is the one registration path deliberately NOT gated.** A message field is a data-shape contract, not a behavior — the accessor exposes a key that already lives in `meta` and already round-trips through snapshots. Gating it would make `message.myField` read `undefined` on messages whose `meta.myField` is populated, silently changing how persisted conversations deserialize. Same reasoning as the unconditionally-registered built-in `think` field.
- **`ajv` is the only runtime dep** in this directory (config validation, TASK_0006). It's pure-JS with no environment bindings.
- **Test accessors** (`__testPluginCount`, `__testHasPlugin`, `__testOption`) exist for kernel-internal invariant assertions; they are `@internal` and not part of § 6.
- **PATH NOTE**: TASK specs say `src/kernel/`, but the repo convention is `src/core/` (established by TASK_0002). New kernel files go here, not in a separate `kernel/` dir.

## Consumers

- `src/index.ts` re-exports `core/index.ts` as the `.` and `./core` subpath entries.
- `src/tools/registry.ts` imports `EventBus` from here (the tool registry fires `tool.registered`/`tool.removed` via the bus's kernel bypass).
- Plugin authors import `BHZAI`, `Plugin`, `On`, `Tool`, `EventBus` from `@bhzai/core` or `@bhzai/core/core`.
