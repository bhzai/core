# `src/plugins/mcp/` — MCP streamable-HTTP client plugin

## Purpose & scope

The built-in MCP (Model Context Protocol) client — streamable-HTTP transport only, spec rev 2025-11-25. Handles handshake, paginated tool discovery, live re-sync, progress/cancellation, and deferred loading. Discovered remote tools are registered into `ctx.tools` with the `mcp__<server>__<tool>` name prefix.

## Key files

- `index.ts` — subpath entry. Re-exports `mcpPlugin`, `McpService`, `McpServiceImpl`, `McpClient`, and configuration types.
- `plugin.ts` — standard `PluginDefinition` claiming `ctx.mcp` with an `McpServiceImpl` instance.
- `service.ts` — `McpServiceImpl` implementing `McpService` with lifecycle management (`add`, `remove`, `retry`, `refresh`, `list`, `subscribe`).
- `client.ts` — `McpClient` class. Owns the JSON-RPC handshake, header contract, paginated discovery, and `tools/call` execution binding.
- `mcp.test.ts` — test suite covering service lifecycle, tool registration, and server communication.

## Conventions

- **Streamable HTTP only**: The MCP spec's streamable-HTTP rev is the sole transport.
- **Service claiming**: Claims `ctx.mcp` on the shared harness context.
- **Tool integration**: Registers discovered tools directly into `ctx.tools`.
- **Observable state**: `McpService` reports status (`connecting`/`connected`/`error`) and server lists with a `subscribe()` mechanism for UI consumers.

## Consumers

- `src/index.ts` re-exports this entry.
- `tsup.config.ts` builds it to `dist/plugins/mcp/index.js` + `.d.ts`.
- `example/` renders MCP server status in its MCP panel via `ctx.mcp`.
