# `src/plugins/interop/opencode/` — OpenCode plugin interop

## Purpose & scope
Adapter bridging a subset of OpenCode plugins onto BHZAI's plugin surface (ARCHITECTURE.md § 12). Lets a host reuse existing OpenCode plugins (capability-object style) without rewriting them.

## Key files
- `index.ts` — Main adapter implementation. Exports `runOpenCodePlugin(plugin, bh, options)` and the context/hooks type definitions.
- `opencode-adapter.test.ts` — Comprehensive integration tests covering all mapped hooks and composition semantics.

## Implementation details
The adapter (`runOpenCodePlugin`) accepts an unmodified OpenCode plugin function, builds a minimal context (project, directory, fetch-based client stub, omitted `$`), and invokes it. The returned hooks object is then mapped onto BHZAI mechanisms:

- **tool hooks**: registered via `bh.addTool()` with schema conversion via the zod-like `.toJSONSchema()` method
- **tool_execute_before/after**: non-blocking observers on `tool(beforeCall)` and `tool(complete|error)` events
- **permission_ask**: blockable subscriber on `tool(beforeCall)` that returns `{ block: true }` on `'deny'`
- **chat.message / chat.params**: conversation event subscribers with mutable output object pattern
- **stop**: turn-end veto hook
- **event**: generic event hook dispatching for idle, message.delta, compact, and conversation.created
- **config**: declared via `bh.declareConfig()` with default-value merging
- **auth**: registered as a tier-2 credential resolver in the § 10.4 chain

All hooks are wired during a wrapper plugin's `initialize` phase, ensuring proper ordering and event-bus access.

## Conventions
- **Subset, not full fidelity**: only OpenCode plugin features that map cleanly onto BHZAI's mechanisms are supported. The `$` shell helper is deliberately omitted (not stubbed) — plugins that shell out will throw a `TypeError`, an accepted limitation.
- **Composing, not bypassing**: `permission.ask` is implemented as just another subscriber on the `tool(beforeCall)` seam, composing with native BHZAI approvers rather than adding a parallel gate (§ 13).
- **Dotted vs nested keys**: The adapter accepts both dotted-string keys (`'tool.execute.before'`) and nested object keys on the returned hooks; both are normalized internally to the nested form for type safety.
- **Schema conversion**: Zod-like schemas are converted via their own `.toJSONSchema()` method (or a provided utility), delegating entirely to standard-schema-compatible helpers rather than reimplementing conversion.

## Consumers
- `src/index.ts` re-exports this entry from `./plugins/interop/opencode/index.js`.
- `tsup.config.ts` builds it to `dist/plugins/interop/opencode/index.js` + `.d.ts`.
- Hosts with an existing OpenCode plugin ecosystem import `@bhzai/core/plugins/interop/opencode` to reuse plugins.
- Tests verify all 9 rows of ARCHITECTURE.md § 8.3 mapping table (with 7 explicitly mapped, 2 with zero OpenCode equivalent).
