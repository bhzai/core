import type { EventBus, PluginContext } from "../../kernel/types"
import type { ToolDefinition, ToolService } from "../../tools/types"
import type { BHZAIToolDefinition } from "../../types/tool"
import { McpClient, type ToolRegistryTarget, deriveServerName } from "./client"
import type {
	McpClientOptions,
	McpPluginOptions,
	McpServerError,
	McpServerState,
	McpServerTool,
	McpService,
} from "./types"

interface ServerRecord {
	id: string
	config: McpServerState["config"]
	options?: McpClientOptions
	client?: McpClient
	state: McpServerState
	tools: Map<string, McpServerTool>
	unregisters: Map<string, () => void>
}

function toServerError(
	error: unknown,
	url: string,
	phase: "connect" | "refresh" | "detach",
): McpServerError {
	const err = error instanceof Error ? error : new Error(String(error))
	return {
		name: err.name,
		message: err.message,
		stack: err.stack,
		url,
		at: Date.now(),
		phase,
	}
}

/**
 * Concrete implementation of the McpService managing client lifecycles and tool projections.
 */
export class McpServiceImpl implements McpService {
	private readonly toolsService: ToolService
	private readonly events: EventBus
	private readonly defaultOptions?: McpClientOptions
	private readonly records = new Map<string, ServerRecord>()
	private readonly listeners = new Set<(servers: McpServerState[]) => void>()

	constructor(ctx: PluginContext, options?: McpPluginOptions) {
		const tools = ctx.tools
		if (!tools) {
			throw new Error("McpService requires the tools service to be registered.")
		}
		this.toolsService = tools
		this.events = ctx.events
		this.defaultOptions = options?.clientOptions
	}

	async attach(
		config: McpServerState["config"],
		options?: McpClientOptions,
	): Promise<McpServerState> {
		const serverName = config.name ?? deriveServerName(config.url)
		const clash = Array.from(this.records.values()).find((r) => r.state.serverName === serverName)
		if (clash) {
			return this.handleDuplicate(config, serverName)
		}

		const id = crypto.randomUUID()
		const mergedOptions = { ...this.defaultOptions, ...options }
		const record: ServerRecord = {
			id,
			config,
			options: mergedOptions,
			tools: new Map(),
			unregisters: new Map(),
			state: {
				id,
				config,
				serverName,
				status: "connecting",
				tools: [],
				deferred: config.deferred === true,
			},
		}

		this.records.set(id, record)
		this.notify()
		return await this.connect(record)
	}

	private handleDuplicate(config: McpServerState["config"], serverName: string): McpServerState {
		const id = crypto.randomUUID()
		const err: McpServerError = {
			name: "McpDuplicateServerError",
			message: `An MCP server named '${serverName}' is already attached. Remove it first, or give this one a distinct name.`,
			url: config.url,
			at: Date.now(),
			phase: "connect",
		}
		const state: McpServerState = {
			id,
			config,
			serverName,
			status: "error",
			tools: [],
			error: err,
			deferred: config.deferred === true,
		}
		this.notify()
		return state
	}

	private createRegistryShim(record: ServerRecord): ToolRegistryTarget {
		const serverName = record.state.serverName
		const prefix = `mcp__${serverName}__`

		return {
			addTool: (def: BHZAIToolDefinition) => {
				const toolDef: ToolDefinition = {
					name: def.name,
					title: def.title,
					description: def.description,
					inputSchema: def.inputSchema,
					outputSchema: def.outputSchema,
					icons: def.icons,
					annotations: def.annotations,
					execute: async (inv) => {
						const legacyInv = {
							conversation: undefined,
							params: inv.params,
							toolCallId: inv.callId,
							signal: inv.signal ?? new AbortController().signal,
							progress: (update: unknown) => {
								inv.progress?.(update)
							},
						}
						return await def.execute(legacyInv)
					},
				}
				const unreg = this.toolsService.register(toolDef)
				record.unregisters.set(def.name, unreg)
				const shortName = def.name.startsWith(prefix) ? def.name.slice(prefix.length) : def.name
				record.tools.set(def.name, {
					name: def.name,
					shortName,
					description: def.description,
				})
			},
			removeTool: (name: string) => {
				const unreg = record.unregisters.get(name)
				if (unreg) {
					unreg()
					record.unregisters.delete(name)
				}
				record.tools.delete(name)
			},
		} as ToolRegistryTarget
	}

	private async connect(record: ServerRecord): Promise<McpServerState> {
		const shim = this.createRegistryShim(record)
		const client = new McpClient(record.config, shim, record.options)
		record.client = client

		try {
			await client.connect()
			record.state = {
				...record.state,
				status: "connected",
				connectedAt: Date.now(),
				tools: Array.from(record.tools.values()),
				error: undefined,
			}
			this.events.emit("mcp/connected", {
				serverId: record.id,
				serverName: record.state.serverName,
			})
		} catch (thrown) {
			this.cleanupRecordTools(record)
			const error = toServerError(thrown, record.config.url, "connect")
			record.state = {
				...record.state,
				status: "error",
				error,
				tools: [],
			}
			this.events.emit("mcp/error", { serverId: record.id, error })
		}

		this.notify()
		return record.state
	}

	private cleanupRecordTools(record: ServerRecord): void {
		for (const unreg of record.unregisters.values()) {
			try {
				unreg()
			} catch {
				// Ignore unregister errors during cleanup
			}
		}
		record.unregisters.clear()
		record.tools.clear()
	}

	async detach(id: string): Promise<void> {
		const record = this.records.get(id)
		if (!record) return

		this.cleanupRecordTools(record)

		if (record.client) {
			try {
				await record.client.close()
			} catch {
				// Ignore client close errors during detach
			}
		}

		this.records.delete(id)
		this.events.emit("mcp/detached", {
			serverId: id,
			serverName: record.state.serverName,
		})
		this.notify()
	}

	async retry(id: string): Promise<McpServerState> {
		const record = this.records.get(id)
		if (!record) {
			throw new Error(`MCP server with id "${id}" not found.`)
		}
		if (record.state.status === "connected") {
			return record.state
		}
		this.cleanupRecordTools(record)
		record.state = {
			...record.state,
			status: "connecting",
			tools: [],
			error: undefined,
		}
		this.notify()
		return await this.connect(record)
	}

	async refresh(id: string): Promise<McpServerState> {
		const record = this.records.get(id)
		if (!record) {
			throw new Error(`MCP server with id "${id}" not found.`)
		}
		if (record.state.status !== "connected") {
			return record.state
		}
		this.cleanupRecordTools(record)
		return await this.connect(record)
	}

	list(): McpServerState[] {
		return Array.from(this.records.values()).map((r) => r.state)
	}

	async add(config: McpServerState["config"], options?: McpClientOptions): Promise<McpServerState> {
		return await this.attach(config, options)
	}

	async remove(id: string): Promise<void> {
		await this.detach(id)
	}

	get(id: string): McpServerState | undefined {
		return this.records.get(id)?.state
	}

	subscribe(listener: (servers: McpServerState[]) => void): () => void {
		this.listeners.add(listener)
		return () => {
			this.listeners.delete(listener)
		}
	}

	private notify(): void {
		const list = this.list()
		for (const listener of this.listeners) {
			try {
				listener(list)
			} catch {
				// Prevent subscriber error from crashing service
			}
		}
	}
}
