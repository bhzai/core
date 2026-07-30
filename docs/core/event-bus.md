# Event Bus (`src/core/event-bus.ts`)

Documentation for the framework event bus. Architecture reference:
ARCHITECTURE.md § 8.

## Overview

`EventBus` is the single dispatch mechanism underpinning every observable
behavior in BHZAI. One instance lives on each `BHZAI` kernel (the framework
bus); TASK_0023 will instantiate one per `Conversation` too, reusing this
exact class unchanged.

It implements § 8.2's five handler-semantics rules and § 8.4's emission
asymmetry:

1. **Sequential awaited dispatch** — handlers run in registration order,
   each awaited before the next.
2. **Patch chaining** — a handler may return a partial patch object that
   shallow-merges into the running payload before the next handler runs.
3. **Blockable pipelines** — on a dispatch made with `{ blockable: true }`,
   a handler returning `{ block: true, reason? }` stops the chain. On a
   non-blockable dispatch the same return is merged in like any other
   patch with no special stopping behavior.
4. **Error containment** — a handler that throws is caught, its error
   rerouted to the `error` framework event, and treated as "no patch".
   The remaining handlers still run.
5. **Global FIFO serialization** — re-entrant emissions (an emission
   triggered from inside a handler) are queued and run after the current
   dispatch completes, preserving order.

## Public API

```typescript
import { EventBus, type Handler, type BlockSignal } from "@bhzai/core";
```

### `EventBus`

```typescript
class EventBus {
  on<Payload>(event: string, handler: Handler<Payload>): Unsubscribe;
  emit<Payload>(event: string, payload: Payload, options?: DispatchOptions): Promise<EmitResult<Payload>>;
  dispatch<Payload>(event: string, payload: Payload, options?: DispatchOptions): Promise<EmitResult<Payload>>;
}
```

- `on(event, handler)` — register a handler. Returns an `Unsubscribe`
  function. Handlers are stored in an ordered list per event name.
- `emit(event, payload, options?)` — **public entrypoint**. Throws
  synchronously on reserved/un-namespaced event names (see below) unless
  bypassed. Returns an `EmitResult`.
- `dispatch(event, payload, options?)` — **internal entrypoint** for
  kernel-originated events. Bypasses the reserved-name check. This is
  how the kernel fires `initialize`, `dispose`, `error`, `config.changed`,
  `tool.registered`, `tool.removed`, `driver.registered`, `mcp.attached`,
  `model.added`, `model.changed`, `model.removed`, `models.changed`.

### `Handler<Payload>`

A handler receives the current (possibly already-patched) payload and may
return:

- `undefined`/`void` — observe-only, no patch.
- a partial patch object — shallow-merged into the running payload.
- a `BlockSignal` (`{ block: true, reason? }`) — on a blockable dispatch,
  stops the chain.
- a Promise resolving to any of the above.

### `DispatchOptions`

- `blockable?: boolean` — whether a `BlockSignal` return actually stops
  later handlers. Defaults to `false`. Caller-supplied rather than
  hardcoded per event name: the § 8.1 tables (which mark specific named
  events as blockable) are owned by whichever task fires each event, so
  the bus stays decoupled from any closed set of event names.

### `EmitResult<Payload>`

```typescript
interface EmitResult<Payload> {
  blocked: boolean;        // whether a handler blocked the chain
  reason?: string;         // block reason, if any
  patch: Partial<Payload>; // merged patch object
  handled: number;         // number of handlers that ran
}
```

## Reserved namespace enforcement (§ 8.4)

The public `emit()` rejects events whose names fall in the kernel-reserved
set (e.g. `initialize`, `dispose`, `error`, `config.*`,
`tool.registered`, `tool.removed`, `driver.registered`, `mcp.attached`,
`model.*`, `models.*`, `conversation.*`).
Only the kernel may dispatch these, via the internal `dispatch()` bypass.

**One documented exception**: emitting `compact` from a plugin is
permitted — it triggers the compaction pipeline (§ 8.4). This is the only
reserved name a plugin may `emit()`.

## Environment boundary

`event-bus.ts` touches nothing outside of plain TypeScript — no `fetch`,
no `crypto`, no timers. It is runtime-agnostic and safe to instantiate in
any environment.

## Test coverage

29 tests in `src/core/event-bus.test.ts`:

- Registration-order sequential await dispatch.
- Patch chaining (shallow merge across multiple handlers).
- Blockable dispatch: `{ block: true }` stops the chain; non-blockable
  dispatch treats it as an ordinary patch.
- Handler exception containment + rerouting to `error`.
- Re-entrant emissions queued via global FIFO.
- Reserved-namespace enforcement on public `emit()` (throws).
- `dispatch()` bypass for kernel-originated events.
- `compact` exception (plugins may emit it).
- Zero-subscriber emissions are valid and return a no-op `EmitResult`.
- `Unsubscribe` removes a handler.
