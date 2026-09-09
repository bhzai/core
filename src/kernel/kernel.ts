import { llmPlugin } from "../llm/plugin"
import type { BHZAIDriver } from "../types/driver"
import type { ModelInfo } from "../types/model"
import "../llm/types"
import { validatePluginConfig } from "./config"
import { getDependentsCascade, sortPluginsTopologically } from "./dependency"
import { PluginNotFoundError, ServiceAlreadyClaimedError } from "./errors"
import { createEventBus } from "./event-bus"
import { HarnessSessionImpl } from "./harness-session"
import type {
	BailHandler,
	Disposable,
	EventBus,
	Harness,
	HarnessContext,
	HarnessCreateSessionOptions,
	HarnessOpenSessionOptions,
	HarnessOptions,
	HarnessSession,
	NotificationHandler,
	PluginContext,
	PluginDefinition,
	PluginTeardown,
	WaterfallHandler,
} from "./types"

interface LoadedPluginState {
	definition: PluginDefinition<unknown>
	config?: unknown
	teardown?: PluginTeardown
	disposables: Disposable[]
}

/**
 * Runs the optional teardown hook of a plugin safely.
 * @param state The loaded plugin state.
 * @param name The plugin name.
 */
async function runTeardown(state: LoadedPluginState, name: string): Promise<void> {
	if (!state.teardown) return
	try {
		await state.teardown()
	} catch (err: unknown) {
		console.error(`[Kernel] Error during teardown of plugin "${name}":`, err)
	}
}

/**
 * Executes all tracked effect disposables of a plugin in reverse order.
 * @param state The loaded plugin state.
 * @param name The plugin name.
 */
async function runDisposables(state: LoadedPluginState, name: string): Promise<void> {
	while (state.disposables.length > 0) {
		const dispose = state.disposables.pop()
		if (!dispose) continue
		try {
			await dispose()
		} catch (err: unknown) {
			console.error(`[Kernel] Error during effect disposal of plugin "${name}":`, err)
		}
	}
}

/**
 * Unloads a single loaded plugin by executing its teardown and effect disposables.
 * @param state The loaded plugin state.
 * @param name The plugin name.
 */
async function unloadSinglePlugin(state: LoadedPluginState, name: string): Promise<void> {
	await runTeardown(state, name)
	await runDisposables(state, name)
}

/**
 * Creates a scoped plugin context tracking all claimed services and event listeners for rollback.
 * @param baseCtx The root harness context.
 * @param pluginDisposables Array accumulating disposables registered by the plugin.
 * @param rootClaim Function to claim a service on the root context.
 * @returns A Scoped PluginContext instance.
 */
function createScopedPluginContext(
	baseCtx: HarnessContext,
	pluginDisposables: Disposable[],
	rootClaim: <TService>(name: string, service: TService) => Disposable,
): PluginContext {
	const scopedEvents = new Proxy(baseCtx.events, {
		get(target, prop, receiver) {
			if (prop === "on") {
				return <T = unknown>(event: string, handler: NotificationHandler<T>): Disposable => {
					const unsubscribe = target.on(event, handler)
					pluginDisposables.push(unsubscribe)
					return unsubscribe
				}
			}
			if (prop === "waterfall") {
				return <T = unknown, TCtx = unknown>(
					event: string,
					handler: WaterfallHandler<T, TCtx>,
				): Disposable => {
					const unsubscribe = target.waterfall(event, handler)
					pluginDisposables.push(unsubscribe)
					return unsubscribe
				}
			}
			if (prop === "bail") {
				return <T = unknown, TResult = unknown>(
					event: string,
					handler: BailHandler<T, TResult>,
				): Disposable => {
					const unsubscribe = target.bail(event, handler)
					pluginDisposables.push(unsubscribe)
					return unsubscribe
				}
			}
			const val = Reflect.get(target, prop, receiver)
			return typeof val === "function" ? val.bind(target) : val
		},
	})

	return new Proxy(baseCtx as PluginContext, {
		get(target, prop, receiver) {
			if (prop === "events") return scopedEvents
			if (prop === "claim") {
				return <TService>(name: string, service: TService): Disposable => {
					const unclaim = rootClaim(name, service)
					pluginDisposables.push(unclaim)
					return unclaim
				}
			}
			return Reflect.get(target, prop, receiver)
		},
	})
}

/**
 * Core Harness implementation managing the context and plugin lifecycle.
 */
class HarnessImpl implements Harness {
	readonly ctx: HarnessContext
	private readonly events: EventBus
	private readonly services = new Map<string, unknown>()
	private readonly loadedPlugins = new Map<string, LoadedPluginState>()

	constructor() {
		this.events = createEventBus()
		const rawContext: HarnessContext = { events: this.events }

		this.ctx = new Proxy(rawContext, {
			get: (target, prop, receiver) => {
				if (prop === "events") return this.events
				if (typeof prop === "string" && this.services.has(prop)) {
					return this.services.get(prop)
				}
				return Reflect.get(target, prop, receiver)
			},
		})
	}

	claim<TService>(name: string, service: TService): Disposable {
		if (name === "events" || this.services.has(name)) {
			throw new ServiceAlreadyClaimedError(name)
		}
		this.services.set(name, service)
		return () => {
			if (this.services.get(name) === service) {
				this.services.delete(name)
			}
		}
	}

	async load<TConfig = Record<string, unknown>>(
		plugin: PluginDefinition<TConfig>,
		config?: TConfig,
	): Promise<void> {
		if (this.loadedPlugins.has(plugin.name)) {
			await this.unload(plugin.name)
		}

		sortPluginsTopologically([plugin as PluginDefinition], new Set(this.loadedPlugins.keys()))
		validatePluginConfig(plugin.name, plugin.configSchema, config)

		const disposables: Disposable[] = []
		const scopedCtx = createScopedPluginContext(this.ctx, disposables, this.claim.bind(this))

		const teardownResult = await plugin.setup(scopedCtx, config)
		const teardown = typeof teardownResult === "function" ? teardownResult : undefined

		this.loadedPlugins.set(plugin.name, {
			definition: plugin as PluginDefinition<unknown>,
			config,
			teardown,
			disposables,
		})
	}

	async unload(pluginName: string): Promise<void> {
		if (!this.loadedPlugins.has(pluginName)) {
			throw new PluginNotFoundError(pluginName)
		}

		const cascade = getDependentsCascade(pluginName, this.loadedPlugins)
		for (const name of cascade) {
			const state = this.loadedPlugins.get(name)
			if (state) {
				await unloadSinglePlugin(state, name)
				this.loadedPlugins.delete(name)
			}
		}
	}

	async reload<TConfig = Record<string, unknown>>(
		plugin: PluginDefinition<TConfig>,
		config?: TConfig,
	): Promise<void> {
		await this.unload(plugin.name)
		await this.load(plugin, config)
	}

	hasPlugin(pluginName: string): boolean {
		return this.loadedPlugins.has(pluginName)
	}

	getLoadedPlugins(): string[] {
		return Array.from(this.loadedPlugins.keys())
	}

	async createSession(options?: HarnessCreateSessionOptions): Promise<HarnessSession> {
		const sessions = this.ctx.sessions
		if (!sessions) {
			throw new Error(
				"Harness.createSession requires the sessions service. Ensure sessionPlugin is loaded.",
			)
		}
		const metadata = {
			...options?.metadata,
			...(options?.model ? { model: options.model } : {}),
		}
		const session = await sessions.create({ ...options, metadata })
		const modelRef =
			(metadata.model as string | undefined) ??
			this.ctx.llm?.getDefaultModel() ??
			(await this.ctx.llm?.listModels())?.[0]?.ref
		return new HarnessSessionImpl(session, this.ctx, modelRef)
	}

	async openSession(id: string, options?: HarnessOpenSessionOptions): Promise<HarnessSession> {
		const sessions = this.ctx.sessions
		if (!sessions) {
			throw new Error(
				"Harness.openSession requires the sessions service. Ensure sessionPlugin is loaded.",
			)
		}
		const session = await sessions.open(id, options)
		const modelRef =
			(options?.model as string | undefined) ??
			(session.metadata?.model as string | undefined) ??
			this.ctx.llm?.getDefaultModel() ??
			(await this.ctx.llm?.listModels())?.[0]?.ref
		return new HarnessSessionImpl(session, this.ctx, modelRef)
	}

	async createConversation(options?: HarnessCreateSessionOptions): Promise<HarnessSession> {
		return await this.createSession(options)
	}

	async loadConversation(
		snapshot: { id?: string; sessionId?: string } | string,
		options?: HarnessOpenSessionOptions,
	): Promise<HarnessSession> {
		const id = typeof snapshot === "string" ? snapshot : (snapshot.id ?? snapshot.sessionId)
		if (!id) {
			throw new Error("Invalid conversation snapshot: missing session id.")
		}
		return await this.openSession(id, options)
	}

	addDriver(driver: BHZAIDriver): () => void {
		if (!this.ctx.llm) {
			throw new Error("Cannot add driver: llm service is not registered.")
		}
		return this.ctx.llm.addDriver(driver)
	}

	async listModels(): Promise<ModelInfo[]> {
		if (!this.ctx.llm) return []
		return await this.ctx.llm.listModels()
	}

	on<T = unknown>(event: string, handler: NotificationHandler<T>): Disposable {
		return this.events.on(event, handler)
	}

	emit<T = unknown>(event: string, payload: T): void {
		this.events.emit(event, payload)
	}

	get conversations() {
		return {
			list: async () => {
				const list = (await this.ctx.sessions?.list()) ?? []
				return list.map((s) => ({
					id: s.id,
					title: (s.metadata?.title as string) || "Conversation",
					createdAt: s.createdAt,
					updatedAt: s.updatedAt,
					messageCount: s.eventCount,
					modelId: (s.metadata?.model as string) || "",
				}))
			},
			load: async (id: string) => {
				const session = await this.ctx.sessions?.open(id)
				return session ? await session.export() : null
			},
			delete: async (id: string) => {
				await this.ctx.sessions?.delete(id)
			},
		}
	}

	async dispose(): Promise<void> {
		const pluginNames = Array.from(this.loadedPlugins.keys()).reverse()
		for (const name of pluginNames) {
			if (this.loadedPlugins.has(name)) {
				await this.unload(name)
			}
		}
		this.events.clear()
		this.services.clear()
	}
}

/**
 * Creates an empty v0.2 kernel harness and optionally loads configured plugins.
 * @param options Initialization options specifying plugins and configurations.
 * @returns A Promise resolving to the initialized Harness instance.
 */
export async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
	const harness = new HarnessImpl()

	if (options.plugins && options.plugins.length > 0) {
		const sorted = sortPluginsTopologically(options.plugins)
		for (const plugin of sorted) {
			const pluginConfig = options.config?.[plugin.name]
			await harness.load(plugin, pluginConfig)
		}
	}

	return harness
}

/**
 * Backwards-compatible harness class implementing the BHZAI host facade.
 */
export class BHZAI extends HarnessImpl {
	constructor() {
		super()
		const ctxWithClaim = {
			...this.ctx,
			claim: this.claim.bind(this),
		} as PluginContext
		llmPlugin.setup(ctxWithClaim)
	}

	/**
	 * No-op initialization hook for backwards compatibility with v0.1 hosts.
	 */
	async init(): Promise<this> {
		return this
	}
}
