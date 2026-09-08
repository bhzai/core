import type { PluginContext, PluginDefinition } from "../kernel/types"
import type { CallToolResult } from "../types/content"
import type { ToolWireDefinition } from "../types/driver"
import { executeTool } from "./execution"
import { ToolRegistry } from "./registry"
import type { ToolDefinition, ToolExecuteCall, ToolFilter, ToolService } from "./types"

/**
 * Concrete implementation of the ToolService claimed on ctx.tools.
 */
class ToolServiceImpl implements ToolService {
	private readonly ctx: PluginContext
	private readonly registry = new ToolRegistry()

	constructor(ctx: PluginContext) {
		this.ctx = ctx
	}

	register(tool: ToolDefinition): () => void {
		return this.registry.register(tool)
	}

	get(name: string): ToolDefinition | undefined {
		return this.registry.get(name)
	}

	has(name: string): boolean {
		return this.registry.has(name)
	}

	list(filter?: ToolFilter): ToolDefinition[] {
		return this.registry.list(filter)
	}

	projectWireTools(filter?: ToolFilter): ToolWireDefinition[] {
		return this.registry.projectWireTools(filter)
	}

	async execute(call: ToolExecuteCall): Promise<CallToolResult> {
		return await executeTool(this.registry, this.ctx.events, call)
	}
}

/**
 * Plugin that provides the v0.2 tools subsystem by claiming ctx.tools.
 */
export const toolsPlugin: PluginDefinition = {
	name: "tools",
	setup(ctx: PluginContext) {
		const service = new ToolServiceImpl(ctx)
		ctx.claim("tools", service)
	},
}
