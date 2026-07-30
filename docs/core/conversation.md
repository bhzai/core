# Conversations & the Agent Loop (`src/conversation/`)

Documentation for the `BHZAIConversation` surface and the agent loop —
Phase 4 of the BHZAI implementation (TASK_0023–TASK_0031). Architecture
reference: ARCHITECTURE.md §§ 8.5, 11.

## Overview

`bh.createConversation(options?)` / `bh.loadConversation(snapshot, options?)`
(in `src/core/bhzai.ts`) construct a `BHZAIConversationImpl` (in
`src/conversation/conversation.ts`), the primary object hosts interact with.
Every conversation owns a private `EventBus` (reused verbatim from
`src/core/event-bus.ts`) whose events are transparently mirrored onto the
framework bus as `conversation.<event>` — the mirroring mechanic documented
in ARCHITECTURE.md § 8.1 and implemented once, in
`BHZAIConversationImpl`'s internal `dispatchConversationEvent`/
`_dispatchConversationEvent` method, reused by every later firing point
(`start`, `message`, `context`, `tool`, `turn`, `request`, `compact`, `idle`,
`abort`).

## Files

| File                     | Task(s)      | Responsibility                                                                                 |
| ------------------------ | ------------ | ------------------------------------------------------------------------------------------------ |
| `conversation.ts`        | 0023–0031    | `BHZAIConversationImpl`, the mirrored event-bus mechanic, all `@internal` accessors other conversation modules use, `CreateConversationOptions`. |
| `system-prompt.ts`       | 0024         | Four-layer system-prompt assembly (host default → per-conversation override → `start` patches → `context` patches), `ensureStarted()`, `prepend` message handling. |
| `agent-loop.ts`          | 0025, 0026, 0027, 0030 | `sendMessage()`/`addMessage()`, the `context` event, tool-call execution (`beforeCall→call→processing*→complete\|error`, concurrency/serial batching, validate-and-repair), the bounded, multi-turn loop and its four termination conditions, `deliverAs` steering (`immediate`/`steer`/`followUp`), `waitForIdle()`, the `idle` event. |
| `snapshot.ts`            | 0028         | `toJSON()`/`toSnapshot()`, `fromSnapshot()` (the full, versioned `loadConversation()` contract), truncated-prefix support for host-side forking. |
| `compaction.ts`          | 0031         | `conversation.compact()`, auto-compaction, `conversation.emit('compact', ...)` interception, the `compact` event's `before`/`compacting`/`complete` states. |

Plus, in `src/core/`: `bhzai.ts` (`createConversation`/`loadConversation`,
`_dispatch`/`_getDriver`/`_getTool`/`_hostSystemPrompt` internal accessors),
`storage.ts` (TASK_0029 — `ConversationStore` auto-save wiring and
`bh.conversations.list()`), `models.ts` (TASK_0022, cross-group — model ref
parsing/resolution consumed by the loop to find a driver), `retry.ts`
(TASK_0018, cross-group — `callDriverWithRetry`, the `request` event).

## The agent loop, in order

`sendMessage(content, options?)`:

1. Busy-check: if `conversation.status !== 'idle'`, branch on
   `options.deliverAs` (`'immediate'` default rejects with
   `ConversationBusyError`; `'steer'`/`'followUp'` queue and return a promise
   that resolves once delivered).
2. `ensureStarted()` (TASK_0024) — fires `start` once, lazily, applying
   system-prompt patches and `prepend` messages.
3. `loop(start)`.
4. `message(before)` (blockable) → `message(waiting)` → `status: 'streaming'`.
5. Bounded loop (`maxIterations`, default 8), each iteration:
   - Drain the steer queue (delivered before this iteration's `context`).
   - `turn(start)`.
   - `context` (deep-copied payload; patches replace wholesale) → resolve
     driver/tools → `ChatRequest` → `callDriverWithRetry` (`request`
     `before`/`retry*`/`after`) → stream consumption (`message.delta`,
     `usage` accumulation, tool-call buffering).
   - `message(sent)` for the assistant message.
   - If `stopReason === 'tool-calls'`: run the tool-execution pipeline
     (concurrent-by-default, `serial`/`serialTools` opt-outs, original-order
     result reordering, validate-and-repair up to `maxToolRepairs`).
   - Auto-compaction check (if `compaction.auto` is set and the driver
     reports a `contextWindow`).
   - `turn(end)` (veto via `{ continueWith }` — still counts toward
     `maxIterations`).
   - Termination check: natural stop, universal `_meta['BHZAI/terminate']`
     hint, `maxIterations`, or `abort()`.
6. `loop(end)` → `status: 'idle'` → deliver one queued `followUp` (starts a
   new run) or fire `idle` if both queues are empty.

`addMessage(content, role, options?)` inserts a message directly
(`message(sent)` only, no loop).

## Conventions established here

- **`meta.contextIncluded: boolean`** (default `true`) — messages excluded
  from `context`/compaction via `effectiveContextMessages()` (exported from
  `agent-loop.ts`) carry `meta.contextIncluded === false`. Used by
  `prepend` (TASK_0024), `addMessage({ contextIncluded: false })`
  (TASK_0025), and compaction folding (TASK_0031).
- **Blocked-message contract**: a blocked `message(before)` resolves (never
  rejects) `sendMessage()`'s promise with `meta.blocked: true` /
  `meta.blockedReason`.
- **`meta.truncatedBy: 'max-iterations'`** — the one documented exception to
  "messages are immutable once sent," set on the last assistant message when
  the loop is cut off by `maxIterations`.
- **History is never deleted** — compaction only ever marks
  `meta.contextIncluded = false` and inserts a `role: 'system'` summary
  message; snapshots always contain the complete transcript.
- **`meta.reasoning: string`** — a driver's *native* `reasoning-delta` channel,
  accumulated on the assistant message and mirrored as `message.delta` with
  `kind: 'reasoning'`.
- **`meta.think: string`** — reasoning extracted from `<think>` tags in the
  model's own *text* stream when the conversation was created with
  `parseThink: true`. Exposed as `message.think` through the message-field
  contract (see below) and dispatched on the same `kind: 'reasoning'` channel
  as `meta.reasoning`, so consumers handle one shape either way.
- **`meta.aborted` / `meta.synthetic` / `meta.compactionSummary`** — set by the
  abort path, the `turn(end)` continuation path, and compaction respectively.

## Message construction and the open message-field contract

Every `BHZAIMessage` is built by `createMessage()` in `message.ts` — the agent
loop, `prepend` handling, compaction summaries, and snapshot restore all route
through it, so a message is shaped identically wherever it came from. Pass
`{ mutable: false }` for messages that are finalized by construction; their
`append`/`setContent` throw, per § 11.1.

`bh.defineMessageField(name, { metaKey?, default? })` installs a **non-enumerable
accessor** on every message the kernel builds, reading and writing one key in
`meta`. Plugins get `message.myField` ergonomics while the value persists through
the `meta` channel that already round-trips; because the accessor is
non-enumerable it never leaks into `JSON.stringify` or a snapshot's wire shape.

Declare the type by module augmentation:

```ts
declare module "@bhzai/core" {
  interface BHZAIMessageExtensions {
    sentiment?: "positive" | "negative"
  }
}

bh.defineMessageField("sentiment")
```

One trap worth knowing when touching the loop: a bare `{ ...message }` spread
drops the accessors. Use `withMessageFields(message, patch, fields)` instead —
this is why a `message(before)` handler's patch does not silently strip plugin
fields from the message that lands in history.

## Guardrails (`CreateConversationOptions`)

`maxIterations` (8), `maxToolRepairs` (2), `serialTools`, `turnTimeoutMs`
(no default), `retryPolicy`, `compaction: { auto, reserveTokens }`,
`parseThink` (`false`), `systemPrompt`, `model`. All optional, all documented
with their defaults on the interface in `conversation.ts`.

`parseThink: true` makes the loop split `<think>...</think>` out of the driver's
text stream as it arrives (`think-stream.ts`, one splitter per assistant turn):
tag content accumulates on `message.think` and dispatches as `kind: 'reasoning'`,
everything else becomes the message body and dispatches as `kind: 'text'`. Tags
split across chunk boundaries are handled, and empty deltas are never
dispatched. It exists because some reasoning models have no native reasoning
channel and inline their chain of thought into ordinary text; without it every
consumer reimplements the same parser.

## Storage (no implementations in v1)

`ConversationStore`/`MemoryStore`/`SkillResolver` (`src/types/storage.ts`)
are interfaces only. `src/core/storage.ts` auto-saves on `message(sent)` when
a plugin registers a `conversationStore` capability (last-registered wins),
and backs `bh.conversations.list()`; with no store registered, both are
no-ops/clear-error respectively — never a silent empty result.

## Known deviations from the literal task text

- TASK_0031 instructs modifying `src/core/event-bus.ts` to intercept
  `emit('compact', ...)`. This was deliberately NOT done there — `EventBus`
  is scope-agnostic by design (its own header comment says so, and the same
  class backs both the framework bus and every conversation's bus). The
  interception lives in `BHZAIConversationImpl.emit()` instead, which already
  knows about compaction; `bh.emit('compact', ...)` on the framework bus
  throws a clear error instead, since compaction is inherently
  conversation-scoped.
