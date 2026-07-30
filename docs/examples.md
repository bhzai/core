# Reference example plugins (`examples/`)

The `examples/` directory contains working reference plugins that serve as
fitness tests for the kernel's extension surface. Each plugin demonstrates
real, production-quality code patterns using ONLY public kernel API
(ARCHITECTURE.md §§ 6–11). If a plugin requires a kernel API change to work,
that indicates the kernel's extension surface is incomplete — not that the
plugin needs a workaround.

## Three working plugins

### Task-management plugin (`task-plugin.ts`, TASK_0036)

A plugin implementing a per-conversation task list, showing:
- Plugin authoring (form 2, capability object)
- Event subscription (`context`, `turn(end)`)
- Per-conversation plugin state (task list held in a `WeakMap`)
- Tool registration (`update_tasks` tool)
- `context` event injection (task state into system context)
- `turn(end)` veto (blocking loop continuation based on task completeness)

6 tests verify basic flow, state isolation, and event ordering.

### Agent-memory plugin (`memory-plugin.ts`, TASK_0037)

A plugin implementing conversational memory extraction and recall, showing:
- Lifecycle hooks (`initialize`, `start`)
- Fact extraction using `bh.complete()` (the one-shot LLM side-channel)
- Start-time memory recall with an injection-defense sentence
- Tool registration (`save_memory` tool)
- Cross-call durability via a hypothetical `MemoryStore` backend

6 tests verify initialization, fact extraction, and recall injection.

### RAG plugin (`rag-plugin.ts`, TASK_0038)

A single capability-object plugin implementing two RETRIEVAL shapes from §
11.8 (not two plugin-authoring forms — both shapes live in the one plugin):
- **Shape 1 (agentic)**: a `search_knowledge` tool the model calls on demand,
  aggregating results from every registered `Retriever` contribution.
- **Shape 2 (automatic)**: `context`-time injection on every user turn —
  retrieves via all retrievers, sorts the combined pool by score descending,
  truncates to `topK`, and injects a `<retrieved-context>` block (with a §
  13 injection-defense sentence) without the model asking.

Both shapes source retrievers from:
- Multi-plugin capability accessor (`bh.getContributions<Retriever>('retriever')`)
- Configurable schema (`configSchema` with `embeddingModel` and `topK` fields)

7 tests verify tool execution, context injection, configuration, and
multi-plugin aggregation.

## Why these examples matter

The three plugins collectively exercise:
- All three plugin authoring forms (form 2 and factory functions shown here; form 3
  `@Plugin` decorator demonstrated in `src/core/decorators.ts`)
- All event types (framework `message`, `start`, `context`, `turn`; and
  `on()` / `emit()` bidirectionally)
- Multi-instance plugin state management (conversations, WeakMaps)
- The one-shot LLM side-channel (`bh.complete()`)
- The embedding side-channel (`bh.embed()` implied by retriever shape)
- Tool registration and execution
- The multi-plugin capability accessor (`getContributions<T>()`)
- Configuration validation and schema definition

If any of these examples cannot be authored without a kernel change, that's a
sign the kernel's § 6–11 extension surface is incomplete.

## How to use these as patterns

Each file is production-quality, not pseudo-code. Copy the general flow:

1. Plugin initialization sets up state (`start` event or `initialize` hook).
2. Tools are registered (via `bh.addTool()` or `initialize` hook).
3. Events are subscribed to (`context` for injection, `turn(end)` for veto, etc.).
4. Backing stores are accessed (memory, tasks, knowledge base).
5. Full lifecycle cleanup is delegated to `dispose` hooks.

## Test coverage

Each example plugin has a companion `.test.ts` file in the same directory.
These are NOT mocked or stubbed — they use real `BHZAI` instances with mock
drivers and real kernel events. The test suite is part of the normal
`pnpm test` gate.

- `task-plugin.test.ts`: 6 tests
- `memory-plugin.test.ts`: 6 tests
- `rag-plugin.test.ts`: 7 tests

Total: 19 reference-plugin tests verifying the extension surface.
