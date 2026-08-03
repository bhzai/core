# `@bhzai/core`

[View online demo](https://bhzai.github.io/core/)

> Browser-Hosted Agentic AI Framework — a standalone, environment-agnostic TypeScript framework that extracts agent-harness internals (provider gateway, tool-calling loop, conversation persistence, streaming, memory, MCP client) into a plugin-first micro-kernel designed for extension and reuse.

bhzai is a micro-kernel plus a plugin interface for model drivers, tools, commands, message middleware, and storage. Its extension surface is deliberately aligned with pi, OpenCode, VS Code LM tools, MCP, and the Vercel AI SDK so existing extensions can be adapted rather than rewritten.

## Status

Phase 6 (interop, security, PEP mapping, final docs) complete. All kernel subsystems (TASK_0001–0044) implemented and tested.

## Security

⚠️ **Security**: Plugins run with full host privileges. Hosts must gate what they `use()` — the framework provides no sandbox.

## Installation

```bash
pnpm add @bhzai/core
```

For development versions or to use specific subpath exports:

```typescript
import { bhzai } from "@bhzai/core"  // batteries-included
import bhzai from "@bhzai/core/core"  // kernel only
import { Ollama } from "@bhzai/core/plugins/ollama"  // individual plugins
```

Note: The `@bhzai/core/plugins/webllm` driver requires `@mlc-ai/web-llm` as a peer dependency (handle model download/caching yourself).

## Package Layout

| Subpath                              | Description                                                                                     |
| ------------------------------------ | ----------------------------------------------------------------------------------------------- |
| `@bhzai/core`                  | Kernel: bhzai, Conversation, types, decorators, event bus                                        |
| `@bhzai/core/core`             | Kernel only (bhzai, bhzaiConversation, types, decorators, event bus)                              |
| `@bhzai/core/plugins/webllm`   | WebLLM driver plugin (peer dep: @mlc-ai/web-llm)                                                |
| `@bhzai/core/plugins/ollama`   | Ollama driver plugin (fetch, no deps beyond web-standard APIs)                                  |
| `@bhzai/core/plugins/lmstudio` | LM Studio driver plugin (fetch, no deps beyond web-standard APIs)                               |
| `@bhzai/core/plugins/openai`   | OpenAI driver plugin (fetch, no deps beyond web-standard APIs)                                  |
| `@bhzai/core/plugins/mcp`      | MCP streamable-HTTP client plugin + server lifecycle manager                                     |
| `@bhzai/core/plugins/interop/pi` | Adapter to run (a subset of) pi coding-agent extensions                                        |
| `@bhzai/core/plugins/interop/opencode` | Adapter to run (a subset of) OpenCode plugins                                           |

## Quickstart

```typescript
import { bhzai } from "@bhzai/core"
import { Ollama } from "@bhzai/core/plugins/ollama"

// 1. Create a bhzai instance
const bh = new bhzai()

// 2. Register the Ollama driver (which talks to a local/remote Ollama server)
bh.addDriver(new Ollama({ baseUrl: "http://localhost:11434" }))

// 3. Register a simple custom tool via the capability-object plugin form (§ 7.2)
bh.use({
	name: "quickstart-plugin",
	initialize({ bh }) {
		bh.addTool({
			name: "get_current_time",
			description: "Get the current time in ISO 8601 format",
			inputSchema: {
				type: "object",
				properties: {},
				required: [],
			},
			execute: async () => {
				const now = new Date().toISOString()
				return {
					content: [{ type: "text", text: `Current time: ${now}` }],
					isError: false,
				}
			},
		})
	},
})

// 4. Initialize the kernel (runs plugin initialize hooks, resolves models, etc.)
await bh.init()

// 5. Create a conversation with a specific model (qualified 'driver/model' reference)
const conversation = await bh.createConversation({
	model: "ollama/llama3.3",
})

// 6. Send a message and observe the agent response
const response = await conversation.sendMessage(
	"Say hello and introduce yourself in one sentence.",
)

console.log("Assistant response:", response.content)

// 7. Clean up
await bh.dispose()
```

See `examples/readme-quickstart.ts` for the complete working example, and `examples/readme-quickstart.test.ts` for how to test it with a mocked HTTP layer.

## Attaching MCP servers

The kernel never imports optional plugin code, so `bh.addMcp()` builds its client through a factory that `mcpPlugin` registers. Register the plugin before `init()` and every HTTP MCP server's tools land in the same registry as your local ones:

```typescript
import { bhzai } from "@bhzai/core"
import { mcpPlugin } from "@bhzai/core/plugins/mcp"

const bh = new bhzai()
bh.use(mcpPlugin) // before init() — without it, addMcp() refuses to attach
await bh.init()

await bh.addMcp({ url: "https://example.com/mcp", name: "github" })
// The server's tools are now callable as mcp__github__<tool>.
```

For a UI, `createMcpPlugin()` also hands back an `McpManager` that tracks each server's status, discovered tools, and structured failures, with `subscribe()` for re-rendering:

```typescript
const { plugin, manager } = createMcpPlugin()
bh.use(plugin)
await bh.init()

manager.subscribe((servers) => render(servers))
const state = await manager.add({ url: "https://example.com/mcp" })
// state.status is "connected" or "error" — add() reports failure as state, never rejects.
```

See `docs/plugins/mcp-client.md` for the full API, and `example/` for a working panel built on it.

## v0.1 Scope

### Delivered in v0.1

1. **Browser/Node agnostic core** — The kernel uses only Web-standard APIs (`fetch`, `AbortController`, `ReadableStream`, `crypto.randomUUID`, `queueMicrotask`). No Node built-ins, no DOM. Runs unchanged in browsers, Node ≥ 20, Deno, Bun, Electron (main and renderer), and web workers.

2. **Plugin-first architecture** — The kernel ships almost nothing baked in; even the bundled WebLLM/Ollama drivers and the MCP client are plugins that happen to be published from the same package.

3. **Four bundled drivers** — WebLLM (in-browser inference over WebGPU, engine injected by the host), Ollama, LM Studio, and OpenAI (all HTTP APIs, working in any fetch-capable runtime). The OpenAI driver also serves any OpenAI-compatible gateway by changing its `baseUrl`.

4. **Built-in, spec-conformant MCP client** — Streamable HTTP transport (spec revision 2025-11-25) with handshake, paginated `tools/list`, `tools/call`, list-changed re-sync, progress/cancellation, and optional deferred loading via `search_tools` convention.

5. **Conversation management** — Create/load conversations, a message pipeline with observable states, a bounded tool-calling agent loop, and a versioned serialization contract.

6. **Storage-agnostic persistence** — Conversation, memory, and skill storage are interfaces only — the host wires its own persistence (PEP: `llm_conversations`; a chat page: IndexedDB; a CLI: JSONL session files).

### Explicitly Out of Scope for v0.1

1. **No storage/persistence drivers** — Interfaces exist for the host to implement (ARCHITECTURE.md § 11.4). The kernel never persists anything itself.

2. **No UI of any kind** — Rendering, widgets, and approval cards are host concerns. The kernel emits enough events for any UI to be built on top.

3. **No permission/authorization model** — Hosts enforce permissions inside their tool implementations and via the tool-availability hook (§ 9.5), mirroring the threat model where the tool script is the security boundary.

4. **No non-HTTP MCP transports** — Stdio/WebSocket MCP can be added as host plugins; stdio requires Node and therefore cannot live in the agnostic core.

5. **No prompt/skill file formats** — A `SkillResolver` interface exists; formats are host-defined.

6. **No session tree/branch UI** — Plain-JSON snapshots make host-side forking trivial (§ 11.5); the kernel does not manage branch topology.

## Core Concepts

- **Kernel (`BHZAI` class)** — Owns plugin registration (`use`), the event bus (`on`/`emit`), conversation lifecycle (`createConversation`/`loadConversation`), tool/driver/command registries, side-channels (`complete()` for one-shot LLM calls, `embed()` for embeddings), and full lifecycle teardown (`dispose()`).

- **Plugin system** — Every plugin normalizes to `{ name, setup(bh) }`. Three authoring styles: bare factory function, capability object, or `@Plugin`/`@On`/`@Tool` decorated class (TC39 stage-3 decorators).

- **Event model** — Dot-namespaced, two buses (framework `bh.on`, per-conversation `conversation.on`), patch chaining, blockable pipelines.

- **Conversations & the agent loop** — `conversation.sendMessage()` drives a bounded tool-calling loop: system-prompt layering, the `context` event, concurrent-by-default tool execution with validate-and-repair, steering, opt-in context-window compaction, and a versioned snapshot contract.

- **Tools** — A bhzai tool definition _is_ an MCP `Tool` object plus a local `execute` binding; results _are_ MCP `CallToolResult`s. Local and remote MCP tools share one registry.

- **Drivers** — `bhzaiDriver` interface (`listModels`, `capabilities`, `chat`, optional `embed`). Four bundled: WebLLM (browser/WebGPU), Ollama (plain `fetch`), LM Studio (plain `fetch`), and OpenAI (plain `fetch`, hosted platform).

- **MCP client** — Streamable-HTTP transport only (spec rev 2025-11-25). Handles handshake, paginated discovery, live re-sync, progress/cancellation.

## Environment Boundary

Web-standard APIs only in the core: `fetch`, `AbortController`, `ReadableStream`, `crypto.randomUUID`, `structuredClone`, `queueMicrotask`. No Node built-ins, no DOM. Anything environment-specific (WebGPU, stdio) lives in a driver/plugin subpath.

## Development

```bash
pnpm install          # install dependencies
pnpm test             # run all tests (vitest)
pnpm test <path>      # run a single test file
pnpm typecheck        # tsc --noEmit
pnpm lint             # biome check .
pnpm build            # tsup build
```

## Running the example

The `example/` directory contains a browser chat app that runs WebLLM models locally in your browser with live telemetry.

**Requires**: A WebGPU-capable browser (Chrome/Edge 113+).

```bash
pnpm install
pnpm run preview      # Builds @bhzai/core, then starts the example server
```

Open `http://localhost:5173` and pick a model. See [`docs/examples/webllm-chat.md`](./docs/examples/webllm-chat.md) for full details.

## Documentation

- **`../ARCHITECTURE.md`** (parent directory) — Full v0.1 design proposal with detailed rationale for every subsystem (§ 1–14).

- **`docs/plugins/`** — Per-plugin references: [`webllm-driver.md`](./docs/plugins/webllm-driver.md), [`ollama-driver.md`](./docs/plugins/ollama-driver.md), [`lmstudio-driver.md`](./docs/plugins/lmstudio-driver.md), [`openai-driver.md`](./docs/plugins/openai-driver.md), and [`mcp-client.md`](./docs/plugins/mcp-client.md).

- **`docs/security-review.md`** — TASK_0041 security audit: verifies five security commitments from ARCHITECTURE.md § 13.

- **`docs/pep-mapping-validation.md`** — TASK_0042 mapping: demonstrates how every sub-concern from PEP's issue #1338 maps onto bhzai's extension points.

- **`docs/open-questions.md`** — TASK_0044 open questions: enumerates design questions deferred from v0.1 to future releases (interop completeness, deployment, cluster semantics, etc.).

- **`docs/PROGRESS.md`** — Task completion status and history for all 44 implementation tasks.

## License

MIT
