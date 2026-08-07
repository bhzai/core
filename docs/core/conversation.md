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
| `agent-loop.ts`          | 0025, 0026, 0027, 0030 | `sendMessage()` (20-line thin entry point), `runAgentLoop()` (bounded while-loop orchestrator), `executeToolBatch()` (31-line thin orchestrator for tool-call batches), `addMessage()`, the `context` event, `deliverAs` steering, `waitForIdle()`, the `idle` event. All orchestration delegates to `src/tools/agent-loop-helpers.ts`. |
| `agent-loop-helpers.ts` (in `src/tools/`) | —    | 25 extracted, unit-testable helpers: `handleBusyEntry`, `prepareUserMessage`, `resolveDriverForTurn`, `drainSteerQueue`, `fireTurnStart`, `buildContextForTurn`, `applyContextBudget`, `executeDriverTurn`, `consumeDriverStream`, `recordToolCallsOnMessage`, `maybeAutoCompact`, `resolvePendingSteers`, `checkTurnTermination`, `handleTurnVeto`, `handleLoopExit`, `checkMaxIterations`, `isAllTerminate`, `filterToolCalls`, `partitionToolCalls`, `validateToolCall`, `executeToolWithAbortRace`, `applyCompleteEventPatch`, `executeSingleToolCall`, `runToolBatchExecution`, `appendToolResultMessages`, plus shared `constructMessage` utility. |
| `snapshot.ts`            | 0028         | `toJSON()`/`toSnapshot()`, `fromSnapshot()` (the full, versioned `loadConversation()` contract), truncated-prefix support for host-side forking. |
| `compaction.ts`          | 0031         | `conversation.compact()`, auto-compaction, `conversation.emit('compact', ...)` interception, the `compact` event's `before`/`compacting`/`complete` states. |

Plus, in `src/core/`: `bhzai.ts` (`createConversation`/`loadConversation`,
`_dispatch`/`_getDriver`/`_getTool`/`_hostSystemPrompt` internal accessors),
`storage.ts` (TASK_0029 — `ConversationStore` auto-save wiring and
`bh.conversations.list()`), `models.ts` (TASK_0022, cross-group — model ref
parsing/resolution consumed by the loop to find a driver), `retry.ts`
(TASK_0018, cross-group — `callDriverWithRetry`, the `request` event).

## The agent loop, in order

`sendMessage(content, options?)` is a 20-line thin entry point that delegates
to extracted helpers in `src/tools/agent-loop-helpers.ts` (each unit-tested in
isolation). The internal `runAgentLoop()` function owns the bounded while-loop:

1. **`handleBusyEntry()`** — busy-check: if `conversation.status !== 'idle'`,
   branch on `options.deliverAs` (`'immediate'` default rejects with
   `ConversationBusyError`; `'steer'`/`'followUp'` queue and return a promise
   that resolves once delivered).
2. **`prepareUserMessage()`** — `ensureStarted()`, fire `loop(start)`, fire
   `message(before)` (blockable), handle blocked result, apply patches, fire
   `message(waiting)`, set `status: 'streaming'`.
3. **`runAgentLoop()`** — bounded loop (`maxIterations`, default 8), each iteration:
   - **`drainSteerQueue()`** — drain steer queue, fire `message(before)` per entry.
   - **`fireTurnStart()`** — fire `turn(start)`.
   - **`resolveDriverForTurn()`** — resolve model ref, look up driver, read capabilities.
   - **`buildContextForTurn()`** — `context` event → apply patches → resolve tools.
   - **`applyContextBudget()`** — pre-flight context-window check, compaction, prompt compaction.
   - **`executeDriverTurn()`** — build `ChatRequest`, call driver via retry wrapper,
     **`consumeDriverStream()`** (deltas, reasoning, usage, tool-call buffering, done,
     with think-splitting and timeout), **`recordToolCallsOnMessage()`**, push message,
     fire `message(sent)`.
   - **`maybeAutoCompact()`** — check context window, trigger background compaction.
   - **`resolvePendingSteers()`** — settle steer promises with the assistant message.
   - Execute tool batch (if `stopReason === 'tool-calls'`) via `executeToolBatch()`,
     which delegates to: `filterToolCalls`, `partitionToolCalls`,
     `executeSingleToolCall` (validate → beforeCall → call → `executeToolWithAbortRace`
     → complete with `applyCompleteEventPatch`), `runToolBatchExecution` (concurrency),
     `appendToolResultMessages` (push results to history).
   - **`checkTurnTermination()`** — fire `turn(end)`, check veto (`continueWith`),
     check natural stop / all-terminate.
   - **`handleTurnVeto()`** — inject synthetic continuation if vetoed.
   - **`checkMaxIterations()`** — check iteration bound, flag `truncatedBy`.
4. **`handleLoopExit()`** — abort check, fire `loop(end)`, transition to idle or
   kick off queued followUp.

Pure-logic helpers: **`isAllTerminate()`** (check if all tool results carry
`BHZAI/terminate: true`).

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
- **`meta.toolCalls: ToolCallRecord[]`** — the tool calls an assistant message
  asked for, recorded as `{ id, name, arguments }` (arguments is the raw JSON
  string). Set by the agent loop on any turn that produced tool calls, and paired
  with the tool-result messages' `meta.toolCallId` / `meta.toolName`. The loop's
  tool-call buffer is per-iteration, so without this record the calls are
  unrecoverable from history — which breaks two things: drivers whose provider
  validates conversation structure (OpenAI rejects a `tool` message whose
  preceding assistant message does not advertise the matching id, so its driver
  rebuilds the pairing from this), and anything replaying history after a snapshot
  restore. Plain JSON by design, so it round-trips through `snapshot.ts` unchanged.
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
(no default), `retryPolicy`, `compaction: { auto, reserveTokens, model? }`,
`outputReserve` (default: `compaction?.reserveTokens ?? 1024`),
`promptCompaction` (default: `true`), `parseThink` (`false`), `systemPrompt`,
`model`. All optional, all documented with their defaults on the interface in
`conversation.ts`.

`parseThink: true` makes the loop split `<think>...</think>` out of the driver's
text stream as it arrives (`think-stream.ts`, one splitter per assistant turn):
tag content accumulates on `message.think` and dispatches as `kind: 'reasoning'`,
everything else becomes the message body and dispatches as `kind: 'text'`. Tags
split across chunk boundaries are handled, and empty deltas are never
dispatched. It exists because some reasoning models have no native reasoning
channel and inline their chain of thought into ordinary text; without it every
consumer reimplements the same parser.

## Context budget and pre-flight context management

The kernel tracks context-window usage to prevent sending requests that exceed
the model's context length (which would cause a provider 400 error).

### `contextUsage` — last turn's real token counts

`conversation.contextUsage` exposes the token counts the driver reported for
the **most recent** LLM call:

- `lastInputTokens` — the actual context size the provider processed (not a
  cumulative sum). This is the precise basis for context-window management.
- `lastOutputTokens` — the completion tokens for the last turn.
- `lastTotalTokens` — the total (`input + output`) when the provider reports it.

Each field is `undefined` until the driver reports it (first turn, or a driver
that doesn't report usage). This is distinct from `conversation.usage`, which
is **cumulative** across the conversation's lifetime (used for billing/usage
tracking, not context management).

### Pre-flight context check (`context-budget.ts`)

Before each turn, the agent loop calls `fitContextToWindow()` to check whether
the request fits within the driver's `contextWindow`:

1. If `lastInputTokens` is available, use it as the precise base context size
   and heuristically estimate only the delta (new messages since the last turn).
2. For the first turn, estimate all messages heuristically (~4 chars/token).
3. If `estimatedTotal + outputReserve <= contextWindow`, send all messages.
4. If over, trigger compaction first (if `compaction.auto` is set), then re-check.
5. If still over, trim oldest messages from the front (preserving the system
   prompt and the most recent user message).
6. If even the system prompt + most recent user message don't fit, trigger
   prompt compaction (if `promptCompaction` is not `false`).

### `outputReserve`

Number of tokens reserved for the model's output within the context window.
The pre-flight check ensures `estimatedInputTokens + outputReserve <=
contextWindow`. Defaults to `compaction?.reserveTokens ?? 1024`.

### `compaction.model`

Optional qualified `'<driver>/<model>'` ref for a cheaper/faster model to use
for summarization in compaction and prompt compaction. Defaults to the
conversation's active model. The model must be in the merged catalogue
(`bh.listModels()`); if not found, compaction falls back to the default
resolution path.

### Prompt compaction (`prompt-compaction.ts`)

When a single user message exceeds the context window (after all history has
been compacted/trimmed), the core splits it into chunks, summarizes each via
`bh.complete()`, and replaces the message with the concatenated summary. A
`prompt_compactation` event is fired so plugins can intercept and provide a
custom strategy. Set `promptCompaction: false` to disable — the request is sent
as-is and the driver's error surfaces to the caller.

### Auto-compaction fix

The auto-compaction check now uses `contextUsage.lastInputTokens` (the real
context size) instead of the cumulative `usage.inputTokens + usage.outputTokens`.
The cumulative sum over-counted because each turn's input tokens already include
prior messages, triggering compaction far too early.

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
