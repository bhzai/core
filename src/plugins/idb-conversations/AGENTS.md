# `src/plugins/idb-conversations/` — IndexedDB conversation-store plugin

## Purpose & scope

A browser-targeted plugin that implements the kernel's `ConversationStore`
interface (§ 11.4) over IndexedDB. Registering it via `bh.use()` makes the
kernel auto-save a snapshot on every `conversation.message(sent)` event and
exposes `bh.conversations.list()` / `load(id)` / `delete(id)` for the host's
UI. The plugin is storage-agnostic from the kernel's perspective — it only
uses the `indexedDB` global, never a polyfill directly.

## Files

- **index.ts** — subpath entry. Exports `createIdbConversationStorePlugin`
  (factory returning a capability object), `IdbConversationStoreOptions`,
  `IdbConversationEvents` (event-name constants), and all event payload
  types. Implements `ConversationStore` with IndexedDB CRUD, offset-based
  and cursor-based pagination, and `idb-conversations.*` plugin events.
- **index.test.ts** — 17 tests covering store CRUD (save/load/list/delete),
  emitted events (upgradeneeded, success, conversation.loaded/deleted,
  count.success, load.success), pagination (load-page with custom and
  default limits), auto-save wiring through the kernel, custom DB/store
  names, and the "IndexedDB unavailable" error path. Uses `fake-indexeddb`
  as a dev dependency for the `indexedDB` global.

## Conventions

- **No peer deps**: the plugin uses only the `indexedDB` global (built into
  every browser). `fake-indexeddb` is a dev dependency for tests only.
- **Plugin events**: all emitted events are prefixed with
  `idb-conversations.`, which does not collide with the kernel-reserved
  `conversation.*` namespace. See `IdbConversationEvents` for the full table.
- **Pagination**: two modes — offset-based (default for `list()` and the
  inbound `load-page` event) and cursor-based (for `list({ before })`).
- **IndexedDB schema**: single object store with `keyPath: "id"` and an
  index on `updatedAt` for newest-first cursor traversal. Each stored
  record carries the full snapshot plus derived summary fields.
- **Lifecycle**: `initialize()` opens the DB and subscribes to the
  `load-page` inbound event; `dispose()` closes the DB and unsubscribes.

## Consumers

- `src/index.ts` re-exports this entry.
- `tsup.config.ts` builds it to `dist/plugins/idb-conversations/index.js` + `.d.ts`.
- `example/src/main.ts` registers it and wires the conversations sidebar.
- Hosts import `@bhzai/core/plugins/idb-conversations` and pass the plugin
  to `bh.use()`.
