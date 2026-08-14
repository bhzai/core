# `src/tools/` — tool registry

## Purpose & scope

The in-process tool registry — the single source of truth for every callable tool BHZAI knows about (ARCHITECTURE.md § 9.2). Modeled as "one in-process MCP server": every registration path (imperative `addTool`, `@Tool` decorator, capability-object `tools:`, remote MCP attachment) converges on the store here, so `bh.listTools()` is semantically `tools/list` and invocation is semantically `tools/call`, regardless of where a tool came from.

## Key files

- `registry.ts` — `ToolRegistry` class + standalone `normalizeToolResult()` helper (TASK_0008). Stores `BHZAIToolDefinition` records keyed by `name` in a `Map`, validates names against § 9.1's regex, implements shadowing (replace, no `tool.removed` fired), and fires `tool.registered`/`tool.removed` (§ 8.1) via the framework `EventBus`'s kernel bypass. Also satisfies the `ToolRegistrar` seam so `@Tool`-decorated methods register through it.
- `registry.test.ts` — 26 tests covering object/sugar forms, shadowing, name validation, `normalizeToolResult`'s three branches, snapshot freshness, minimal filter subset, the `ToolRegistrar` seam, and accessors.
- `availability.ts` — Tool availability filtering seam (TASK_0017): `resolveAvailableTools()` and `applyToolFilter()` implement the § 9.5 3-step decision function for determining which tools a given LLM call offers, plus `isToolTrusted()` for the MCP server trust flag.
- `availability.test.ts` — 31 tests covering filter combinations (allow/deny, tags), trust flag derivation (local vs. MCP tools, trusted vs. untrusted servers), and security verification: a test proving untrusted MCP tools' annotations never drive availability decisions (TASK_0041, § 13).
- `no-eval.test.ts` — Security regression test (TASK_0041): static checks confirming `eval()`, `new Function()`, and dynamic callbacks never appear in non-test source code, enforcing § 13's "kernel never evals model output" commitment.
- `agent-loop-helpers.ts` — Extracted, unit-testable helper functions from `sendMessage` and `executeToolBatch` (in `../conversation/agent-loop.ts`). `sendMessage` is a 20-line thin entry point; `executeToolBatch` is a 31-line thin orchestrator. Both delegate to these helpers:
  - **Entry/exit**: `handleBusyEntry` (busy-check/queue routing), `prepareUserMessage` (ensureStarted, `loop(start)`, `message(before)`, blocked, patches, `message(waiting)`, set streaming), `handleLoopExit` (abort, `loop(end)`, idle/followUp transition)
  - **Per-turn**: `resolveDriverForTurn` (model ref + driver + capabilities), `drainSteerQueue` (steer delivery with `message(before)`), `fireTurnStart` (fire `turn(start)`), `buildContextForTurn` (context event + patches + tool resolution), `applyContextBudget` (pre-flight context-window check + compaction + prompt compaction), `executeDriverTurn` (build `ChatRequest` + call driver + consume stream + record tool calls + push + `message(sent)`)
  - **Termination**: `checkTurnTermination` (fire `turn(end)`, veto, natural stop / all-terminate), `handleTurnVeto` (inject synthetic continuation), `checkMaxIterations` (iteration bound + `truncatedBy` flag), `isAllTerminate` (pure logic: all results carry `BHZAI/terminate`)
  - **Post-turn**: `maybeAutoCompact` (context-window check → background compaction), `resolvePendingSteers` (settle steer promises with assistant message)
  - **Stream**: `consumeDriverStream` (driver event stream consumption with think-splitting and timeout), `recordToolCallsOnMessage` (tool-call buffer → `meta.toolCalls`)
  - **Tool batch**: `filterToolCalls` (extract tool-call events from buffer), `partitionToolCalls` (serial vs concurrent split), `validateToolCall` (existence + advertised + schema validation with repair messages via mutable `RepairCounter`), `executeToolWithAbortRace` (execute + abort race + normalize), `applyCompleteEventPatch` (rewrite patches from `tool(complete|error)`), `executeSingleToolCall` (full single-call pipeline: validate → beforeCall → call → execute → complete), `runToolBatchExecution` (concurrency orchestration: parallel concurrent, sequential serial), `appendToolResultMessages` (push tool-result messages to history in original order)
- `agent-loop-helpers.test.ts` — 92 unit tests for the extracted helpers (each tested in isolation without full integration setup).

## Conventions

- **No `execute()` invocation here**: the registry only stores tools. Calling `execute()`, validating arguments against `inputSchema`, `outputSchema` validation, the `tool(beforeCall)`/`tool(processing)` event sequence, and serial/concurrent batching all belong to TASK_0026 (the agent loop's tool-invocation pipeline). This boundary is documented in `registry.ts`'s "Explicit non-scope" comment.
- **Filtering is minimal**: `listTools(filter?)` implements only identity + name allow/deny + tag include/exclude for § 6 signature compatibility. The full § 9.5 3-step resolution order (driver-capability gating, conversation overrides) is TASK_0017's `resolveAvailableTools`.
- **Shadowing ≠ removal**: re-registering a tool with an existing name replaces the definition and fires only `tool.registered` (not `tool.removed`). `tool.removed` is reserved for explicit `removeTool()` calls. Documented as an explicit assumption in `registerInternal`.
- **Origin-agnostic storage**: the registry has no knowledge of "where a tool came from" (local plugin vs. MCP). That distinction lives in the `mcp__<server>__<tool>` name prefix (TASK_0011) and is invisible here.

## Consumers

- `src/core/bhzai.ts` instantiates a `ToolRegistry` and delegates `addTool`/`removeTool`/`listTools` to it. The `toolRegistrar` seam (used by `decorators.ts`) also funnels through `ToolRegistry.register`.
- `src/plugins/mcp/client.ts` (TASK_0011 + TASK_0012) registers discovered remote tools into this registry under the `mcp__<server>__<tool>` namespace, and re-syncs (add/remove) on `handleListChanged`/`pollToolsList`.
- Future: TASK_0017 (`resolveAvailableTools`) reads from it; TASK_0026 (agent loop) invokes `execute()` on records from here.
