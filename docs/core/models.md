# Model selection & switching

> Source: `src/core/models.ts`
> Task: TASK_0022
> Architecture: § 10.5

## Overview

This module is the glue that makes the driver registry (TASK_0009), the two
bundled drivers (TASK_0019/TASK_0020), and `modelSource` plugin
contributions (TASK_0015) into one coherent, host-consumable model picker.
It implements: qualified/bare model-reference parsing with ambiguity
detection, the full catalogue merge behind `bh.listModels()`, the
four-tier resolution order that picks a model for a conversation, and
`setModel(ref)`'s switching semantics.

## Identity — qualified refs

A model is addressed by `'<driverId>/<modelId>'` (e.g.
`'ollama/llama3.3:70b'`, `'webllm/Llama-3.2-3B-Instruct-q4f16_1-MLC'`).

### `parseModelRef(ref)`

Splits on the **first** `/` only — model ids can contain `:` (Ollama tags)
or even `/` (Hugging-Face-style naming). Returns `null` for bare ids (no
`/`), which are handled by `resolveModelRef`.

```typescript
parseModelRef("ollama/llama3.3:70b")  // { driver: 'ollama', id: 'llama3.3:70b' }
parseModelRef("webllm/meta/Llama-3")  // { driver: 'webllm', id: 'meta/Llama-3' }
parseModelRef("llama3.3:70b")         // null (bare id)
```

### `resolveModelRef(ref, catalogue)`

Resolves a bare or qualified ref against a catalogue, returning a
fully-qualified ref:

- Qualified ref with exact match → return unchanged.
- Bare id with exactly one match → return its qualified ref.
- Bare id with multiple matches → throw `AmbiguousModelError` (lists all
  qualified alternatives).
- No match → throw `ModelNotFoundError`.

## Discovery — catalogue merge

### `listModels(drivers, modelSourceContributions)`

Merges driver-reported models and `modelSource` plugin contributions:

1. Each driver's `listModels()` output, as-is.
2. `modelSource` contributions, with one kernel-enforced rule: entries
   whose `driver` doesn't match a registered driver are forced to
   `availability: 'unavailable'`. Entries with a matching driver are left
   as-is.
3. Duplicate refs (driver + modelSource): driver entry wins.

## Resolution — four-tier order

### `resolveConversationModel(options)`

| Tier | Source | Behavior |
|---|---|---|
| 1 | `explicitModel` | `createConversation({ model })` — always wins ordering, still validated |
| 2 | `defaultModel` | `new BHZAI({ defaultModel })` — consulted if tier 1 absent |
| 3 | `model.resolve` event | Blockable framework event; handler returns `{ model }` |
| 4 | First `'ready'` entry | Catalogue iteration order; does NOT fall back to `'downloadable'` |

If no tier produces a ref, throws `NoModelError`.

## Switching — `setModel`

### `setModel(state, ref, source, emitModelChanged)`

1. **Validation**: `resolveModelRef` qualifies the ref. `'unavailable'` →
   throws `ModelUnavailableError`. `'downloadable'` → accepted (next
   `chat()` triggers download).
2. **Timing**: if `isStreaming()` is true, the switch is queued (mirrors
   § 11.5's `'steer'` timing — "after the current turn's tool calls
   settle, before the next LLM call"). Caller can `abort()` first for
   immediate mid-stream switch.
3. **History porting**: no special code — each driver maps `BHZAIMessage[]`
   to its own wire format at `chat()` call time.
4. **Capability re-application**: new model's `capabilities()` govern the
   next `chat()` call; this function only ensures `activeModelRef` is
   updated before the next cycle reads it.
5. **`model.selected` event**: fires with `{ model, previousModel, source }`
   once the switch takes effect (immediately or at deferred application
   point). `source` is `'set'`, `'load'`, or `'resolve'`.

   Note: this is the **active-model selection** event, not the catalogue
   lifecycle `model.changed` event emitted by `bh.listModels()`.

## Error types

| Error | Thrown by | Meaning |
|---|---|---|
| `AmbiguousModelError` | `resolveModelRef` | Bare id matches multiple drivers; lists alternatives |
| `ModelNotFoundError` | `resolveModelRef` | Ref doesn't exist in catalogue at all |
| `NoModelError` | `resolveConversationModel` | No tier produced a usable ref |
| `ModelUnavailableError` | `setModel` | Target model's `availability` is `'unavailable'` |
