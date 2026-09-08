import type { BHZAIDriver } from "../../types/driver"
import type { BHZAIMessage } from "../../types/message"
import type { ModelInfo } from "../../types/model"
import type { TurnInput, TurnOptions, TurnResult } from "../loop/types"
import type {
	CreateSessionOptions,
	OpenSessionOptions,
	SessionEvent,
	SessionExport,
} from "../sessions/types"

/**
 * A cleanup function that releases resources or subscriptions.
 */
export type Disposable = () => void | Promise<void>

/**
 * Teardown function returned by a plugin's setup method.
 */
export type PluginTeardown = () => void | Promise<void>

/**
 * Options for creating an active conversation session facade.
 */
export interface HarnessCreateSessionOptions extends CreateSessionOptions {
	model?: string
	[key: string]: unknown
}

/**
 * Options for opening an existing conversation session facade.
 */
export interface HarnessOpenSessionOptions extends OpenSessionOptions {
	model?: string
	[key: string]: unknown
}

/**
 * Handler for notification events.
 */
export type NotificationHandler<T = unknown> = (payload: T) => void | Promise<void>

/**
 * Middleware function for waterfall pipelines.
 */
export type WaterfallHandler<T = unknown, TCtx = unknown> = (
	value: T,
	ctx: TCtx,
	next: (nextValue: T) => Promise<T>,
) => Promise<T>

/**
 * Handler for bail pipelines. Stops at the first defined return value.
 */
export type BailHandler<T = unknown, TResult = unknown> = (
	payload: T,
) => Promise<TResult | undefined> | TResult | undefined

/**
 * Unified event bus supporting four dispatch modes (emit, serial, waterfall, bail).
 */
export interface EventBus {
	/**
	 * Subscribes a notification listener for emit and serial dispatches.
	 * @param event Name of the event.
	 * @param handler Callback to invoke when event triggers.
	 * @returns Disposable to unsubscribe.
	 */
	on<T = unknown>(event: string, handler: NotificationHandler<T>): Disposable

	/**
	 * Subscribes a waterfall middleware handler.
	 * @param event Name of the event.
	 * @param handler Middleware function receiving value, context, and next.
	 * @returns Disposable to unsubscribe.
	 */
	waterfall<T = unknown, TCtx = unknown>(
		event: string,
		handler: WaterfallHandler<T, TCtx>,
	): Disposable

	/**
	 * Subscribes a bail handler.
	 * @param event Name of the event.
	 * @param handler Callback that can return a value or undefined to continue.
	 * @returns Disposable to unsubscribe.
	 */
	bail<T = unknown, TResult = unknown>(event: string, handler: BailHandler<T, TResult>): Disposable

	/**
	 * Non-awaited, fire-and-forget notification broadcast.
	 * @param event Name of the event.
	 * @param payload Event payload data.
	 */
	emit<T = unknown>(event: string, payload: T): void

	/**
	 * Sequential awaited notification dispatch across all subscribed listeners.
	 * @param event Name of the event.
	 * @param payload Event payload data.
	 */
	runSerial<T = unknown>(event: string, payload: T): Promise<void>

	/**
	 * Executes a waterfall pipeline through all registered middleware.
	 * @param event Name of the event.
	 * @param initialValue Initial input value for the pipeline.
	 * @param context Auxiliary context passed to each middleware.
	 * @returns Final transformed value.
	 */
	runWaterfall<T = unknown, TCtx = unknown>(
		event: string,
		initialValue: T,
		context: TCtx,
	): Promise<T>

	/**
	 * Dispatches bail handlers in sequence until one returns a defined value.
	 * @param event Name of the event.
	 * @param payload Event payload data.
	 * @returns First defined result, or undefined if no handler responded.
	 */
	runBail<T = unknown, TResult = unknown>(event: string, payload: T): Promise<TResult | undefined>

	/**
	 * Clears all registered event listeners and middleware.
	 */
	clear(): void
}

/**
 * Services registry interface extended via TypeScript module augmentation.
 */
// biome-ignore lint/suspicious/noEmptyInterface: Augmented via module declaration merging across service plugins.
export interface HarnessServices {}

/**
 * Shared runtime context accessible across all plugins.
 */
export interface HarnessContext extends HarnessServices {
	/** The single unified event bus. */
	readonly events: EventBus

	/** Claimed services accessed directly by key. */
	readonly [key: string]: unknown
}

/**
 * Context provided to a plugin during its setup phase.
 */
export interface PluginContext extends HarnessContext {
	/**
	 * Claims an exclusive service key on the context.
	 * @param name Unique service name.
	 * @param service The service implementation instance.
	 * @returns Disposable that unclaims the service.
	 */
	claim<TService>(name: string, service: TService): Disposable
}

/**
 * Declarative contract defining a v0.2 plugin.
 */
export interface PluginDefinition<TConfig = Record<string, unknown>> {
	/** Unique identifier for the plugin. */
	name: string

	/** Optional list of plugin names required to be loaded first. */
	dependencies?: string[]

	/** Optional JSON-Schema object used to validate configuration. */
	configSchema?: Record<string, unknown>

	/**
	 * Setup callback called when the plugin is loaded into the harness.
	 * @param ctx Scoped plugin context.
	 * @param config Validated configuration for this plugin.
	 * @returns Optional teardown callback for cleanup on unload.
	 */
	setup(
		ctx: PluginContext,
		config?: TConfig,
	): Promise<PluginTeardown> | Promise<void> | PluginTeardown | void
}

/**
 * Options for instantiating a harness.
 */
export interface HarnessOptions {
	/** Initial set of plugins to load. */
	plugins?: PluginDefinition[]

	/** Configuration map keyed by plugin name. */
	config?: Record<string, Record<string, unknown>>
}

/**
 * Public harness interface managing plugins and the execution context.
 */
export interface Harness {
	/** The shared runtime context. */
	readonly ctx: HarnessContext

	/**
	 * Loads a single plugin into the harness.
	 * @param plugin The plugin definition.
	 * @param config Optional configuration for the plugin.
	 */
	load<TConfig = Record<string, unknown>>(
		plugin: PluginDefinition<TConfig>,
		config?: TConfig,
	): Promise<void>

	/**
	 * Unloads a plugin and reverts all its registered effects.
	 * @param pluginName Name of the plugin to unload.
	 */
	unload(pluginName: string): Promise<void>

	/**
	 * Reloads a plugin by unloading its current instance and loading the new definition.
	 * @param plugin The new plugin definition.
	 * @param config Optional configuration.
	 */
	reload<TConfig = Record<string, unknown>>(
		plugin: PluginDefinition<TConfig>,
		config?: TConfig,
	): Promise<void>

	/**
	 * Checks if a plugin is currently loaded.
	 * @param pluginName Name of the plugin.
	 */
	hasPlugin(pluginName: string): boolean

	/**
	 * Returns the list of currently loaded plugin names in topological order.
	 */
	getLoadedPlugins(): string[]

	/**
	 * Creates an active conversation session facade.
	 * @param options Session creation options.
	 */
	createSession(options?: HarnessCreateSessionOptions): Promise<HarnessSession>

	/**
	 * Opens an existing conversation session by ID.
	 * @param id Unique session ID.
	 * @param options Options for opening.
	 */
	openSession(id: string, options?: HarnessOpenSessionOptions): Promise<HarnessSession>

	/**
	 * Creates an active conversation session facade (alias for createSession).
	 * @param options Session creation options.
	 */
	createConversation(options?: HarnessCreateSessionOptions): Promise<HarnessSession>

	/**
	 * Loads an existing conversation session from a snapshot or ID.
	 * @param snapshot Session snapshot or identifier.
	 * @param options Options for opening.
	 */
	loadConversation(
		snapshot: { id?: string; sessionId?: string } | string,
		options?: HarnessOpenSessionOptions,
	): Promise<HarnessSession>

	/**
	 * Registers an LLM driver on the claimed LLM service.
	 * @param driver The driver instance to register.
	 */
	addDriver(driver: BHZAIDriver): () => void

	/**
	 * Lists all models merged across registered LLM drivers.
	 */
	listModels(): Promise<ModelInfo[]>

	/**
	 * Subscribes to events on the harness event bus.
	 * @param event Event name.
	 * @param handler Notification handler callback.
	 */
	on<T = unknown>(event: string, handler: NotificationHandler<T>): Disposable

	/**
	 * Dispatches an event across the harness event bus.
	 * @param event Event name.
	 * @param payload Event data payload.
	 */
	emit<T = unknown>(event: string, payload: T): void

	/**
	 * Conversation management operations for sidebar and host integration.
	 */
	readonly conversations: {
		list(): Promise<
			Array<{
				id: string
				title: string
				createdAt: number
				updatedAt: number
				messageCount: number
				modelId: string
			}>
		>
		load(id: string): Promise<SessionExport | null>
		delete(id: string): Promise<void>
	}

	/**
	 * Shuts down the harness, unloading all plugins in reverse order.
	 */
	dispose(): Promise<void>
}

/**
 * Public embedding facade for an active session.
 */
export interface HarnessSession {
	/** Unique session identifier. */
	readonly id: string

	/** Currently assigned model reference. */
	readonly model: string

	/** Current session execution status. */
	readonly status: "idle" | "running"

	/** Token usage accumulated across turns in this session. */
	readonly usage: {
		inputTokens: number
		outputTokens: number
		totalTokens: number
	}

	/** Context usage details for the active session. */
	readonly contextUsage?: {
		totalTokens: number
		contextWindow: number
		utilization: number
		lastInputTokens?: number
		lastOutputTokens?: number
	}

	/**
	 * Switches the active model reference for subsequent turns in this session.
	 * @param modelRef Qualified or bare model reference.
	 */
	setModel(modelRef: string): Promise<void>

	/**
	 * Sends user input into the session and executes an agent turn.
	 * @param input User prompt or structured content blocks.
	 * @param options Turn configuration options.
	 */
	send(input: TurnInput, options?: TurnOptions): Promise<TurnResult>

	/**
	 * Sends user input text (convenience alias for send).
	 * @param text User prompt text.
	 * @param options Turn configuration options.
	 */
	sendMessage(text: string, options?: TurnOptions): Promise<TurnResult>

	/**
	 * Cancels the currently executing turn, if any.
	 * @param reason Optional cancellation reason.
	 */
	abort(reason?: string): void

	/**
	 * Subscribes to events scoped to this session.
	 * @param event Event name.
	 * @param handler Event callback.
	 */
	on(event: string, handler: (payload: unknown) => void): Disposable

	/**
	 * Exports the full session log into a portable versioned JSON format.
	 */
	export(): Promise<SessionExport>

	/**
	 * Returns the raw events recorded in this session.
	 */
	getEvents(): readonly SessionEvent[]

	/**
	 * Serializes session messages for presentation.
	 */
	toJSON(): {
		id: string
		model: string
		messages: BHZAIMessage[]
		metadata: Record<string, unknown>
	}
}
