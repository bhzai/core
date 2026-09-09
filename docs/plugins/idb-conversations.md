# IndexedDB conversation-store plugin

> Subpath: `@bhzai/core/plugins/idb`
> Source: `src/plugins/idb/index.ts`

## Overview

The `idb` plugin implements the session persistence
interface over IndexedDB, giving browser hosts a zero-dependency
durable conversation persistence layer. Registering it via `bh.use()` makes
the kernel auto-save a snapshot on every `conversation.message(sent)` event
and exposes `bh.conversations.list()` / `load(id)` / `delete(id)` for the
host's UI.

The plugin is browser-targeted: it uses the `indexedDB` global, which is
available in all modern browsers. `initialize()` throws a clear error if
`indexedDB` is undefined, so a non-browser host that accidentally registers
it fails loudly instead of silently no-oping.

## Installation

No peer dependency — `indexedDB` is built into every browser.

```typescript
import { BHZAI } from "@bhzai/core"
import { createIdbConversationStorePlugin } from "@bhzai/core/plugins/idb-conversations"

const bh = new BHZAI()
bh.use(createIdbConversationStorePlugin())
await bh.init()

// Now bh.conversations.list() / load(id) / delete(id) work,
// and every conversation is auto-saved on message(sent).
```

## API

### `createIdbConversationStorePlugin(options?)`

Factory that returns a capability object ready to pass to `bh.use()`.

#### `IdbConversationStoreOptions`

| Option | Type | Default | Description |
|---|---|---|---|
| `dbName` | `string` | `"bhzai-conversations"` | IndexedDB database name |
| `storeName` | `string` | `"conversations"` | Object store name |
| `version` | `number` | `1` | Database version |
| `conversationsLimit` | `number` | `20` | Page size for `list()` and `load-page` |

### Plugin events

All events are prefixed with `idb-conversations.` and emitted on the
framework bus (`bh.on()` / `bh.emit()`). They never collide with the
reserved `conversation.*` namespace.

**Emitted (plugin → consumers):**

| Event | Payload | When |
|---|---|---|
| `idb-conversations.upgradeneeded` | `{ oldVersion, newVersion }` | DB created or version bumped |
| `idb-conversations.success` | `{ operation, id? }` | A generic IDB request succeeded |
| `idb-conversations.error` | `{ operation, error }` | A generic IDB request failed |
| `idb-conversations.count.success` | `{ total }` | A count request succeeded |
| `idb-conversations.count.error` | `{ error }` | A count request failed |
| `idb-conversations.load.success` | `{ conversations, offset, limit, total, hasMore }` | A page load succeeded |
| `idb-conversations.load.error` | `{ offset, limit, error }` | A page load failed |
| `idb-conversations.conversation.loaded` | `{ id, snapshot }` | `store.load(id)` returned a snapshot |
| `idb-conversations.conversation.deleted` | `{ id }` | `store.delete(id)` completed |

**Inbound (consumer → plugin):**

| Event | Payload | Effect |
|---|---|---|
| `idb-conversations.load-page` | `{ offset, limit? }` | Request the next page of conversation summaries |

### Pagination

The plugin supports two pagination modes:

1. **Offset-based** (default for `list()` and `load-page`): pass
   `{ offset, limit }` to `load-page`. The plugin responds with
   `load.success` carrying `{ conversations, offset, limit, total, hasMore }`.

2. **Cursor-based** (for `list({ before })`): pass a timestamp to `before`
   to get conversations older than that timestamp. This is the kernel
   accessor's native pagination shape.

### IndexedDB schema

- **Database**: `bhzai-conversations` (configurable)
- **Object store**: `conversations` (configurable), `keyPath: "id"`
- **Index**: `by-updated-at` on `updatedAt` (non-unique), used for
  newest-first cursor traversal

Each stored record contains the full `ConversationSnapshot` plus derived
fields (`updatedAt`, `messageCount`, `title`) so a cursor read can produce
a `ConversationSummary` without deserializing the whole snapshot.

## Example: sidebar with pagination

```typescript
import { BHZAI } from "@bhzai/core"
import { createIdbConversationStorePlugin, IdbConversationEvents } from "@bhzai/core/plugins/idb-conversations"

const bh = new BHZAI()
bh.use(createIdbConversationStorePlugin({ conversationsLimit: 20 }))
await bh.init()

// Listen for page loads
bh.on(IdbConversationEvents.loadSuccess, ({ conversations, hasMore }) => {
  console.log(`Loaded ${conversations.length} conversations, hasMore: ${hasMore}`)
  for (const c of conversations) {
    console.log(`  ${c.id} — ${c.title ?? "Untitled"} — ${c.messageCount} msgs`)
  }
})

// Request the first page
await bh.emit(IdbConversationEvents.loadPage, { offset: 0 })

// Load a past conversation
const snapshot = await bh.conversations.load("some-conversation-id")
if (snapshot) {
  const conv = await bh.loadConversation(snapshot)
  // ... use conv
}

// Delete a conversation
await bh.conversations.delete("some-conversation-id")
```

## Testing

The co-located test (`index.test.ts`) uses `fake-indexeddb` as a dev
dependency to provide the `indexedDB` global in Node. The plugin itself
never imports a polyfill — it only uses the `indexedDB` global.
