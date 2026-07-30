# Core events

This document lists every event the BHZAI kernel dispatches, the name pattern it
follows, and the exact timing of dispatch. All framework events travel through
the single `EventBus` instance owned by the `BHZAI` kernel (see `event-bus.md`)
and are published with `bh.on(event, handler)`.

## Reserved namespace

The following patterns are reserved; public `bh.emit()` calls throw for them.
Only the kernel may dispatch them, via the internal `EventBus.dispatch()` bypass:

- `conversation.*`
- `driver.*`
- `mcp.*`
- `config.*`
- `model.*`
- `models.*`

The exact reserved name `compact` is also reserved, but is the one name plugins
are explicitly allowed to `emit()` (it triggers the compaction pipeline).

## Framework events

| Event | Pattern | Payload | Dispatched when |
| --- | --- | --- | --- |
| `initialize` | exact | `{ bh }` | After all `init()` hooks, config resolution, `modelSource`/`getMcps` resolution, and the first model-catalogue sync have completed. |
| `dispose` | exact | `{ bh }` | At the start of `bh.dispose()`, before any teardown hooks run. |
| `error` | exact | `{ error, source }` | When a handler throws or an async kernel operation (e.g. `addDriver` model fetch, `listModels()`) rejects and is caught by the bus. |
| `config.changed` | prefix | `{ pluginName, values }` | After `bh.setConfig()` is called post-`init()`, with the merged (host + default) values for the affected plugin. |
| `tool.registered` | prefix | `{ tool }` | After `bh.addTool()` succeeds. |
| `tool.removed` | prefix | `{ tool }` | After `bh.removeTool()` succeeds. |
| `driver.registered` | prefix | `{ driver }` | After `bh.addDriver()` registers the driver, before the asynchronous model fetch. |
| `mcp.attached` | prefix | `{ server, tools }` | After `bh.addMcp()` successfully attaches a server and discovers its tools. |
| `model.resolve` | prefix | `{ catalogue, conversation }` | During model-resolution (`createConversation`, `complete`, `embed`) when a model ref is resolved against the merged catalogue. |
| `model.added` | prefix | `{ driver, model }` | For every model that appears in the merged catalogue on a `listModels()` refresh. |
| `model.changed` | prefix | `{ driver, model, previous }` | For every model already in the catalogue whose `label`, `availability`, `capabilities`, or `meta` changed since the last refresh. |
| `model.removed` | prefix | `{ driver, model }` | For every model that disappears from the merged catalogue on a `listModels()` refresh. |
| `models.changed` | prefix | `{ added, removed, changed }` | Once after all `model.added`/`model.changed`/`model.removed` events for a single refresh have settled. `changed` entries are `{ model, previous }`. |
| `model.selected` | prefix | `{ model, previousModel, source }` | When a conversation's active model is switched (`setModel` applied or queued). `source` is `'set'`, `'load'`, or `'resolve'`. |

All `model.*` and `models.*` events are dispatched by `BHZAI.listModels()` and
its callers (`addDriver`, `init`, `enablePlugin`/`disablePlugin`).

## Conversation events (mirrored)

Every conversation-level event is also re-dispatched on the framework bus
prefixed with `conversation.`:

| Event | Pattern | Payload | Dispatched when |
| --- | --- | --- | --- |
| `created` | exact | `{ conversation }` | After `createConversation()` returns. |
| `loaded` | exact | `{ conversation }` | After a stored conversation is loaded. |
| `start` | exact | `{ conversation }` | At the start of a user turn, before the first LLM call. |
| `message` | exact | `{ conversation, message }` | When a full message is committed to the conversation. |
| `message.delta` | prefix | `{ conversation, message, ... }` | For every streaming chunk before the message is finalized. |
| `context` | exact | `{ conversation, context }` | After the request context is assembled. |
| `request` | exact | `{ conversation, request }` | After the request is sent to the driver. |
| `turn` | exact | `{ conversation, turn }` | Around a driver turn boundary. |
| `loop` | exact | `{ conversation }` | Around agent-loop iteration boundaries. |
| `tool` | exact | `{ conversation, tool, state }` | When a tool is invoked or completes. |
| `abort` | exact | `{ conversation }` | When a turn is aborted. |
| `compact` | exact | `{ conversation }` | After compaction completes. `compact` is the one reserved name a plugin may `emit()`. |
| `meta.changed` | prefix | `{ conversation, meta }` | When conversation metadata changes. |
| `idle` | exact | `{ conversation }` | When the conversation returns to idle. |

The framework mirror name is `conversation.<event>` (e.g.
`conversation.message.delta`). Full payload details and timing are documented in
`docs/core/conversation.md`.
