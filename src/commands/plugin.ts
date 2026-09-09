import type { PluginContext, PluginDefinition } from "../kernel/types"
import { CommandRegistry } from "./registry"
import type { CommandContext, CommandDefinition, CommandResult, CommandService } from "./types"

/**
 * Concrete implementation of CommandService claimed on ctx.commands.
 */
class CommandServiceImpl implements CommandService {
	private readonly ctx: PluginContext
	private readonly registry = new CommandRegistry()

	constructor(ctx: PluginContext) {
		this.ctx = ctx
	}

	register(command: CommandDefinition): () => void {
		return this.registry.register(command)
	}

	get(name: string): CommandDefinition | undefined {
		return this.registry.get(name)
	}

	has(name: string): boolean {
		return this.registry.has(name)
	}

	list(): CommandDefinition[] {
		return this.registry.list()
	}

	async execute(name: string, args: string[], ctx?: CommandContext): Promise<CommandResult> {
		return await this.registry.execute(name, args, ctx)
	}

	async complete(name: string, prefix: string, ctx?: CommandContext): Promise<string[]> {
		return await this.registry.complete(name, prefix, ctx)
	}
}

/**
 * Plugin providing the v0.2 command subsystem by claiming ctx.commands.
 */
export const commandsPlugin: PluginDefinition = {
	name: "commands",
	setup(ctx: PluginContext) {
		const service = new CommandServiceImpl(ctx)
		ctx.claim("commands", service)
	},
}
