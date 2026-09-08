# `src/types/` — shared type declarations

## Purpose & scope

Cross-cutting TypeScript type declarations shared across the kernel, plugins, and consumers (ARCHITECTURE.md §§ 9-11). **Types only — no runtime logic** lives anywhere under this directory. Every file is a collection of `export interface` / `export type` declarations plus TSDoc.

## Key files

- `index.ts` — types barrel. Re-exports every type declared in sibling files. Downstream tasks import shared types from here (or from the root package barrel, which re-exports this file).
- `content.ts` — `JSONSchema`, `ContentBlock`, `CallToolResult` (§ 9.1).
- `message.ts` — `BHZAIMessage`, `ConversationStatus` (§ 11.1).
- `model.ts` — `DriverCapabilities`, `ModelInfo`, `Usage` (§§ 10.1, 10.5).
- `driver.ts` — `GenerationParams`, `DriverEvent`, `ChatRequest`, `ToolWireDefinition`, `BHZAIDriver` (§ 10.1). `ChatRequest.model` is the **bare model id**, not the qualified `'<driver>/<model>'` ref — the kernel parses the ref before calling `chat()` and the driver decides how to format the model name on the wire. `BHZAIDriver` was added by TASK_0009 on TASK_0002's behalf — see the file-header coordination note. The `usage` `DriverEvent` variant has optional `inputTokens`/`outputTokens`/`totalTokens` fields (`undefined` = "not available from this provider") — drivers omit fields they don't report rather than coercing to zero.
- `events.ts` — `EmitResult`, `Unsubscribe` (§§ 6, 8.4).
- `tool.ts` — `BHZAIToolDefinition`, `ToolInvocation`, `ToolExecute`, `ToolFilter`, `Icon`, `ToolAnnotations`, opaque `BHZAIConversation` placeholder (§ 9.1). Added by TASK_0008 on TASK_0002's behalf — see the file-header coordination note.
- `command.ts` — `BHZAICommandDefinition`, `BHZAICommandContext` (§ 6). Added by TASK_0010 on TASK_0002's behalf — see the file-header coordination note.
- `mcp.ts` — `McpServerConfig` (§ 6 line 215, § 9.3). Added by TASK_0011 on TASK_0002's behalf — see the file-header coordination note.
- `storage.ts` — `ConversationStore`, `MemoryStore`, `SkillResolver` (§ 11.4) plus supporting shapes `ConversationSummary`, `MemoryRecord`, `SkillInfo`. Added by TASK_0029 — no concrete implementations ship in v1, only interfaces + kernel wiring.
- `types.test.ts` — pure compile-time type-assertion tests (`expectTypeOf` + `@ts-expect-error`) so `tsc --noEmit` fails if shapes drift from the spec.

## Conventions

- **No runtime logic**: if a file under `src/types/` needs to export a value, it belongs elsewhere. This is enforced by convention, not a lint rule.
- **Field names match the spec verbatim** for MCP wire-compatibility (§ 9.1: a BHZAI tool definition _is_ an MCP `Tool`). Do not rename or reorder optionality without a spec change.
- **Cross-task coordination**: if a later task (e.g. TASK_0008, TASK_0009) needs a type TASK_0002 didn't land, it adds the type here with a file-header note flagging the gap, rather than duplicating it locally.
- **`unknown` over `any`**: driver/tool-specific fields whose concrete shape isn't knowable at this layer use `unknown` (e.g. `DriverEvent`'s `tool-call.input`, `done.error`).

## Consumers

- `src/index.ts` re-exports `types/index.ts` first, so every type is available from the root package barrel.
- Kernel and plugin modules import types from `../types/index.js`.
- `src/types/types.test.ts` is a regression guard — `pnpm typecheck` runs it via `tsc --noEmit`.
