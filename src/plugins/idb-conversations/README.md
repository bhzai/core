# idb-conversations

> Subpath: `@bhzai/core/plugins/idb-conversations`

A browser-targeted plugin that implements the kernel's `ConversationStore`
interface over IndexedDB, giving browser hosts a zero-dependency durable
conversation persistence layer.

## Usage

```typescript
import { BHZAI } from "@bhzai/core"
import { createIdbConversationStorePlugin } from "@bhzai/core/plugins/idb-conversations"

const bh = new BHZAI()

// Register the plugin before init().
bh.use(createIdbConversationStorePlugin({
  dbName: "bhzai-conversations",   // default
  storeName: "conversations",       // default
  version: 1,                       // default
  conversationsLimit: 20,           // default page size
}))

await bh.init()

// Now the kernel auto-saves on every conversation.message(sent),
// and bh.conversations.list() / load(id) / delete(id) work.
const conversations = await bh.conversations.list()
const snapshot = await bh.conversations.load("some-id")
await bh.conversations.delete("some-id")
```

## Events

The plugin emits `idb-conversations.*` events on the framework bus:

- `idb-conversations.upgradeneeded` — DB created or version bumped
- `idb-conversations.success` — a generic IDB request succeeded
- `idb-conversations.error` — a generic IDB request failed
- `idb-conversations.count.success` / `count.error` — count results
- `idb-conversations.load.success` / `load.error` — page load results
- `idb-conversations.conversation.loaded` — `store.load(id)` returned a snapshot
- `idb-conversations.conversation.deleted` — `store.delete(id)` completed

Inbound event (consumer → plugin):

- `idb-conversations.load-page` — `{ offset, limit? }` — request the next page

## Pagination

Offset-based (default): emit `idb-conversations.load-page` with
`{ offset, limit }`. Cursor-based: call `bh.conversations.list({ before })`
with a timestamp.

## Documentation

See `docs/plugins/idb-conversations.md` for full API details.
