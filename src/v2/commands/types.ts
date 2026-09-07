/**
 * Context provided to a command handler upon invocation.
 */
export interface CommandContext {
	/** Active session ID, if invoked in the context of a session. */
	sessionId?: string

	/** Abort signal allowing command cancellation. */
	signal?: AbortSignal

	/** Optional auxiliary host or plugin data. */
	[key: string]: unknown
}

/**
 * Standardized result returned from executing a command.
 */
export interface CommandResult {
	/** Optional human-readable message or output text. */
	text?: string

	/** Error encountered during execution, if any. */
	error?: unknown

	/** Optional structured data produced by the command. */
	data?: unknown
}

/**
 * Allowed return types from a command handler.
 */
// biome-ignore lint/suspicious/noConfusingVoidType: Command handlers can return void or undefined when returning no message.
export type CommandHandlerResult = CommandResult | string | undefined | void

/**
 * Handler function invoked when a command is dispatched.
 */
export type CommandHandler = (
	args: string[],
	ctx: CommandContext,
) => Promise<CommandHandlerResult> | CommandHandlerResult

/**
 * Autocomplete hook providing argument suggestions.
 */
export type CommandCompleter = (
	prefix: string,
	ctx?: CommandContext,
) => Promise<string[]> | string[]

/**
 * Standard command definition registered into the command service.
 */
export interface CommandDefinition {
	/** Unique command name (e.g. 'help', 'clear', 'reset'). */
	name: string

	/** Brief human-readable description shown in listings. */
	description: string

	/** Handler function executed when the command is invoked. */
	handler: CommandHandler

	/** Optional autocomplete hook for command arguments. */
	complete?: CommandCompleter
}

/**
 * Service managing command registration, shadowing, and dispatch.
 */
export interface CommandService {
	/**
	 * Registers a command into the service.
	 * If a command with the same name already exists, shadows it until disposed.
	 * @param command Command definition.
	 * @returns Disposable that restores any shadowed command.
	 */
	register(command: CommandDefinition): () => void

	/**
	 * Retrieves an active command definition by name.
	 * @param name Command name.
	 */
	get(name: string): CommandDefinition | undefined

	/**
	 * Checks whether a command with the specified name is registered.
	 * @param name Command name.
	 */
	has(name: string): boolean

	/**
	 * Lists all currently active registered commands.
	 */
	list(): CommandDefinition[]

	/**
	 * Dispatches and executes a command by name with arguments.
	 * @param name Command name.
	 * @param args Tokenized argument list.
	 * @param ctx Optional invocation context.
	 */
	execute(name: string, args: string[], ctx?: CommandContext): Promise<CommandResult>

	/**
	 * Queries argument completion candidates for a command.
	 * @param name Command name.
	 * @param prefix Current argument prefix.
	 * @param ctx Optional invocation context.
	 */
	complete(name: string, prefix: string, ctx?: CommandContext): Promise<string[]>
}

declare module "../kernel/types" {
	interface HarnessServices {
		commands?: CommandService
	}
}
