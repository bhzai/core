import type { McpClientOptions } from "../../../plugins/mcp/client"
import type { McpServerConfig } from "../../../types/mcp"

export type { McpClientOptions, McpServerConfig }

/**
 * Lifecycle state of a managed MCP server.
 */
export type McpServerStatus = "connecting" | "connected" | "error" | "detached"

/**
 * Structured snapshot of an MCP server connection error.
 */
export interface McpServerError {
	name: string
	message: string
	stack?: string
	url: string
	at: number
	phase: "connect" | "refresh" | "detach"
}

/**
 * Discovered MCP tool projection.
 */
export interface McpServerTool {
	name: string
	shortName: string
	description: string
}

/**
 * Immutable state record of a connected or connecting MCP server.
 */
export interface McpServerState {
	readonly id: string
	readonly config: McpServerConfig
	readonly serverName: string
	readonly status: McpServerStatus
	readonly tools: McpServerTool[]
	readonly error?: McpServerError
	readonly connectedAt?: number
	readonly deferred: boolean
}

/**
 * Configuration options for the MCP plugin.
 */
export interface McpPluginOptions {
	/** Optional list of servers to attach on startup. */
	servers?: McpServerConfig[]

	/** Default client options applied to attached servers. */
	clientOptions?: McpClientOptions
}

/**
 * Service managing MCP client connections and tool projections.
 */
export interface McpService {
	/**
	 * Attaches an MCP server by connecting and registering its tools into ctx.tools.
	 */
	attach(config: McpServerConfig, options?: McpClientOptions): Promise<McpServerState>

	/**
	 * Adds an MCP server (alias for attach).
	 */
	add(config: McpServerConfig, options?: McpClientOptions): Promise<McpServerState>

	/**
	 * Detaches an MCP server, unregistering its tools and closing the connection.
	 */
	detach(id: string): Promise<void>

	/**
	 * Removes an MCP server (alias for detach).
	 */
	remove(id: string): Promise<void>

	/**
	 * Retries connecting an existing MCP server entry.
	 */
	retry(id: string): Promise<McpServerState>

	/**
	 * Re-syncs the tool list for a connected server.
	 */
	refresh(id: string): Promise<McpServerState>

	/**
	 * Lists all attached MCP servers and their current status.
	 */
	list(): McpServerState[]

	/**
	 * Retrieves an attached MCP server by its internal identifier.
	 */
	get(id: string): McpServerState | undefined

	/**
	 * Subscribes to changes in the attached MCP servers list.
	 */
	subscribe(listener: (servers: McpServerState[]) => void): () => void
}

declare module "../../kernel/types" {
	interface HarnessServices {
		mcp?: McpService
	}
}
