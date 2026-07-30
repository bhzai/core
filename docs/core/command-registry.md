# Command Registry (`src/core/commands.ts`)

Documentation for the BHZAI command registry. Architecture reference:
ARCHITECTURE.md § 6.

## Overview

The `CommandRegistry` stores `BHZAICommandDefinition` records keyed by `name`.
It is the in-process source of truth for every slash-command BHZAI knows
about, analogous to how `ToolRegistry` is the single source of truth for
tools.

## Public API

```typescript
import { BHZAI } from "@bhzai/core";

const bh = new BHZAI();

bh.addCommand({
  name: "help",
  description: "List available commands",
  handler: (args, ctx) => {
    // args: string[] — whitespace-tokenized arguments
    // ctx: BHZAICommandContext — { conversation?, signal? }
  },
  complete: (prefix) => ["help", "hello"], // optional completer
});

const commands = bh.listCommands(); // BHZAICommandDefinition[]
```

### `BHZAICommandDefinition`

- `name: string` — the command name (without leading `/`).
- `description: string` — human-readable description.
- `handler(args: string[], ctx: BHZAICommandContext): void | Promise<void>` —
  the command implementation. `args` is whitespace-tokenized.
- `complete?(prefix: string): string[]` — optional tab-completion function.

### `BHZAICommandContext`

- `conversation?: BHZAIConversation` — the active conversation, if any.
- `signal?: AbortSignal` — for cancellation.

## Conventions

- **"Last registration wins"**: re-registering a command with an existing
  name replaces the definition. No events are fired for command
  registration/replacement (consistent with the tool/driver registries'
  shadowing policy, but without the `tool.registered`/`driver.registered`
  events since commands have no spec-mandated event).
- **No `execute()` invocation here**: the registry only stores commands.
  Parsing user input into a command name + args, invoking `handler()`, and
  rendering output all belong to the host or a future command-loop task.

## Test coverage

9 tests in `src/core/commands.test.ts`:

- Registration and `listCommands()`.
- Handler invocation with args + context.
- Completer invocation.
- Duplicate name replacement (last wins).
- Removal via `removeCommand()`.
