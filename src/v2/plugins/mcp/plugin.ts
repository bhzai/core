import type { PluginContext, PluginDefinition } from "../../kernel/types"
import { McpServiceImpl } from "./service"
import type { McpPluginOptions } from "./types"

/**
 * v0.2 Plugin connecting MCP servers and projecting their tools into ctx.tools.
 */
export const mcpPlugin: PluginDefinition<McpPluginOptions> = {
	name: "mcp",
	dependencies: ["tools"],
	async setup(ctx: PluginContext, config: McpPluginOptions = {}) {
		const service = new McpServiceImpl(ctx, config)
		ctx.claim("mcp", service)

		if (config.servers && config.servers.length > 0) {
			for (const server of config.servers) {
				await service.attach(server)
			}
		}

		return async () => {
			for (const server of service.list()) {
				await service.detach(server.id)
			}
		}
	},
}
