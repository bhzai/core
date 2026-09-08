# `@bhzai/core`

[View online demo](https://bhzai.github.io/core/)

> Browser-Hosted Agentic AI Framework — a standalone, environment-agnostic TypeScript framework that extracts agent-harness internals (provider gateway, tool-calling loop, conversation persistence, streaming, memory, MCP client) into a plugin-first micro-kernel designed for extension and reuse.

bhzai v0.2 is built around an **"everything is a plugin"** architecture inspired by modern agent harnesses. A minimal privileged kernel provides plugin lifecycle, dependency topology, exclusive service claiming, and reversible effects, while runtime capabilities (LLM access, tools, commands, session logs, the agent loop, context accounting, and compaction) are ordinary first-class plugins.

## Status

v0.2 core rewrite complete. Greenfield plugin architecture with append-only session event logs and pure message projections.

## Security

⚠️ **Security**: Plugins run with full host privileges. Hosts must gate what they load — the framework provides no sandbox.

## Installation

```bash
pnpm add @bhzai/core
```

For modular imports:

```typescript
import { createHarness, sessionPlugin, llmPlugin, Ollama } from "@bhzai/core"
import { idbPlugin } from "@bhzai/core/plugins/idb"
import { mcpPlugin } from "@bhzai/core/plugins/mcp"
```

Note: The `@bhzai/core/plugins/webllm` driver requires `@mlc-ai/web-llm` as an optional peer dependency for in-browser WebGPU inference.

## Package Layout

| Subpath | Description |
|---|---|
| `@bhzai/core` | Harness kernel, core plugins (sessions, LLM, tools, commands, loop, context, compaction), drivers, types |
| `@bhzai/core/plugins/idb` | IndexedDB session persistence plugin |
| `@bhzai/core/plugins/mcp` | Model Context Protocol streamable-HTTP client & management service |
| `@bhzai/core/plugins/webllm` | WebLLM driver plugin (peer dep: `@mlc-ai/web-llm`) |
| `@bhzai/core/plugins/ollama` | Ollama driver plugin (fetch, web-standard APIs only) |
| `@bhzai/core/plugins/lmstudio` | LM Studio driver plugin (fetch, web-standard APIs only) |
| `@bhzai/core/plugins/openai` | OpenAI driver plugin (fetch, web-standard APIs only) |
| `@bhzai/core/plugins/vllm` | vLLM driver plugin (fetch, web-standard APIs only) |
| `@bhzai/core/plugins/examples` | Reference plugins (task management, memory recall, RAG) |

## Quickstart

```typescript
import {
	createHarness,
	sessionPlugin,
	llmPlugin,
	toolsPlugin,
	commandsPlugin,
	agentLoopPlugin,
	Ollama,
} from "@bhzai/core"

// 1. Create a harness with standard plugins
const harness = await createHarness({
	plugins: [
		sessionPlugin,
		llmPlugin,
		toolsPlugin,
		commandsPlugin,
		agentLoopPlugin,
	],
})

// 2. Register a driver
harness.addDriver(new Ollama({ baseUrl: "http://localhost:11434" }))

// 3. Register a custom tool
harness.ctx.tools.register({
	name: "get_current_time",
	description: "Get the current time in ISO 8601 format",
	inputSchema: {
		type: "object",
		properties: {},
		required: [],
	},
	execute: async () => ({
		content: [{ type: "text", text: `Current time: ${new Date().toISOString()}` }],
		isError: false,
	}),
})

// 4. Create a session with a target model
const session = await harness.createSession({
	model: "ollama/llama3.3",
})

// 5. Send a message and await turn completion
const response = await session.send("Say hello and introduce yourself in one sentence.")
console.log("Assistant response:", response.text)

// 6. Clean up
await harness.dispose()
```

See `examples/readme-quickstart.ts` for the complete working example, and `examples/readme-quickstart.test.ts` for how to test it with a mocked HTTP layer.

## Attaching MCP servers

Attach Model Context Protocol servers via the `mcpPlugin`:

```typescript
import { createHarness, mcpPlugin, toolsPlugin } from "@bhzai/core"

const harness = await createHarness({
	plugins: [toolsPlugin, mcpPlugin],
})

// Add an MCP server — tools are registered under mcp__<server>__<tool>
await harness.ctx.mcp.add({
	url: "https://example.com/mcp",
	name: "github",
})
```

The MCP service tracks server connection states, discovered tools, and allows subscribing to state transitions for UI rendering.

## Core Concepts

- **Harness Kernel** — Manages plugin lifecycle, topological dependency ordering, exclusive service claims on `ctx`, and clean reverse-order disposal.
- **Plugins** — Standalone capabilities conforming to `PluginDefinition`. Core features (LLM access, session logs, tool execution, commands, agent loop, context accounting, and compaction) are all modular plugins.
- **Append-only Session Log** — State is maintained as an immutable stream of typed events. Conversation messages are derived as a pure projection (`deriveMessages(log)`).
- **Agent Loop** — A single, deterministic loop: when the model produces a response without tool calls, the turn concludes.
- **Usage-based Context Accounting** — Ground truth token counts from driver responses anchor context tracking, minimizing character estimation drift.

## Environment Boundary

The core framework uses only web-standard APIs: `fetch`, `AbortController`, `ReadableStream`, `crypto.randomUUID`, `structuredClone`, `queueMicrotask`. No Node built-ins, no DOM. Environment-specific features (WebGPU, IndexedDB) live in modular plugin subpaths.

## Development

```bash
pnpm install          # install dependencies
pnpm test             # run all tests (vitest)
pnpm test <path>      # run a single test file
pnpm typecheck        # tsc --noEmit && tsc --noEmit -p example
pnpm lint             # biome check . && node scripts/check-quality-gates.mjs
pnpm build            # tsup build
```

## Running the example

The `example/` directory contains a browser chat app demonstrating streaming, telemetry, reasoning blocks, MCP server management, and conversation persistence.

```bash
pnpm install
pnpm run preview      # Builds @bhzai/core, then starts the example server
```

Open `http://localhost:5173` in your browser.

## Documentation

- **[`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md)** — Complete v0.2 architecture specification.
- **[`docs/getting-started.md`](./docs/getting-started.md)** — Scaffolding, tooling choices, and package structure.
- **[`docs/examples.md`](./docs/examples.md)** — Reference plugin examples guide.
- **`docs/plugins/`** — Driver and plugin references: [`webllm-driver.md`](./docs/plugins/webllm-driver.md), [`ollama-driver.md`](./docs/plugins/ollama-driver.md), [`lmstudio-driver.md`](./docs/plugins/lmstudio-driver.md), [`openai-driver.md`](./docs/plugins/openai-driver.md), [`vllm-driver.md`](./docs/plugins/vllm-driver.md), [`mcp-client.md`](./docs/plugins/mcp-client.md), [`idb-conversations.md`](./docs/plugins/idb-conversations.md).

## License

MIT
