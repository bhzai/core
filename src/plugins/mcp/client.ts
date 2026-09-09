// Built-in MCP (Model Context Protocol) streamable-HTTP client — handshake,
// discovery, live resync, calls, progress & cancellation (ARCHITECTURE.md
// § 9.3, spec rev 2025-11-25).
//
// Scope of THIS file:
//  - TASK_0011: the JSON-RPC 2.0 envelope over `fetch`, the `initialize` →
//    `notifications/initialized` handshake, the `MCP-Protocol-Version` /
//    `Mcp-Session-Id` header contract, and paginated `tools/list` discovery
//    that registers every remote tool into the shared TASK_0008 tool registry
//    under the `mcp__<server>__<tool>` namespace.
//  - TASK_0012: live re-sync via `notifications/tools/list_changed` (with a
//    `pollToolsList()` fallback since SSE push is not fully wired), a real
//    `tools/call` execute binding, `outputSchema` validation with graceful
//    `isError` degradation, per-call timeouts, a progress-callback seam, and
//    `AbortSignal`-driven cancellation issuing `notifications/cancelled`.
//  - TASK_0013: a mandatory approval-gate seam (`ApprovalGate`) wrapping
//    every `tools/call` (and reused by TASK_0014's sampling routing), with
//    the `autoApproveTools` opt-out short-circuit, plus inert storage of
//    the `trusted` config flag (consumed by TASK_0017's availability
//    filtering, NOT by this task's own logic).
//  - TASK_0014: opt-in client capabilities — `elicitation`, `sampling`,
//    `roots`. The `initialize` handshake's `capabilities` object is built
//    conditionally (key-presence-based) from `McpClientCapabilityOptions`.
//    Inbound `elicitation/create`/`sampling/createMessage`/`roots/list`
//    requests are dispatched to the corresponding handlers; outbound
//    `notifications/roots/list_changed` is sent on
//    `client.notifyRootsChanged()`. Sampling reuses the TASK_0013
//    `ApprovalGate` verbatim.
//  - TASK_0016: deferred tool loading via `search_tools`. When
//    `deferred: true` is set, `connect()` fetches the full `tools/list`
//    result but caches it instead of registering every tool eagerly.
//    Only two synthetic tools (`mcp__<server>__list_tools` and
//    `mcp__<server>__search_tools`) are registered; the real tools are
//    registered live when the model calls a synthetic tool. Purely
//    client-side policy — no server support or protocol extension
//    required.
//
// ENVIRONMENT BOUNDARY (§ 5): web-standard APIs only — `fetch`,
// `AbortController`, `crypto.randomUUID`, `Headers`. No Node built-ins, no
// SSE/stdio library. `ajv` is a pure-JS JSON Schema validator with no
// environment-specific bindings (already a runtime dependency of the kernel
// for TASK_0006's config step), so importing it here for `outputSchema`
// validation does not violate the "web-standard APIs only" rule. This module
// is internal to `src/plugins/mcp/`; the public `bh.addMcp()` entry point that
// wraps it is TASK_0015's job, not this task's.
//
// SPEC READING NOTE: ARCHITECTURE.md describes MCP client behavior at a
// summary level, not a wire-protocol level. The exact JSON-RPC field names and
// transport nuances below were confirmed against the live MCP spec at
// https://modelcontextprotocol.io/specification/2025-11-25 — every place where
// external reading was required is cited inline so future readers know which
// details came from the spec versus the architecture doc.
//
// KNOWN GAP (SSE-streamed responses): the streamable-HTTP transport permits a
// server to respond to a POSTed JSON-RPC request with either a plain JSON body
// (`Content-Type: application/json`) OR an SSE stream
// (`Content-Type: text/event-stream`) that eventually delivers the JSON-RPC
// response. THIS CLIENT correctly parses the plain-JSON case. Full SSE-stream
// parsing (reading `event:` / `data:` frames, reassembling the JSON-RPC
// response, handling server-to-client notifications interleaved on the stream)
// is deferred — see the comment on `parseResponseBody` below. This is
// documented explicitly rather than silently half-supported. A future task may
// implement a robust SSE reader; until then, servers that only ever respond
// with SSE streams (rare in practice for request/response methods like
// `initialize` and `tools/list`) will not be supported by this client.
//
// KNOWN GAP (live push notifications): receiving an unsolicited server-to-
// client notification like `notifications/tools/list_changed` requires either
// an open SSE stream from the `initialize` response or a subsequent long-lived
// GET/SSE connection (spec: /basic/transports). Since full SSE-stream
// listening is not implemented (see above), this client does NOT automatically
// receive push notifications. As a documented fallback, {@link pollToolsList}
// exposes a manual re-sync entry point a host can call on a timer or on
// demand. The internal {@link handleListChanged} method is also exposed so a
// future SSE-listening task (or a test) can drive a resync directly. This is
// documented explicitly rather than silently pretending live push works.

import Ajv, { type ValidateFunction } from "ajv"
import type {
	BHZAIToolDefinition,
	CallToolResult,
	ContentBlock,
	JSONSchema,
	McpServerConfig,
	ToolInvocation,
} from "../../types/index.js"

/** Minimal tool sink interface required by {@link McpClient}. */
export interface ToolRegistryTarget {
	addTool(def: BHZAIToolDefinition): void
	removeTool(name: string): void
}
export type ToolRegistry = ToolRegistryTarget
import { type ApprovalCall, type McpApprovalOptions, guardCall } from "./approval.js"
import {
	type CapabilityEventBus,
	type InboundRequestResult,
	type McpClientCapabilityOptions,
	type SamplingDriverRegistry,
	buildClientCapabilities,
	capabilityNotOptedInError,
	handleElicitation,
	handleRootsList,
	handleSampling,
	rootsListChangedNotification,
} from "./capabilities.js"
import {
	type DeferredContext,
	type DeferredMcpTool,
	eagerRegisterAndAnswer,
	registerDeferredTools,
} from "./deferred.js"

// ---------------------------------------------------------------------------
// JSON-RPC 2.0 envelope (hand-rolled per § 5's "web-standard APIs only" rule;
// no third-party JSON-RPC dependency). Spec:
// https://www.jsonrpc.org/specification — field names below match JSON-RPC 2.0
// verbatim.
// ---------------------------------------------------------------------------

/** JSON-RPC 2.0 request (carries an `id`; expects a response). */
interface JsonRpcRequest {
	readonly jsonrpc: "2.0"
	readonly id: string | number
	readonly method: string
	readonly params?: unknown
}

/** JSON-RPC 2.0 notification (no `id`; no response expected). */
interface JsonRpcNotification {
	readonly jsonrpc: "2.0"
	readonly method: string
	readonly params?: unknown
}

/** JSON-RPC 2.0 error object, carried by a response on failure. */
interface JsonRpcError {
	readonly code: number
	readonly message: string
	readonly data?: unknown
}

/** JSON-RPC 2.0 response (carries the matching `id` plus `result` or `error`). */
interface JsonRpcResponse {
	readonly jsonrpc: "2.0"
	readonly id: string | number
	readonly result?: unknown
	readonly error?: JsonRpcError
}

// ---------------------------------------------------------------------------
// MCP-spec-derived shapes (confirmed against
// https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle
// and /server/tools). These are local to this module — they model the wire
// shapes this client sends/receives, not the public BHZAI surface.
// ---------------------------------------------------------------------------

/**
 * `initialize` request `params` (spec: /basic/lifecycle). `protocolVersion` is
 * the client's requested/baseline version; `capabilities` is the client's
 * declared optional features (empty `{}` until TASK_0014 populates opt-ins);
 * `clientInfo` identifies the client implementation.
 */
interface InitializeParams {
	readonly protocolVersion: string
	readonly capabilities: Record<string, unknown>
	readonly clientInfo: { readonly name: string; readonly version: string }
}

/**
 * `initialize` response `result` (spec: /basic/lifecycle). The negotiated
 * `protocolVersion`, the server's declared `capabilities` (needed by
 * TASK_0012 to check `tools.listChanged`), and `serverInfo` identifying the
 * server implementation.
 */
interface InitializeResult {
	readonly protocolVersion: string
	readonly capabilities: ServerCapabilities
	readonly serverInfo: { readonly name: string; readonly version: string }
	readonly instructions?: string
}

/**
 * Server-declared capabilities (spec: /basic/lifecycle). Only the `tools`
 * sub-shape is modeled here since TASK_0012 needs `tools.listChanged`; other
 * capability keys (`prompts`, `resources`, `logging`, `tasks`, ...) are
 * passed through as `unknown` and ignored by this client.
 */
interface ServerCapabilities {
	readonly tools?: { readonly listChanged?: boolean }
	readonly [key: string]: unknown
}

/**
 * A single MCP `Tool` object as returned by `tools/list` (spec: /server/tools).
 * `name`, `description`, `inputSchema` are required; `title`, `outputSchema`,
 * `icons`, `annotations` are optional and passed through to the BHZAI registry
 * unchanged per § 9.3 item 2's "passed through untouched" wording.
 */
interface McpTool {
	readonly name: string
	readonly title?: string
	readonly description: string
	readonly inputSchema: JSONSchema
	readonly outputSchema?: JSONSchema
	readonly icons?: unknown
	readonly annotations?: unknown
}

/** `tools/list` response `result` (spec: /server/tools, with pagination). */
interface ToolsListResult {
	readonly tools: McpTool[]
	readonly nextCursor?: string
}

/**
 * Result of a live re-sync diff (TASK_0012). Each array holds namespaced
 * `mcp__<server>__<tool>` names. `added` and `removed` fire
 * `tool.registered`/`tool.removed` respectively (via the shared
 * {@link ToolRegistry}); `updated` fires `tool.registered` (blanket-replace
 * per the diff policy in {@link McpClient.handleListChanged}).
 */
export interface ToolListDiff {
	/** Namespaced names present in the new set but not the old. */
	added: string[]
	/** Namespaced names present in the old set but not the new. */
	removed: string[]
	/** Namespaced names present in both (re-registered to pick up changes). */
	updated: string[]
}

// ---------------------------------------------------------------------------
// Errors.
// ---------------------------------------------------------------------------

/**
 * Dedicated error type for MCP handshake failures (non-2xx HTTP status,
 * JSON-RPC error object, or malformed/unparseable response body). MCP-specific
 * errors are squarely this module's own domain, so a dedicated error class is
 * acceptable here (unlike TASK_0008's more conservative plain-`Error` choice).
 */
export class McpHandshakeError extends Error {
	constructor(message: string) {
		super(message)
		this.name = "McpHandshakeError"
	}
}

/**
 * Dedicated error type for a `tools/call` that exceeded the configured
 * per-call timeout (TASK_0012, § 9.3 item 5 — spec "SHOULD" enforced as
 * mandatory-for-this-task). Distinct from {@link McpCallError} so callers can
 * branch on "timed out" vs "the server returned an error" without string-
 * matching the message.
 */
export class McpTimeoutError extends Error {
	/** The tool name (namespaced) whose call timed out. */
	readonly toolName: string
	/** The configured timeout in milliseconds that elapsed. */
	readonly timeoutMs: number
	constructor(toolName: string, timeoutMs: number) {
		super(`MCP tools/call for '${toolName}' timed out after ${timeoutMs}ms`)
		this.name = "McpTimeoutError"
		this.toolName = toolName
		this.timeoutMs = timeoutMs
	}
}

/**
 * Dedicated error type for a `tools/call` that returned a JSON-RPC error
 * object or a non-2xx HTTP status (distinct from a successful `CallToolResult`
 * carrying `isError: true`, which is a *tool-level* error surfaced through the
 * normal result shape, not a transport/protocol error).
 */
export class McpCallError extends Error {
	constructor(message: string) {
		super(message)
		this.name = "McpCallError"
	}
}

/**
 * Per-call timeout configuration for {@link McpClient}. The default (60_000ms)
 * is an explicit assumption — the architecture doc does not specify a number.
 * A host may override it via {@link McpClient}'s constructor `options` arg or
 * rely on the default. Per-call overrides are NOT supported at this layer; a
 * future task may add them if a host needs per-tool timeout tuning.
 *
 * TASK_0013 extends this options object with the {@link McpApprovalOptions}
 * shape (approval gate + `autoApproveTools` opt-out). TASK_0014 extends it
 * further with {@link McpClientCapabilityOptions} (elicitation/sampling/roots
 * opt-ins) plus an optional driver-registry handle for sampling routing and
 * an optional event-bus handle for the `mcp.elicitation` observability emit.
 * All of these fields are threaded through unchanged by TASK_0015's
 * `bh.addMcp()` wrapper.
 */
export interface McpClientOptions extends McpApprovalOptions, McpClientCapabilityOptions {
	/** Per-call timeout in milliseconds. Defaults to 60_000 (60s). */
	callTimeoutMs?: number
	/**
	 * Driver registry handle used by sampling routing (TASK_0014). Required
	 * when `sampling` is opted into; if omitted, inbound
	 * `sampling/createMessage` requests fail with an internal error.
	 */
	driverRegistry?: SamplingDriverRegistry
	/**
	 * Framework event bus handle used for the `mcp.elicitation`
	 * observability emit (TASK_0014). Optional — when omitted, the
	 * observability hook is skipped (the `onElicit` handler still runs).
	 */
	eventBus?: CapabilityEventBus
}

// ---------------------------------------------------------------------------
// Client.
// ---------------------------------------------------------------------------

/**
 * Default client `capabilities` sent in the `initialize` request. Empty `{}`
 * until TASK_0014 populates opt-in client capabilities (roots, sampling,
 * elicitation, tasks). Confirmed against spec /basic/lifecycle: an empty
 * capabilities object is a legal "the client declares no optional features"
 * signal.
 */
const DEFAULT_CLIENT_CAPABILITIES: Record<string, unknown> = {}

/**
 * The protocol version this client requests in the `initialize` handshake.
 * Spec rev 2025-11-25 per ARCHITECTURE.md § 9.3. The server MAY respond with a
 * different version it supports; this client stores and uses whatever the
 * server returns.
 */
const REQUESTED_PROTOCOL_VERSION = "2025-11-25"

/**
 * `clientInfo` sent in the `initialize` request (spec: /basic/lifecycle).
 * Uses a documented placeholder name/version rather than wiring the real
 * `package.json` values at this layer — the client is an internal building
 * block, and TASK_0015 (the public `bh.addMcp()` wrapper) may override this if
 * a host wants its own identity advertised. Confirmed against spec: `name`
 * and `version` are the only required `clientInfo` fields.
 */
const DEFAULT_CLIENT_INFO = { name: "@bhzai/core", version: "0.1.0" } as const

/**
 * Default per-call timeout for `tools/call` (TASK_0012, § 9.3 item 5). 60
 * seconds is an explicit assumption — the architecture doc does not specify a
 * number. A host may override via {@link McpClientOptions.callTimeoutMs}.
 */
const DEFAULT_CALL_TIMEOUT_MS = 60_000

/**
 * Generate a JSON-RPC request id. Uses `crypto.randomUUID()` per § 5's
 * "web-standard APIs only" rule (no Node-specific id generators). Confirmed
 * available in every supported runtime (browsers, Node ≥ 19, Deno, Bun).
 */
function nextRequestId(): string {
	return crypto.randomUUID()
}

/**
 * Derive a fallback server name from the URL's hostname when `config.name` is
 * omitted. § 6's `McpServerConfig` marks `name` as optional; the namespaced
 * tool prefix `mcp__<server>__<tool>` still needs *some* server identifier, so
 * the hostname (without port) is used as a stable, human-readable fallback.
 * Non-alphanumeric characters in the hostname are replaced with `-` so the
 * resulting tool names stay within § 9.1's `[a-zA-Z0-9_.-]` allowed set.
 *
 * Exported for {@link McpManager}, which needs the same fallback to know a
 * server's `mcp__<server>__` tool prefix before the handshake resolves. It is
 * exported from this module only — not re-exported from the subpath barrel —
 * so it stays an internal detail of `src/plugins/mcp/` rather than part of the
 * package's public API.
 */
export function deriveServerName(url: string): string {
	try {
		const host = new URL(url).hostname
		return host.replace(/[^a-zA-Z0-9_.-]/g, "-") || "mcp-server"
	} catch {
		return "mcp-server"
	}
}

/**
 * The internal MCP streamable-HTTP client (TASK_0011). One instance per
 * attached MCP server. Owns the handshake state (negotiated protocol version,
 * session id, server capabilities) and the discovery step that registers
 * remote tools into the shared {@link ToolRegistry}.
 *
 * This class is INTERNAL to `src/plugins/mcp/`. The public `bh.addMcp()`
 * entry point (TASK_0015) constructs one of these per `McpServerConfig` and
 * calls {@link connect}. This class does NOT attach itself to the `BHZAI`
 * kernel instance — it receives the {@link ToolRegistry} to register into and
 * does the rest.
 */
export class McpClient {
	/** The config this client was constructed with (url, headers, name, ...). */
	private readonly config: Required<Pick<McpServerConfig, "url" | "name" | "trusted">> &
		Pick<McpServerConfig, "headers" | "deferred">

	/** The shared tool registry discovered tools are registered into. */
	private readonly toolRegistry: ToolRegistry

	/** Per-call timeout in milliseconds (TASK_0012). Defaults to 60_000. */
	private readonly callTimeoutMs: number

	/**
	 * Approval-gate options (TASK_0013, § 9.3 item 6). Stores the
	 * {@link ApprovalGate} subscriber and the `autoApproveTools` opt-out flag
	 * supplied at construction time. The refusal policy is implemented in
	 * {@link guardCall} (see `approval.ts`); this field is the per-instance
	 * storage the `tools/call` execute binding reads from.
	 *
	 * TEMPORARY INTEGRATION SEAM: see the prominent comment at the top of
	 * `approval.ts`. TASK_0026 must wire the real `tool(beforeCall)`
	 * blockable event dispatch through this seam when it lands.
	 */
	private readonly approvalOptions: McpApprovalOptions | undefined

	/**
	 * Capability opt-ins (TASK_0014, § 9.3 "Client capabilities"). Stores
	 * the `elicitation`/`sampling`/`roots` opt-in objects supplied at
	 * construction time. The `initialize` handshake's `capabilities` object
	 * is built conditionally from this field via
	 * {@link buildClientCapabilities} (key-presence-based — a capability is
	 * advertised IFF its opt-in is present, entirely absent otherwise).
	 */
	private readonly capabilityOptions: McpClientCapabilityOptions | undefined

	/**
	 * Driver registry handle for sampling routing (TASK_0014). Optional —
	 * when `sampling` is opted into but no registry is supplied, inbound
	 * `sampling/createMessage` requests fail with an internal error.
	 */
	private readonly driverRegistry: SamplingDriverRegistry | undefined

	/**
	 * Framework event bus handle for the `mcp.elicitation` observability
	 * emit (TASK_0014). Optional — when omitted, the observability hook is
	 * skipped (the `onElicit` handler still runs).
	 */
	private readonly eventBus: CapabilityEventBus | undefined

	/** Negotiated protocol version (from `initialize` response), or null pre-handshake. */
	private protocolVersion: string | null = null

	/** Session id from the `Mcp-Session-Id` response header, or null if stateless. */
	private sessionId: string | null = null

	/** Server-declared capabilities (from `initialize` response). */
	private serverCapabilities: ServerCapabilities | null = null

	/**
	 * Cached set of discovered tool names (the `mcp__<server>__<tool>` keys)
	 * from the last successful `tools/list` pagination. TASK_0012 uses this to
	 * diff against a re-sync result.
	 */
	private cachedToolNames: Set<string> = new Set()

	/**
	 * TASK_0016: the full cached `tools/list` discovery result for a
	 * `deferred: true` attach. Populated by `connect()` when `deferred` is
	 * set (the discovery fetch runs, but instead of registering every tool
	 * eagerly, the result is cached here and only the two synthetic
	 * `list_tools`/`search_tools` tools are registered). Consumed by
	 * `eagerRegisterAndAnswer()` when the model calls a synthetic tool.
	 */
	private cachedDeferredTools: DeferredMcpTool[] | undefined

	/**
	 * TASK_0016: whether the eager real-tool registration has already
	 * happened for this deferred client. Once `true`, subsequent synthetic-
	 * tool calls skip the registration loop (the tools are already in the
	 * registry) and just answer the call. Avoids repeated registration
	 * churn on multiple `search_tools` calls.
	 */
	private deferredEagerRegistered = false

	/**
	 * Map of in-flight `tools/call` request ids to their `AbortController`s,
	 * so an `AbortSignal` abort on the invocation can trigger the per-call
	 * controller and send a `notifications/cancelled` for the matching id
	 * (TASK_0012, § 9.3 item 5). Cleared on call settlement.
	 */
	private readonly inflightCalls: Map<string, AbortController> = new Map()

	/**
	 * Lazily-instantiated `ajv` validator for `outputSchema` validation
	 * (TASK_0012). Reused across calls; `ajv` is the same pure-JS validator
	 * the kernel uses for TASK_0006's config step, so no new dependency is
	 * introduced by importing it here.
	 */
	private ajvInstance: Ajv | undefined

	constructor(config: McpServerConfig, toolRegistry: ToolRegistry, options?: McpClientOptions) {
		this.config = {
			url: config.url,
			name: config.name ?? deriveServerName(config.url),
			headers: config.headers,
			deferred: config.deferred,
			// TASK_0013: store the resolved `trusted` flag (default `false` when
			// omitted). This task does NOT consume the flag for any
			// filtering/approval decision — it only stores and exposes it for
			// TASK_0017's `resolveAvailableTools` to consult later.
			trusted: config.trusted === true,
		}
		this.toolRegistry = toolRegistry
		this.callTimeoutMs = options?.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS
		this.approvalOptions = options
		this.capabilityOptions = options
		this.driverRegistry = options?.driverRegistry
		this.eventBus = options?.eventBus
	}

	/** The bhzai-local server name used to namespace discovered tools. */
	get serverName(): string {
		return this.config.name
	}

	/**
	 * Whether the host marked this MCP server as a trusted source of tool
	 * annotations (TASK_0013, § 9.3 item 7, § 13). Defaults to `false` when
	 * the `McpServerConfig.trusted` field was omitted.
	 *
	 * INERT STORAGE: this accessor only returns the stored flag — it does NOT
	 * implement any behavior that reads it to change availability, filtering,
	 * or auto-approval. TASK_0017's `resolveAvailableTools` (and any host-side
	 * policy layer) is the consumer that guarantees untrusted MCP tool
	 * annotations (e.g. a server-supplied `destructiveHint`) never influence
	 * the availability algorithm unless `trusted: true`.
	 */
	isTrusted(): boolean {
		return this.config.trusted
	}

	/** The server's declared capabilities, or null before the handshake completes. */
	get capabilities(): ServerCapabilities | null {
		return this.serverCapabilities
	}

	/**
	 * TASK_0014: handle an inbound server-to-client request
	 * (`elicitation/create`, `sampling/createMessage`, or `roots/list`).
	 *
	 * This is the dispatch entry point the transport layer (or a future
	 * SSE-listening task) calls when the server sends a JSON-RPC request
	 * that requires a response. It routes to the corresponding handler in
	 * `capabilities.ts` based on the `method`:
	 *  - `elicitation/create` → {@link handleElicitation}
	 *  - `sampling/createMessage` → {@link handleSampling}
	 *  - `roots/list` → {@link handleRootsList}
	 *
	 * For any other method, returns a `method not found` JSON-RPC error.
	 *
	 * The returned `InboundRequestResult` carries either a `result` or an
	 * `error`; the caller is responsible for sending it back to the server
	 * as a JSON-RPC response (this method does NOT send the response itself
	 * — it only computes it, so a transport layer can decide how/when to
	 * deliver it).
	 *
	 * @param id      The JSON-RPC request id (echoed in any error response).
	 * @param method  The JSON-RPC method name.
	 * @param params  The request params (validated loosely by the handler).
	 */
	async handleInboundRequest(
		id: string | number,
		method: string,
		params: unknown,
	): Promise<InboundRequestResult> {
		switch (method) {
			case "elicitation/create":
				return handleElicitation(
					id,
					params,
					this.capabilityOptions,
					this.eventBus,
					// Reuse the ajv instance from TASK_0012's outputSchema
					// validation to avoid a duplicate dependency. The
					// validator is lazily instantiated on first use.
					this.makeSchemaValidator(),
				)
			case "sampling/createMessage":
				if (!this.driverRegistry) {
					return {
						error: {
							code: -32603, // internal error
							message: "sampling/createMessage: no driver registry was supplied to this McpClient.",
						},
					}
				}
				return handleSampling(
					id,
					params,
					this.capabilityOptions,
					this.approvalOptions,
					this.driverRegistry,
					this.config.name,
				)
			case "roots/list":
				return handleRootsList(id, this.capabilityOptions)
			default:
				return { error: capabilityNotOptedInError(id, method).error }
		}
	}

	/**
	 * TASK_0014: notify the server that the host's roots have changed, by
	 * sending a `notifications/roots/list_changed` notification (spec:
	 * /client/roots). No-op if `roots` was not opted into (the client never
	 * declared the capability, so the server would not have been listening
	 * for this notification).
	 */
	async notifyRootsChanged(): Promise<void> {
		if (!this.capabilityOptions?.roots) return
		const { method, params } = rootsListChangedNotification()
		await this.sendNotification(method, params)
	}

	/**
	 * Build a JSON Schema validator closure reusing TASK_0012's lazily-
	 * instantiated ajv instance, for {@link handleElicitation}'s
	 * `requestedSchema` validation. Returns `undefined` (skip validation)
	 * if ajv compilation fails for the given schema.
	 */
	private makeSchemaValidator(): (schema: unknown, data: unknown) => boolean | undefined {
		return (schema, data) => {
			if (this.ajvInstance === undefined) {
				this.ajvInstance = new Ajv({ allErrors: false })
			}
			try {
				const validate = this.ajvInstance.compile(schema as JSONSchema)
				return validate(data) as boolean
			} catch {
				return undefined
			}
		}
	}

	/** Whether the server declared `tools.listChanged` (TASK_0012 consumes this). */
	get supportsListChanged(): boolean {
		return this.serverCapabilities?.tools?.listChanged === true
	}

	/**
	 * Run the `initialize` → `notifications/initialized` handshake, then
	 * (unless `deferred`) perform `tools/list` discovery and register every
	 * remote tool into the shared {@link ToolRegistry}. Throws
	 * {@link McpHandshakeError} on any handshake failure (non-2xx HTTP,
	 * JSON-RPC error, malformed body) — does not retry silently, does not
	 * hang, does not proceed to discovery.
	 */
	async connect(): Promise<void> {
		await this.handshake()
		if (this.config.deferred) {
			// TASK_0016: deferred tool loading. Fetch the full `tools/list`
			// result (paginated) but cache it instead of registering every
			// tool eagerly. Register only the two synthetic
			// `list_tools`/`search_tools` tools; the real tools are
			// registered live when the model calls a synthetic tool.
			await this.discoverDeferred()
		} else {
			await this.discoverTools()
		}
	}

	/**
	 * TASK_0016: fetch the full `tools/list` result, cache it, and register
	 * only the two synthetic deferred tools. Called from `connect()` when
	 * `deferred: true` is set, INSTEAD of `discoverTools()`.
	 */
	private async discoverDeferred(): Promise<void> {
		const all = await this.fetchAllTools()
		this.cachedDeferredTools = all as unknown as DeferredMcpTool[]
		// Build the deferred context. `registerTool` here is the public
		// `ToolRegistry.addTool` (the synthetic tools have no execute
		// binding that proxies to `tools/call` — they answer from the
		// cache). The real tools' execute bindings are wired when
		// `eagerRegisterAndAnswer` calls `ctx.registerTool`, which delegates
		// to this client's private `registerTool` method (captured in the
		// closure below).
		const ctx: DeferredContext = {
			serverName: this.config.name,
			registerTool: (def) => {
				// Delegate to the private registerTool method, which builds
				// the full execute binding (with approval gate, timeout,
				// cancellation, etc.). We look up the cached McpTool by
				// original name to pass through outputSchema and other
				// passthrough fields.
				const originalName = def.name.startsWith(`mcp__${this.config.name}__`)
					? def.name.slice(`mcp__${this.config.name}__`.length)
					: def.name
				const mcpTool = all.find((t) => t.name === originalName)
				if (mcpTool) {
					this.registerTool(mcpTool)
				} else {
					// Fallback: register the def as-is (should not happen for
					// cached tools, but defensive).
					this.toolRegistry.addTool(def)
				}
			},
		}
		registerDeferredTools(ctx, async (tool, params) => {
			// The onInvoke callback: eagerly register the cached tools (if
			// not already done) and answer the synthetic call.
			if (!this.deferredEagerRegistered) {
				// Mark eagerly registered BEFORE the registration loop to
				// avoid re-entrancy if a synthetic tool's execute somehow
				// triggers another synthetic call (defensive).
				this.deferredEagerRegistered = true
			}
			const cached = this.cachedDeferredTools ?? []
			return eagerRegisterAndAnswer(cached, ctx, tool, params)
		})
	}

	/**
	 * Send the `initialize` request, capture negotiated state, then send the
	 * `notifications/initialized` notification. See class-level spec citations.
	 */
	private async handshake(): Promise<void> {
		// TASK_0014: build the `capabilities` object conditionally from the
		// opt-in `McpClientCapabilityOptions`. When no opt-ins are supplied,
		// this collapses to the empty `{}` (matching TASK_0011's default),
		// so existing tests/clients that don't opt into any capability see
		// no behavioral change. A capability key is included IFF its opt-in
		// is present — entirely absent otherwise, per MCP semantics where
		// key PRESENCE signals feature support.
		const capabilities =
			this.capabilityOptions === undefined
				? DEFAULT_CLIENT_CAPABILITIES
				: buildClientCapabilities(this.capabilityOptions)
		const params: InitializeParams = {
			protocolVersion: REQUESTED_PROTOCOL_VERSION,
			capabilities,
			clientInfo: DEFAULT_CLIENT_INFO,
		}
		const response = await this.sendRequest<InitializeResult>("initialize", params)
		this.protocolVersion = response.result.protocolVersion
		this.serverCapabilities = response.result.capabilities
		// `Mcp-Session-Id` is an HTTP header (not a JSON field) per the
		// streamable-HTTP transport spec. A stateless server may omit it
		// entirely — that is a valid state, not an error.
		// (Spec: /basic/transports#session-management.)
		const sessionHeader = response.httpResponse.headers.get("Mcp-Session-Id")
		this.sessionId = sessionHeader ?? null
		// Complete the handshake with the initialized notification (no id, no
		// response expected). Spec: /basic/lifecycle.
		await this.sendNotification("notifications/initialized")
	}

	/**
	 * Paginated `tools/list` discovery. Loops following `nextCursor` until a
	 * response arrives with no `nextCursor` (or an empty one — both are
	 * treated as "no next page"; the spec does not distinguish, and an empty
	 * string is not a meaningful cursor). Aggregates ALL pages fully before
	 * registering anything, so a mid-pagination failure yields partial results
	 * plus a thrown error rather than a silently-incomplete registry.
	 * (Tradeoff: slightly more latency before any tool becomes available. A
	 * future task could switch to incremental registration if that latency
	 * becomes a problem in practice.)
	 */
	private async discoverTools(): Promise<void> {
		const all = await this.fetchAllTools()
		this.cachedToolNames = new Set()
		for (const tool of all) {
			this.registerTool(tool)
		}
	}

	/**
	 * Fetch every page of `tools/list` and return the aggregated `McpTool[]`.
	 * Shared between initial discovery and live re-sync so both paths use
	 * identical pagination logic.
	 */
	private async fetchAllTools(): Promise<McpTool[]> {
		const all: McpTool[] = []
		let cursor: string | undefined
		do {
			const params = cursor !== undefined ? { cursor } : undefined
			const response = await this.sendRequest<ToolsListResult>("tools/list", params)
			const result = response.result
			for (const tool of result.tools) {
				all.push(tool)
			}
			cursor = result.nextCursor && result.nextCursor.length > 0 ? result.nextCursor : undefined
		} while (cursor !== undefined)
		return all
	}

	/**
	 * Manual re-sync entry point (TASK_0012 fallback for the live-push gap).
	 *
	 * KNOWN GAP (live push notifications): receiving an unsolicited
	 * server-to-client `notifications/tools/list_changed` requires an open SSE
	 * stream from the `initialize` response or a subsequent long-lived GET/SSE
	 * connection (spec: /basic/transports). Since full SSE-stream listening is
	 * not implemented (see the file-level KNOWN GAP), this client does NOT
	 * automatically receive push notifications. As a documented fallback, this
	 * method exposes a manual re-sync a host can call on a timer or on demand.
	 * A future SSE-listening task should wire `notifications/tools/list_changed`
	 * to call {@link handleListChanged} automatically.
	 *
	 * Only re-syncs if the server declared `tools.listChanged` (per § 9.3 item
	 * 3). If the server did not declare that capability, this is a no-op
	 * (returns an empty diff) — the spec says the client MUST NOT attempt to
	 * handle a `list_changed` notification if the capability was not declared,
	 * and the same reasoning applies to a manual poll.
	 */
	async pollToolsList(): Promise<ToolListDiff> {
		if (!this.supportsListChanged) {
			return { added: [], removed: [], updated: [] }
		}
		return this.handleListChanged()
	}

	/**
	 * Re-run `tools/list`, diff the new set against the previously-cached name
	 * set, and register/unregister the delta through the shared
	 * {@link ToolRegistry} (which fires `tool.registered`/`tool.removed` per
	 * TASK_0008's contract). Exposed `public` so a future SSE-listening task
	 * (or a test) can drive a resync directly when a
	 * `notifications/tools/list_changed` signal is received.
	 *
	 * DIFF POLICY (explicit assumption — the spec does not say whether
	 * unchanged-by-name tools should be diffed field-by-field or blanket-
	 * replaced): blanket-replace. Names present in both the old and new sets
	 * are re-registered (replace) rather than skipped, so any changed
	 * `description`/`inputSchema`/`annotations` on an existing tool are picked
	 * up. This is simpler than field-by-field diffing and consistent with
	 * TASK_0008's "later registration shadows earlier" rule, so no separate
	 * diff-by-content logic is needed. Re-registering fires `tool.registered`
	 * (not `tool.removed`) per TASK_0008's shadowing semantics.
	 *
	 * GUARD: if the server did not declare `tools.listChanged`, this method
	 * logs/ignores the signal and returns an empty diff rather than
	 * re-fetching — per § 9.3 item 3, the client MUST NOT attempt to handle a
	 * `list_changed` notification if the capability was not declared.
	 */
	async handleListChanged(): Promise<ToolListDiff> {
		if (!this.supportsListChanged) {
			// The server never declared listChanged — ignore the signal per
			// § 9.3 item 3. Do not crash; do not re-fetch.
			return { added: [], removed: [], updated: [] }
		}
		const fresh = await this.fetchAllTools()
		const freshByName = new Map<string, McpTool>()
		for (const tool of fresh) {
			freshByName.set(tool.name, tool)
		}
		const freshNamespaced = new Set<string>()
		for (const tool of fresh) {
			freshNamespaced.add(`mcp__${this.config.name}__${tool.name}`)
		}
		const oldNames = this.cachedToolNames
		const added: string[] = []
		const removed: string[] = []
		const updated: string[] = []
		// Names in the new set but not the old → register (fires
		// tool.registered per TASK_0008).
		for (const [originalName, tool] of freshByName) {
			const namespaced = `mcp__${this.config.name}__${originalName}`
			if (!oldNames.has(namespaced)) {
				added.push(namespaced)
			} else {
				updated.push(namespaced)
			}
			// (Re-)register: blanket-replace per the diff policy above.
			this.registerTool(tool)
		}
		// Names in the old set but not the new → remove (fires tool.removed
		// per TASK_0008).
		for (const oldName of oldNames) {
			if (!freshNamespaced.has(oldName)) {
				removed.push(oldName)
				this.toolRegistry.removeTool(oldName)
			}
		}
		this.cachedToolNames = freshNamespaced
		return { added, removed, updated }
	}

	/**
	 * Terminate the MCP session and reset this client to its pre-handshake
	 * state. Satisfies the kernel's optional `McpClientLike.close?()`, which
	 * `bh.dispose()` calls on every attached handle, and backs the manager's
	 * detach path.
	 *
	 * Steps, in order:
	 *  1. Abort every in-flight `tools/call` by tripping its internal
	 *     `AbortController`, which terminates the underlying `fetch`. No
	 *     `notifications/cancelled` is sent per call: that notification is
	 *     wired to the *invocation's* signal (see {@link executeToolCall}),
	 *     and on close the session DELETE below tells the server to drop
	 *     everything anyway — one message instead of N.
	 *  2. If a session id was captured, send `DELETE` to the endpoint with the
	 *     `Mcp-Session-Id` header — the spec's explicit client-side session
	 *     termination (spec: /basic/transports, "Session Management").
	 *  3. Clear the negotiated protocol version, session id, server
	 *     capabilities, and the discovery caches.
	 *
	 * NEVER THROWS. A server is explicitly allowed to answer the DELETE with
	 * `405 Method Not Allowed` (it does not permit client-initiated
	 * termination), and a close that races a dropped connection should not
	 * turn into an unhandled rejection during teardown. Both cases are
	 * swallowed; local state is reset regardless.
	 *
	 * TRANSPORT-ONLY: this does NOT unregister the tools discovery put into
	 * the shared {@link ToolRegistry}. Tool cleanup belongs to whoever owns
	 * the registry — {@link McpManager.remove} does it on detach, and
	 * `bh.dispose()` tears the whole registry down anyway. Unregistering here
	 * would make `close()` silently destructive for the dispose path.
	 */
	async close(): Promise<void> {
		// 1. Abort in-flight calls. Iterate a copy: aborting settles the call,
		// whose `finally` deletes its entry from the live map.
		for (const controller of Array.from(this.inflightCalls.values())) {
			try {
				controller.abort()
			} catch {
				// An already-aborted controller is not an error worth surfacing.
			}
		}
		this.inflightCalls.clear()

		// 2. Best-effort session termination. Only meaningful when the server
		// issued a session id — a stateless server has nothing to delete.
		if (this.sessionId !== null) {
			try {
				await this.deleteSession()
			} catch {
				// 405 (termination not allowed), a network failure, or a
				// mid-teardown abort. Local state is reset either way.
			}
		}

		// 3. Reset to pre-handshake state so a later `connect()` on the same
		// instance starts clean rather than echoing a dead session id.
		this.protocolVersion = null
		this.sessionId = null
		this.serverCapabilities = null
		this.cachedToolNames = new Set()
		this.cachedDeferredTools = undefined
		this.deferredEagerRegistered = false
	}

	/**
	 * Send the `DELETE` that terminates the session, mirroring {@link post}'s
	 * header contract (protocol version + session id + host-supplied extras)
	 * minus the JSON body, which a DELETE does not carry. Split out of
	 * {@link close} so the "never throws" policy lives in exactly one place.
	 */
	private async deleteSession(): Promise<void> {
		const headers = new Headers()
		if (this.protocolVersion !== null) {
			headers.set("MCP-Protocol-Version", this.protocolVersion)
		}
		if (this.sessionId !== null) {
			headers.set("Mcp-Session-Id", this.sessionId)
		}
		if (this.config.headers) {
			for (const [k, v] of Object.entries(this.config.headers)) {
				headers.set(k, v)
			}
		}
		await fetch(this.config.url, { method: "DELETE", headers })
	}

	/**
	 * Construct a {@link BHZAIToolDefinition} from an MCP `Tool` and register it
	 * via the shared {@link ToolRegistry}. The namespaced name is
	 * `mcp__<serverName>__<toolName>` (double underscores, three segments —
	 * § 9.3 item 2). `title`, `icons`, `annotations`, `inputSchema`,
	 * `outputSchema`, `description` are passed through byte-for-byte from the
	 * server's `tools/list` response. `tags` is left `undefined` (bhzai-local
	 * field with no MCP-server equivalent; TASK_0017's availability filtering
	 * is the eventual consumer, but assigning tags to remote MCP tools is not
	 * this task's job and is not specified anywhere as automatic).
	 *
	 * The `execute` binding (TASK_0012) is a real `tools/call` proxy that:
	 *  - sends `tools/call` with `params: { name: <original unprefixed MCP
	 *    tool name>, arguments: invocation.params }` — the namespaced
	 *    `mcp__<server>__<tool>` name is a bhzai-local registry key only; the
	 *    wire request uses the tool's original name, captured explicitly here
	 *    to avoid fragile string-parsing of the prefix;
	 *  - returns the `CallToolResult` verbatim on success;
	 *  - validates `structuredContent` against `outputSchema` when one is
	 *    declared, converting a mismatch to `{ ...result, isError: true }`
	 *    rather than throwing;
	 *  - enforces a per-call timeout (default 60s, configurable);
	 *  - exposes a progress seam: `invocation.progress(update)` is called
	 *    whenever an `onProgress` callback fires (the seam TASK_0026's agent
	 *    loop will eventually wire into the real `tool(processing)` event
	 *    dispatch — explicitly NOT implemented here);
	 *  - listens to `invocation.signal` and, on abort, sends a
	 *    `notifications/cancelled` notification for the in-flight request id
	 *    and aborts the underlying `fetch`.
	 */
	private registerTool(tool: McpTool): void {
		const namespacedName = `mcp__${this.config.name}__${tool.name}`
		// Capture the original (unprefixed) MCP tool name and the outputSchema
		// in the closure so the execute binding can use them without
		// re-deriving the prefix or re-reading the registry.
		const originalName = tool.name
		const outputSchema = tool.outputSchema
		const def: BHZAIToolDefinition = {
			name: namespacedName,
			title: tool.title,
			description: tool.description,
			inputSchema: tool.inputSchema,
			outputSchema,
			icons: tool.icons as BHZAIToolDefinition["icons"],
			annotations: tool.annotations as BHZAIToolDefinition["annotations"],
			execute: async (invocation: ToolInvocation<unknown>): Promise<CallToolResult> => {
				return this.callTool(namespacedName, originalName, outputSchema, invocation)
			},
		}
		this.toolRegistry.addTool(def)
		this.cachedToolNames.add(namespacedName)
	}

	/**
	 * Real `tools/call` proxy (TASK_0012). See {@link registerTool}'s doc for
	 * the full behavior contract. This method is `private` and invoked only
	 * through the `execute` closure captured at registration time.
	 *
	 * PROGRESS SEAM (§ 9.1 line 617: "tool `processing` events ≙ MCP progress
	 * notifications"): this method calls `invocation.progress(update)` whenever
	 * an internal `onProgress` callback fires. The real `tool(processing)`
	 * framework/conversation event dispatch is TASK_0026's job — this method
	 * only exposes the seam/callback that TASK_0026 will eventually subscribe
	 * to. Do NOT implement the event dispatch here.
	 */
	private async callTool(
		namespacedName: string,
		originalName: string,
		outputSchema: JSONSchema | undefined,
		invocation: ToolInvocation<unknown>,
	): Promise<CallToolResult> {
		// TASK_0013: run the entire transport-layer call through the approval
		// gate. `guardCall` implements the refusal policy (§ 9.3 item 6):
		//  - `autoApproveTools: true` → short-circuit, no gate call at all;
		//  - no gate supplied → refuse with a clear, descriptive error
		//    (transport layer never reached);
		//  - gate supplied → delegate; on `{ approved: false }` refuse with
		//    the gate's `reason` (transport layer never reached).
		// The closure below is the real `tools/call` transport invocation,
		// only run once the call is approved. Refusal throws
		// `McpApprovalError` before any `fetch` is attempted.
		const approvalCall: ApprovalCall = {
			toolName: namespacedName,
			serverName: this.config.name,
			params: invocation.params,
		}
		return guardCall(approvalCall, this.approvalOptions, () =>
			this.executeToolCall(namespacedName, originalName, outputSchema, invocation),
		)
	}

	/**
	 * The real `tools/call` transport invocation (TASK_0012), run only after
	 * TASK_0013's approval gate has approved the call. Extracted from
	 * {@link callTool} so the approval wrapper can short-circuit refusal
	 * without ever entering this method's timeout/abort/cancel machinery.
	 */
	private async executeToolCall(
		namespacedName: string,
		originalName: string,
		outputSchema: JSONSchema | undefined,
		invocation: ToolInvocation<unknown>,
	): Promise<CallToolResult> {
		const requestId = nextRequestId()
		// One internal AbortController ties together timeout enforcement and
		// invocation-signal abort, so the underlying `fetch` is actually
		// terminated (not just abandoned client-side) in either case.
		const internalController = new AbortController()
		this.inflightCalls.set(requestId, internalController)

		// Wire the invocation's AbortSignal → internal controller + cancelled
		// notification. Per MCP cancellation convention (spec:
		// /basic/utilities/cancellation), the notification `params` shape is
		// `{ requestId, reason? }` — confirmed via external spec reading.
		const onAbort = () => {
			const reason = invocation.signal.reason
			void this.sendNotification("notifications/cancelled", {
				requestId,
				reason: typeof reason === "string" ? reason : "client aborted",
			}).catch(() => {
				// Swallow: cancellation is best-effort; a failing notification
				// must not mask the original abort.
			})
			internalController.abort()
		}
		if (invocation.signal.aborted) {
			onAbort()
		} else {
			invocation.signal.addEventListener("abort", onAbort, { once: true })
		}

		// Progress seam: a server MAY emit `notifications/progress` on the
		// response stream carrying the request's `progressToken`. Since this
		// client does not fully parse SSE streams (see the KNOWN GAP above),
		// progress notifications arriving on a separate stream are not
		// automatically wired. The `onProgress` callback below is the seam a
		// future SSE-listening task (or a test) can call to forward a progress
		// update to `invocation.progress(update)`. TASK_0026 will be the actual
		// subscriber wiring this into a real `tool(processing)` event dispatch.
		const onProgress = (update: string | ContentBlock[]): void => {
			invocation.progress(update)
		}

		// Timeout + call race. The timeout rejects with McpTimeoutError and
		// aborts the internal controller so the underlying fetch terminates.
		let timeoutId: ReturnType<typeof setTimeout> | undefined
		const timeoutPromise = new Promise<never>((_, reject) => {
			timeoutId = setTimeout(() => {
				internalController.abort()
				reject(new McpTimeoutError(namespacedName, this.callTimeoutMs))
			}, this.callTimeoutMs)
		})

		try {
			const params = {
				name: originalName, // wire name = original unprefixed MCP name
				arguments: invocation.params,
				// Include a progressToken so a server that supports progress
				// notifications can correlate them to this request (spec:
				// /basic/utilities/progress). The token is the request id —
				// unique across active requests per the spec's requirement.
				_meta: { progressToken: requestId },
			}
			const callPromise = this.sendRequestWithId<CallToolResult>(
				requestId,
				"tools/call",
				params,
				internalController.signal,
				onProgress,
			)
			const response = await Promise.race([callPromise, timeoutPromise])
			const result = response.result
			// outputSchema validation (§ 9.3 item 4 — spec "SHOULD", enforced
			// as mandatory-for-this-task). On mismatch, do NOT throw — return
			// `{ ...result, isError: true }` with a diagnostic text block
			// appended to `content` explaining the failure (this last detail
			// is this task's own embellishment beyond the literal spec text).
			if (outputSchema && result.structuredContent !== undefined) {
				const validateOutput = this.compileOutputSchema(outputSchema)
				if (validateOutput && !validateOutput(result.structuredContent)) {
					const diag: ContentBlock = {
						type: "text",
						text: `[MCP outputSchema validation failed for '${namespacedName}': ${this.formatAjvErrors(validateOutput.errors)}]`,
					}
					return {
						...result,
						isError: true,
						// Keep `structuredContent` as-is alongside `isError: true`
						// so the host can still inspect what was returned.
						content: [...(result.content ?? []), diag],
					}
				}
			}
			return result
		} finally {
			if (timeoutId !== undefined) clearTimeout(timeoutId)
			invocation.signal.removeEventListener("abort", onAbort)
			this.inflightCalls.delete(requestId)
		}
	}

	/**
	 * Compile (and cache) an `ajv` validator for an `outputSchema`. Returns
	 * `undefined` if compilation failed (e.g. malformed schema) — in that case
	 * validation is skipped rather than crashing the call, since a bad schema
	 * is the server's bug, not the caller's. `ajv` is reused (not reinstantiated
	 * per call) for performance; it is the same pure-JS validator the kernel
	 * uses for TASK_0006's config step, so no new dependency is introduced.
	 */
	private compileOutputSchema(schema: JSONSchema): ValidateFunction | undefined {
		// Lazily instantiate one ajv instance per client. `Ajv` is imported at
		// module top; constructing it is cheap and cached on the instance.
		if (this.ajvInstance === undefined) {
			this.ajvInstance = new Ajv({ allErrors: false })
		}
		try {
			// `getSchema`/`compile` caching: ajv caches compiled validators by
			// schema key internally when a `$id` is present; for schemas
			// without `$id` we compile each time (acceptable for the call
			// frequency; a future optimization may key by namespaced tool name).
			return this.ajvInstance.compile(schema)
		} catch {
			return undefined
		}
	}

	/** Format ajv errors into a short diagnostic string for the `content` block. */
	private formatAjvErrors(errors: unknown): string {
		if (!Array.isArray(errors) || errors.length === 0) return "validation failed"
		return (errors as { instancePath?: string; message?: string }[])
			.map((e) => `${e.instancePath ?? "/"}: ${e.message ?? "invalid"}`)
			.join("; ")
	}

	// -------------------------------------------------------------------------
	// Transport layer (JSON-RPC over streamable-HTTP POST).
	// -------------------------------------------------------------------------

	/**
	 * Send a JSON-RPC request and await the response. Throws
	 * {@link McpHandshakeError} on non-2xx HTTP status, JSON-RPC error object,
	 * or malformed/unparseable body. Returns both the parsed JSON-RPC response
	 * and the underlying `Response` (so the handshake can read the
	 * `Mcp-Session-Id` header off it).
	 */
	private async sendRequest<T = unknown>(
		method: string,
		params?: unknown,
	): Promise<{ result: T; httpResponse: Response }> {
		const body: JsonRpcRequest = {
			jsonrpc: "2.0",
			id: nextRequestId(),
			method,
			params,
		}
		const httpResponse = await this.post(body)
		const parsed = await this.parseResponseBody(httpResponse)
		if (parsed.error) {
			throw new McpHandshakeError(
				`MCP request '${method}' failed: ${parsed.error.code} ${parsed.error.message}`,
			)
		}
		if (parsed.result === undefined) {
			throw new McpHandshakeError(
				`MCP request '${method}' response had no 'result' field and no 'error'`,
			)
		}
		return { result: parsed.result as T, httpResponse }
	}

	/**
	 * Send a JSON-RPC request with a caller-supplied id (used by
	 * {@link callTool} so the id is known in advance for cancellation
	 * correlation). Accepts an `AbortSignal` forwarded to `fetch` so the
	 * underlying HTTP request terminates on timeout/abort, and an optional
	 * `onProgress` callback seam (TASK_0012). Throws {@link McpCallError} on
	 * JSON-RPC error or non-2xx HTTP status (distinct from
	 * {@link McpHandshakeError} so callers can distinguish call failures from
	 * handshake failures). Throws `McpTimeoutError` indirectly via the
	 * `Promise.race` in {@link callTool} when the timeout fires first.
	 */
	private async sendRequestWithId<T = unknown>(
		id: string | number,
		method: string,
		params: unknown,
		signal: AbortSignal,
		_onProgress?: (update: string | ContentBlock[]) => void,
	): Promise<{ result: T; httpResponse: Response }> {
		const body: JsonRpcRequest = { jsonrpc: "2.0", id, method, params }
		const httpResponse = await this.post(body, signal)
		const parsed = await this.parseResponseBody(httpResponse)
		if (parsed.error) {
			throw new McpCallError(`MCP tools/call failed: ${parsed.error.code} ${parsed.error.message}`)
		}
		if (parsed.result === undefined) {
			throw new McpCallError("MCP tools/call response had no 'result' field and no 'error'")
		}
		return { result: parsed.result as T, httpResponse }
	}

	/**
	 * Send a JSON-RPC notification (no `id`, no response expected). The server
	 * returns 202 Accepted with no body for a accepted notification (spec:
	 * /basic/transports). This method does not inspect the response body.
	 */
	private async sendNotification(method: string, params?: unknown): Promise<void> {
		const body: JsonRpcNotification = { jsonrpc: "2.0", method, params }
		await this.post(body)
	}

	/**
	 * POST a JSON-RPC message to the server's `url` with the required headers.
	 * Per the streamable-HTTP transport spec (/basic/transports):
	 *  - `Content-Type: application/json`;
	 *  - `Accept: application/json, text/event-stream` (the server MAY respond
	 *    with either);
	 *  - after the handshake, `MCP-Protocol-Version: <negotiated version>` on
	 *    every request;
	 *  - if a session id was captured, `Mcp-Session-Id: <id>` echoed back.
	 * Extra `headers` from the {@link McpServerConfig} are merged in last so
	 * they can override the defaults if a host needs to.
	 */
	private async post(
		body: JsonRpcRequest | JsonRpcNotification,
		signal?: AbortSignal,
	): Promise<Response> {
		const headers = new Headers({
			"Content-Type": "application/json",
			Accept: "application/json, text/event-stream",
		})
		if (this.protocolVersion !== null) {
			headers.set("MCP-Protocol-Version", this.protocolVersion)
		}
		if (this.sessionId !== null) {
			headers.set("Mcp-Session-Id", this.sessionId)
		}
		if (this.config.headers) {
			for (const [k, v] of Object.entries(this.config.headers)) {
				headers.set(k, v)
			}
		}
		const response = await fetch(this.config.url, {
			method: "POST",
			headers,
			body: JSON.stringify(body),
			signal,
		})
		if (!response.ok) {
			// Distinguish call-context failures (tools/call) from handshake-
			// context failures so callers can branch on error type.
			if (body.method === "tools/call") {
				throw new McpCallError(
					`MCP HTTP ${response.status} ${response.statusText} for '${body.method}'`,
				)
			}
			throw new McpHandshakeError(
				`MCP HTTP ${response.status} ${response.statusText} for '${body.method}'`,
			)
		}
		return response
	}

	/**
	 * Parse the HTTP response body as a JSON-RPC response.
	 *
	 * KNOWN GAP (SSE-streamed responses): the streamable-HTTP transport
	 * permits the server to respond with `Content-Type: text/event-stream`
	 * instead of `application/json`, delivering the JSON-RPC response as an
	 * SSE `data:` frame (possibly after interleaved server-to-client
	 * notifications). THIS TASK implements only the plain-JSON case: it reads
	 * the response body as text and `JSON.parse`s it as a single JSON-RPC
	 * object. If the server responded with an SSE stream, this parse will
	 * fail and throw an {@link McpHandshakeError} with a clear message. A
	 * future task should implement a robust SSE reader (parsing `event:` /
	 * `data:` frames, reassembling the JSON-RPC response, handling
	 * interleaved notifications); until then, servers that only ever respond
	 * with SSE streams (rare for request/response methods like `initialize`
	 * and `tools/list`) will not be supported. This is documented explicitly
	 * rather than silently half-supported.
	 */
	private async parseResponseBody(response: Response): Promise<JsonRpcResponse> {
		const contentType = response.headers.get("Content-Type") ?? ""
		if (contentType.includes("text/event-stream")) {
			// SSE-streamed response — see the KNOWN GAP above. Read the body
			// for a best-effort error message but do not attempt to parse it
			// as a single JSON object.
			const text = await response.text().catch(() => "<unreadable>")
			throw new McpHandshakeError(
				`MCP response was an SSE stream (Content-Type: text/event-stream), which this client does not yet parse. Body preview: ${text.slice(0, 200)}`,
			)
		}
		const text = await response.text()
		let parsed: unknown
		try {
			parsed = JSON.parse(text)
		} catch (err) {
			throw new McpHandshakeError(`MCP response body was not valid JSON: ${(err as Error).message}`)
		}
		if (
			typeof parsed !== "object" ||
			parsed === null ||
			(parsed as { jsonrpc?: unknown }).jsonrpc !== "2.0"
		) {
			throw new McpHandshakeError("MCP response body was not a JSON-RPC 2.0 object")
		}
		return parsed as JsonRpcResponse
	}
}
