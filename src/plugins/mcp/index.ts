// MCP streamable-HTTP client plugin subpath entry (ARCHITECTURE.md § 9.3).
//
// This subpath exposes the built-in MCP client building blocks. The public
// `bh.addMcp()` kernel entry point (TASK_0015) wraps the {@link McpClient}
// exported here; hosts importing this subpath directly typically do so to
// construct a client manually for advanced cases (e.g. custom discovery
// hooks) before passing it to `bh.addMcp()` or wiring it themselves.
//
// ENVIRONMENT BOUNDARY (§ 5): web-standard APIs only — `fetch`,
// `AbortController`, `crypto.randomUUID`, `Headers`. No Node built-ins, no
// SSE/stdio library. `ajv` is a pure-JS validator with no environment
// bindings (already a runtime dependency for TASK_0006's config step).
export {
	McpClient,
	McpCallError,
	McpHandshakeError,
	McpTimeoutError,
	type McpClientOptions,
	type ToolListDiff,
} from "./client.js"
// TASK_0013: approval-gate seam + untrusted-by-default flag. Reused verbatim
// by TASK_0014's sampling routing — do NOT invent a parallel approval type.
export {
	McpApprovalError,
	type ApprovalCall,
	type ApprovalGate,
	type ApprovalResult,
	type McpApprovalOptions,
	guardCall,
	resolveAutoApprove,
} from "./approval.js"
// TASK_0014: opt-in client capabilities — elicitation, sampling, roots.
export {
	type CapabilityEventBus,
	type ElicitRequest,
	type ElicitResponse,
	type InboundRequestResult,
	type JsonRpcError,
	type JsonRpcErrorResponse,
	type McpClientCapabilityOptions,
	type Root,
	type SamplingDriverRegistry,
	type SamplingRequest,
	type SamplingResponse,
	buildClientCapabilities,
	capabilityNotOptedInError,
	handleElicitation,
	handleRootsList,
	handleSampling,
	jsonRpcError,
	rootsListChangedNotification,
} from "./capabilities.js"
// TASK_0016: deferred tool loading via search_tools synthetic tools.
export {
	type DeferredContext,
	type DeferredMcpTool,
	type DeferredToolListResult,
	eagerRegisterAndAnswer,
	registerDeferredTools,
} from "./deferred.js"
export type {
	McpPluginOptions,
	McpServerConfig,
	McpServerError,
	McpServerState,
	McpServerStatus,
	McpServerTool,
	McpService,
} from "./types.js"

export { McpServiceImpl } from "./service.js"
export { mcpPlugin } from "./plugin.js"
