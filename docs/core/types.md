# Shared Types (`src/types/`)

Documentation for BHZAI's cross-cutting TypeScript type declarations.
Architecture references: ARCHITECTURE.md §§ 9.1, 10.1, 10.5, 11.1, 8.4.

## Overview

`src/types/` holds the shared vocabulary between the kernel, drivers,
tools, and conversation layer. **Types only — no runtime logic** lives
anywhere under this directory. Every file is a collection of
`export interface` / `export type` declarations plus TSDoc.

The barrel `src/types/index.ts` re-exports every type declared in sibling
files. Downstream tasks import shared types from here (or from the root
package barrel, which re-exports this file).

## Files

### `content.ts` (TASK_0002)

- `JSONSchema` — loose type alias for a JSON Schema (2020-12 dialect):
  `Record<string, unknown>`. A fully-typed JSON Schema AST is out of
  scope for BHZAI's MVP; downstream code that needs to inspect specific
  keywords (e.g. TASK_0006's `default` keyword lookup) narrows locally.
- `ContentBlock` — discriminated union on `type`:
  - `{ type: 'text'; text: string }`
  - `{ type: 'image'; data: string; mimeType: string }`
  - `{ type: 'audio'; data: string; mimeType: string }`
  - `{ type: 'resource_link'; uri: string; name?: string; mimeType?: string }`
  - `{ type: 'resource'; resource: { uri: string; mimeType?: string; text?: string; blob?: string } }`
- `CallToolResult` — MCP wire shape for a tool result:
  `{ content: ContentBlock[]; isError?: boolean }`.

### `message.ts` (TASK_0002)

- `BHZAIMessageExtensions` — the open extension point of the message
  contract. Plugins declare a field at runtime with
  `bh.defineMessageField(name)` (a non-enumerable accessor over
  `message.meta`) and declare its type here by module augmentation:

  ```ts
  declare module "@bhzai/core" {
    interface BHZAIMessageExtensions {
      sentiment?: "positive" | "negative"
    }
  }
  ```

  Augmenting the package specifier merges even though `dist/index.d.ts`
  re-exports the interface from a bundled chunk — TypeScript follows the
  re-export alias to the original declaration. Every member must be
  optional, since a message only carries a field once the owning plugin
  has registered it. Core ships one member, `think?: string`, backing
  `CreateConversationOptions.parseThink`.
- `BHZAIMessage` — `{ id, role, content, blocks, time, meta, append(text),
  setContent(content) }` (§ 11.1). The full conversation interface is
  TASK_0023's; this task supplies only the message shape and the
  standalone `ConversationStatus` union. Extends
  `BHZAIMessageExtensions`.
- `ConversationStatus` — `'idle' | 'streaming' | 'waiting-tool' |
  'compacting' | 'aborted' | 'error'`.

### `model.ts` (TASK_0002)

- `ModelInfo` — `{ ref, driver, id, label?, capabilities, availability,
  meta? }` where `availability` is `'ready' | 'downloadable' |
  'unavailable'` (§ 10.5).
- `DriverCapabilities` — `{ streaming, toolCalls, reasoning, embeddings?,
  contextWindow? }` (§ 10.1).
- `Usage` — token usage accounting returned by `complete()` and `embed()`.

### `driver.ts` (TASK_0002 + TASK_0009)

- `GenerationParams` — `{ temperature, maxTokens, stop, reasoning? }`
  where `reasoning` is `'off' | 'minimal' | 'low' | 'medium' | 'high' |
  'max'`.
- `DriverEvent` — discriminated union: `delta`, `reasoning-delta`,
  `tool-call-delta`, `tool-call`, `usage`, `done` (exact field names per
  § 10.1).
- `ChatRequest` — `{ model, messages, systemPrompt?, tools?, params?,
  signal }`.
- `ToolWireDefinition` — the raw MCP `Tool` wire shape (used when
  bridging remote MCP tools into the local registry).
- `BHZAIDriver` — added by TASK_0009 on TASK_0002's behalf (see the
  file-header coordination note). See `drivers.md`.

### `events.ts` (TASK_0002)

- `EmitResult` — `{ blocked: boolean; reason?: string; patch:
  Partial<Payload>; handled: number }` (§ 8.4).
- `Unsubscribe` — `() => void`, returned by `EventBus.on()`.

### `tool.ts` (TASK_0008, added on TASK_0002's behalf)

- `BHZAIToolDefinition` — a BHZAI tool definition IS an MCP `Tool` object
  plus a local `execute` binding (§ 9.1). Required: `name`,
  `description`, `inputSchema`, `execute`. Optional: `annotations`,
  `outputSchema`, `_meta`.
- `ToolInvocation` — the context passed to `execute`:
  `{ args, conversation?, signal? }`.
- `ToolExecute` — `(invocation: ToolInvocation) => CallToolResult |
  string | Promise<CallToolResult | string>`. String returns are wrapped
  as `{ content: [{ type: 'text', text }] }`.
- `ToolFilter` — predicate for `listTools(filter?)`.
- `Icon`, `ToolAnnotations` — MCP-spec passthrough fields.
- `BHZAIConversation` — opaque placeholder; refined by TASK_0023.

### `command.ts` (TASK_0010, added on TASK_0002's behalf)

- `BHZAICommandDefinition` — `{ description, handler(args, ctx),
  complete?(prefix) }`. See `command-registry.md`.
- `BHZAICommandContext` — `{ conversation?, signal? }`.

### `mcp.ts` (TASK_0011, added on TASK_0002's behalf)

- `McpServerConfig` — `{ url, headers?, name?, deferred? }`. See
  `plugins/mcp-client.md`.

## Conventions

- **No runtime logic**: if a file under `src/types/` needs to export a
  value, it belongs elsewhere.
- **Field names match the spec verbatim** for MCP wire-compatibility
  (§ 9.1: a BHZAI tool definition _is_ an MCP `Tool`).
- **`unknown` over `any`**: driver/tool-specific fields whose concrete
  shape isn't knowable at this layer use `unknown`.
- **Cross-task coordination**: if a later task needs a type TASK_0002
  didn't land, it adds the type here with a file-header note flagging
  the gap, rather than duplicating it locally.

## Test coverage

10 tests in `src/types/types.test.ts` — pure compile-time type-assertion
tests (`expectTypeOf` + `@ts-expect-error`) so `tsc --noEmit` fails if
shapes drift from the spec. No runtime assertions.
