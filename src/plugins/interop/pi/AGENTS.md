# `src/plugins/interop/pi/` — pi coding-agent extension interop

## Purpose & scope
Adapter (TASK_0039) bridging a subset of pi coding-agent extensions onto BHZAI's plugin surface (ARCHITECTURE.md § 12). Lets a host reuse existing pi extensions (tools, commands, hooks, events) without rewriting them as BHZAI plugins, by translating portable pi-style factory functions onto BHZAI kernel primitives.

## Key files
- `index.ts` — implementation of `runPiExtension(factory, bh, pluginName?)`, the shim factory runner. Defines:
  - `PiExtensionAPI` — the shim interface passed to pi extension factories
  - `PiUnsupportedCallWarning`, `PiAdapterHandle` — diagnostics for unsupported API calls
  - `runPiExtension()` — entry point; constructs the shim, runs the factory, returns warnings
- `pi-adapter.test.ts` — comprehensive unit tests covering all 8 required test cases

## Architecture

### Event mapping (§ 8.3)
All 15 non-idle pi event names map to BHZAI framework/conversation events:
- **before_agent_start** → conversation `start`
- **agent_start/agent_end** → conversation `loop` (state-discriminated)
- **input** → conversation `message` with `state='before'`, `role='user'`
- **message_update** → conversation `message.delta`; translates `kind='reasoning'` to `thinking=true`
- **context** → conversation `context` (pass-through)
- **tool_call** → conversation `tool` with `state='beforeCall'` (blockable)
- **tool_result** → conversation `tool` with `state='complete'|'error'`
- **before_provider_request/after_provider_response** → conversation `request`
- **turn_start/turn_end** → conversation `turn`
- **session_before_compact/session_compact** → conversation `compact` (1-to-2 fan-out)
- **model_select/thinking_level_select** → `model.selected`/`model.resolve` (framework events)
- **session_start** → `conversation.created` (framework event)
- **session_shutdown** → `dispose` (framework event)
- **Custom events** → auto-prefixed on `bh.emit`/`bh.on` as `${pluginName}.${eventName}`

### API mappings
- **registerTool**: pi tool definition → `bh.addTool`; `parameters` (JSON Schema) → `inputSchema`; execute wrapped
- **registerCommand**: pi command → `bh.addCommand`; `getArgumentCompletions` → `complete`
- **registerFlag/getFlag**: accumulate flags, call `bh.declareConfig(pluginName, schema)` post-factory; fallback to registered defaults before init
- **sendMessage/sendUserMessage**: target most-recently-created conversation ("single active conversation" assumption); `sendMessage` drives loop, `sendUserMessage` does not
- **TUI-bound stubs** (ui, shortcuts, themes, session): no-op Proxy-wrapped; each call recorded in `warnings` array

## Conventions
- **Subset, not full fidelity**: only portable subset of pi extensions supported. No conversion for pi's TypeBox-based parameters; expect JSON Schema. TUI calls stubbed as diagnosticable no-ops.
- **Flag timing**: flags must be registered during factory's synchronous/awaited execution; `getFlag` before `bh.init()` falls back to defaults.
- **Plugin naming**: derived from enclosing named plugin wrapper, defaults to UUID suffix if unavailable. Used for event prefixing and config namespacing.
- **Blockable events**: all handlers run in registration order, awaited sequentially; returned patches shallow-merge and chain; `{ block: true }` stops handler chain (on `tool(beforeCall)` and `request(before)` only).

## Consumers
- `src/index.ts` re-exports this entry as `@bhzai/core` root export.
- `tsup.config.ts` builds `plugins/interop/pi/index` to `dist/plugins/interop/pi/index.js` + `.d.ts`.
- Hosts with an existing pi extension ecosystem import `@bhzai/core/plugins/interop/pi` to run unmodified pi factories.
