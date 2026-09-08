import type { CommandContext, CommandDefinition, CommandResult } from "./types"

const LEADING_SLASHES_REGEX = /^\/+/

/**
 * Normalizes a command name by stripping any leading slashes and trimming whitespace.
 * @param name Command name.
 */
export function normalizeCommandName(name: string): string {
	return name.trim().replace(LEADING_SLASHES_REGEX, "")
}

/**
 * Normalizes any return value from a command handler into a standard CommandResult.
 * @param raw Raw return value from command handler.
 */
export function normalizeCommandResult(raw: unknown): CommandResult {
	if (typeof raw === "string") {
		return { text: raw }
	}

	if (raw === undefined || raw === null) {
		return {}
	}

	if (typeof raw === "object") {
		if ("text" in raw || "error" in raw || "data" in raw) {
			return raw as CommandResult
		}
		return { data: raw }
	}

	return { text: String(raw) }
}

/**
 * Registry managing command storage, LIFO shadowing, dispatch, and completion.
 */
export class CommandRegistry {
	private readonly commandStacks = new Map<string, CommandDefinition[]>()

	/**
	 * Registers a command definition. If a command with the same name exists,
	 * shadows it until the returned cleanup function is invoked.
	 * @param command Command definition to register.
	 * @returns Disposable restoring any previously registered command under this name.
	 */
	register(command: CommandDefinition): () => void {
		const name = normalizeCommandName(command.name)
		let stack = this.commandStacks.get(name)
		if (!stack) {
			stack = []
			this.commandStacks.set(name, stack)
		}
		stack.push(command)

		return () => {
			const current = this.commandStacks.get(name)
			if (!current) return

			const idx = current.lastIndexOf(command)
			if (idx !== -1) {
				current.splice(idx, 1)
			}
			if (current.length === 0) {
				this.commandStacks.delete(name)
			}
		}
	}

	/**
	 * Retrieves the active command definition for a given name.
	 * @param name Command name.
	 */
	get(name: string): CommandDefinition | undefined {
		const stack = this.commandStacks.get(normalizeCommandName(name))
		if (!stack || stack.length === 0) return undefined
		return stack[stack.length - 1]
	}

	/**
	 * Checks whether a command with the given name is currently registered.
	 * @param name Command name.
	 */
	has(name: string): boolean {
		const stack = this.commandStacks.get(normalizeCommandName(name))
		return Boolean(stack && stack.length > 0)
	}

	/**
	 * Lists all currently active registered commands in insertion order.
	 */
	list(): CommandDefinition[] {
		const active: CommandDefinition[] = []
		for (const stack of this.commandStacks.values()) {
			if (stack.length > 0) {
				active.push(stack[stack.length - 1])
			}
		}
		return active
	}

	/**
	 * Dispatches and executes a registered command.
	 * @param name Command name.
	 * @param args Tokenized argument list.
	 * @param ctx Optional invocation context.
	 */
	async execute(name: string, args: string[], ctx: CommandContext = {}): Promise<CommandResult> {
		const normalized = normalizeCommandName(name)
		const command = this.get(normalized)
		if (!command) {
			const message = `Command "${normalized}" not found.`
			return { error: new Error(message), text: message }
		}

		if (ctx.signal?.aborted) {
			const message = "Command execution aborted."
			return { error: new Error(message), text: message }
		}

		try {
			const raw = await command.handler(args, ctx)
			return normalizeCommandResult(raw)
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err)
			return { error: err, text: message }
		}
	}

	/**
	 * Retrieves argument completion suggestions for a registered command.
	 * @param name Command name.
	 * @param prefix Current argument prefix.
	 * @param ctx Optional invocation context.
	 */
	async complete(name: string, prefix: string, ctx: CommandContext = {}): Promise<string[]> {
		const command = this.get(name)
		if (!command?.complete) {
			return []
		}

		try {
			const suggestions = await command.complete(prefix, ctx)
			return Array.isArray(suggestions) ? suggestions : []
		} catch {
			return []
		}
	}
}
