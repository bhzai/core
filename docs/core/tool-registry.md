# Tool Registry (`src/tools/registry.ts`)

Documentation for the BHZAI tool registry. Architecture reference:
ARCHITECTURE.md § 9.

## Overview

The `ToolRegistry` is the single in-process source of truth for every
callable tool BHZAI knows about, whether registered by a plugin, a
decorator, a capability object, or (later) an attached MCP server. § 9.2
frames it as "one in-process MCP server": every registration path
converges on this one store so that `bh.listTools()` is semantically
`tools/list` and invocation is semantically `tools/call`, regardless of
where a tool came from.

The registry itself has no knowledge of "where a tool came from" (local
plugin vs. MCP). That distinction lives entirely in the `name` prefix
convention (`mcp__<server>__<tool>` for remote tools, established in
TASK_0011) and is invisible to this registry's storage logic.

## Public API

```typescript
import { BHZAI, type BHZAIToolDefinition, type ToolFilter } from "@bhzai/core";

const bh = new BHZAI();

// Object form
bh.addTool({
  name: "greet",
  description: "Greet someone",
  inputSchema: { type: "object", properties: { name: { type: "string" } } },
  execute: async (invocation) => ({ content: [{ type: "text", text: "hi" }] }),
});

// Sugar form (description defaults to '')
bh.addTool("greet", { type: "object", properties: {} }, async (inv) => "hi");

bh.removeTool("greet");
const tools = bh.listTools();        // BHZAIToolDefinition[]
const filtered = bh.listTools((t) => t.name.startsWith("mcp__"));
```

### `addTool` — two overloads

1. **Object form**: `addTool(def: BHZAIToolDefinition): void`. Validates
   `def.name`, inserts/replaces the entry, fires `tool.registered` with
   `{ tool: def }`.
2. **Sugar form**: `addTool(name, parameters, execute): void`. Per
   § 9.1, `parameters` is an alias for `inputSchema`. Constructs a full
   `BHZAIToolDefinition` internally:
   `{ name, description: '', inputSchema: parameters, execute }`.
   **The sugar form does not accept a `description`** — it defaults to
   the empty string `''`. This is a documented judgment call resolving
   the tension between the spec's sugar form (three positional args, no
   slot for description) and the full shape's required `description`
   field.

Both overloads normalize into one internal object shape before storing,
so `tool.registered` fires exactly once per call regardless of which
overload was used.

### Name validation

Before storing, `def.name` is validated against:

- length 1–128 characters;
- matching `/^[a-zA-Z0-9_.-]+$/` (letters, digits, underscore, dot,
  hyphen — no spaces, no other punctuation).

This is copied verbatim from § 9.1. On failure, a `TypeError` is thrown
synchronously, before any registration side effects (no partial insert,
no event fired).

### `removeTool(name: string): void`

Removes the entry and fires `tool.removed` with `{ tool }` (not
blockable, per § 8.1).

### `listTools(filter?: ToolFilter): BHZAIToolDefinition[]`

Returns all registered tool definitions, optionally filtered by a
`ToolFilter` predicate. TASK_0017 will consume the stored definitions
(including `tags`) for tool-availability filtering per LLM call.

### `normalizeToolResult(result): CallToolResult`

Standalone exported helper. Per § 9.1's string-wrapping rule, a string
return from `execute` is wrapped as `{ content: [{ type: 'text', text }]
}`. `CallToolResult` objects pass through verbatim.

## Shadowing behavior — explicit assumption

Per § 9.1, "later registration shadows earlier": registering a tool
with a `name` that already exists in the map REPLACES the stored
definition. **Shadowing is NOT treated as a removal.** Only
`tool.registered` fires, carrying the new definition; `tool.removed` is
reserved exclusively for explicit `removeTool()` calls. Rationale: the
model/host still sees "a tool named X" continuously across the
shadowing — nothing was removed from its perspective, only updated —
whereas `tool.removed` implies the name is no longer callable at all.

## Events

- `tool.registered` — fires on every `addTool` call (including
  shadowing replacements). Payload `{ tool }`. Not blockable.
- `tool.removed` — fires only on explicit `removeTool()` calls. Payload
  `{ tool }`. Not blockable.

Both are fired via the framework bus's internal `dispatch()` bypass
(they are kernel-reserved event names).

## Test coverage

26 tests in `src/tools/registry.test.ts`:

- Object-form registration and `listTools()`.
- Sugar-form registration (description defaults to `''`).
- Name validation: length bounds, regex, rejection of invalid names.
- Shadowing: re-registration replaces, fires `tool.registered` only,
  does NOT fire `tool.removed`.
- `removeTool()` fires `tool.removed`.
- `listTools(filter?)` with predicate filters.
- `normalizeToolResult()` string wrapping and `CallToolResult`
  passthrough.
- `tool.registered` / `tool.removed` event payloads.
