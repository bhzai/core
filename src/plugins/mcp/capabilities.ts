// MCP client capabilities — elicitation, sampling, roots (ARCHITECTURE.md
// § 9.3 "Client capabilities", spec rev 2025-11-25 /client).
//
// Scope of THIS file (TASK_0014):
//  - Define the opt-in configuration shape (`McpClientCapabilityOptions`)
//    that controls which client capabilities the `initialize` handshake
//    advertises. This shape is THIS TASK'S OWN INVENTION — the architecture
//    doc describes each capability's *behavior* but never gives the literal
//    opt-in API surface. The closest precedent in this task group is
//    TASK_0010 inventing `BHZAICommandContext` for the same reason
//    ("explicitly documenting an inferred design decision").
//  - Build the conditional `capabilities` object sent during `initialize`:
//    a key is included ONLY if the corresponding opt-in was supplied, and
//    is ENTIRELY ABSENT otherwise (not present with `false`/empty-object).
//    Per MCP semantics, key PRESENCE — not truthiness — signals feature
//    support to the server, so this is an explicit, testable acceptance
//    criterion, not a stylistic nicety.
//  - Implement inbound `elicitation/create` and `sampling/createMessage`
//    handling, plus outbound `notifications/roots/list_changed`.
//
// SPEC INCONSISTENCY (§ 8.1 table vs. § 9.3 prose): § 9.3's prose names
// `mcp.elicitation` as "a blockable... framework event" but the § 8.1
// framework-events table (as excerpted for this task group) does NOT
// include a row for it. This task treats `mcp.elicitation` as a genuinely
// blockable framework event dispatched through the same TASK_0004 event
// bus as every other framework event, consistent with § 9.3's explicit
// wording, and flags the missing table row as something TASK_0004's owner
// or a documentation-cleanup task should reconcile later. This task does
// NOT silently invent different semantics just because the summary table
// omits it.
//
// ENVIRONMENT BOUNDARY (§ 5): web-standard APIs only. This file touches
// nothing outside of plain TypeScript + the injected driver registry /
// approval gate / event bus — no `fetch` directly (it uses the
// `McpClient`'s transport methods), no Node built-ins.

import { parseModelRef } from "../../llm/models.js"
import type { BHZAIDriver, ChatRequest } from "../../types/index.js"
import type { ApprovalCall, McpApprovalOptions } from "./approval.js"

// ---------------------------------------------------------------------------
// Elicitation shapes (spec: /client/elicitation, rev 2025-11-25).
// ---------------------------------------------------------------------------

/**
 * The `elicitation/create` request params sent by the server (spec:
 * /client/elicitation). `message` is the prompt to display; `requestedSchema`
 * is a JSON Schema the response's `content` MUST conform to on `accept`.
 */
export interface ElicitRequest {
	/** The server's prompt to display to the human. */
	message: string
	/** JSON Schema the accepted response's `content` must conform to. */
	requestedSchema?: unknown
}

/**
 * The response the host's `onElicit` handler resolves with (spec:
 * /client/elicitation). The `action` is one of `accept`/`decline`/`cancel`;
 * `content` is required only on `accept` and must conform to
 * `ElicitRequest.requestedSchema`.
 */
export interface ElicitResponse {
	action: "accept" | "decline" | "cancel"
	content?: Record<string, unknown>
}

// ---------------------------------------------------------------------------
// Sampling shapes (spec: /client/sampling, rev 2025-11-25).
// ---------------------------------------------------------------------------

/**
 * The `sampling/createMessage` request params sent by the server (spec:
 * /client/sampling). This is a minimal projection of the spec shape —
 * `messages`, `modelPreferences?`, `systemPrompt?`, `maxTokens?` are the
 * fields the spec names; this task routes them into a `ChatRequest` for the
 * driver registry.
 */
export interface SamplingRequest {
	/** The conversation messages to sample from. */
	messages: unknown
	/** Optional system prompt override. */
	systemPrompt?: string
	/** Optional token cap. */
	maxTokens?: number
	/** Optional model selection hints (passed through opaquely). */
	modelPreferences?: unknown
	/** Optional stop sequences. */
	stopSequences?: string[]
	/** Optional temperature. */
	temperature?: number
}

/**
 * The response shape sent back to the server for a `sampling/createMessage`
 * request (spec: /client/sampling). `role` is always `'assistant'`; `content`
 * is a single content block (text or image); `model` is the model id that
 * produced the response.
 */
export interface SamplingResponse {
	role: "assistant"
	content: { type: "text"; text: string } | { type: "image"; data: string; mimeType: string }
	model: string
	/** Optional stop reason, mirroring `DriverEvent`'s `done.stopReason`. */
	stopReason?: string
}

// ---------------------------------------------------------------------------
// Roots shapes (spec: /client/roots, rev 2025-11-25).
// ---------------------------------------------------------------------------

/**
 * A single root URI the host advertises to the server (spec: /client/roots).
 * `uri` is an absolute URI; `name` is an optional human-readable label.
 */
export interface Root {
	uri: string
	name?: string
}

// ---------------------------------------------------------------------------
// Opt-in configuration shape (THIS TASK'S OWN DESIGN DECISION).
// ---------------------------------------------------------------------------

/**
 * Opt-in configuration for the three MCP client capabilities (TASK_0014,
 * § 9.3 "Client capabilities").
 *
 * DESIGN NOTE: this shape is THIS TASK'S OWN INVENTION, made necessary by
 * the architecture doc's silence on the literal opt-in surface (the doc
 * describes each capability's *behavior* but not the API a host uses to
 * turn a feature on). The closest precedent in this task group is
 * TASK_0010 inventing `BHZAICommandContext` for the same reason. The shape
 * is threaded into the `McpClient` at construction time (and through
 * `bh.addMcp()` by TASK_0015) — a capability key is included in the
 * `initialize` request's `capabilities` object IFF the corresponding
 * opt-in is present here.
 *
 * DESIGN DECISION (elicitation vs. framework event): § 9.3's wording
 * ("surface as a blockable... event that host UI answers") could be read
 * as either (a) `onElicit` IS the host-UI handler, or (b) the framework
 * `mcp.elicitation` event is the handler. This task treats `onElicit` as
 * the ACTUAL handler implementation, and ADDITIONALLY emits
 * `mcp.elicitation` through the framework bus purely as an
 * observability/logging hook for other plugins that want visibility. The
 * emit's own block/patch result does NOT override `onElicit`'s answer —
 * `onElicit` is authoritative. This is documented explicitly because the
 * architecture doc's wording is ambiguous.
 */
export interface McpClientCapabilityOptions {
	/**
	 * Opt into `elicitation`. When present, the `initialize` capabilities
	 * object includes the `elicitation` key, and inbound
	 * `elicitation/create` requests are dispatched to `onElicit`.
	 */
	elicitation?: {
		/**
		 * The host's elicitation handler. Treated as the AUTHORITATIVE
		 * answer source; the framework `mcp.elicitation` event is emitted
		 * alongside purely for observability and does NOT override this
		 * handler's result.
		 */
		onElicit: (request: ElicitRequest) => Promise<ElicitResponse>
	}
	/**
	 * Opt into `sampling`. When present, the `initialize` capabilities
	 * object includes the `sampling` key, and inbound
	 * `sampling/createMessage` requests are routed into the driver
	 * registry, subject to the TASK_0013 approval gate.
	 */
	sampling?: {
		/**
		 * Optional preferred driver id. If omitted, this task picks the
		 * first registered driver whose `capabilities(model)` doesn't
		 * reject the request outright (documented as a simple heuristic —
		 * full model/driver negotiation logic is out of scope).
		 */
		driver?: string
		/**
		 * Optional preferred model id (qualified `<driver>/<model>` or bare
		 * `<model>`). If omitted, the first model from the selected
		 * driver's `listModels()` is used.
		 */
		model?: string
	}
	/**
	 * Opt into `roots`. When present, the `initialize` capabilities object
	 * includes the `roots` key, the host's `getRoots()` is consulted to
	 * answer inbound `roots/list` requests, and
	 * `notifications/roots/list_changed` is sent when the host calls
	 * `client.notifyRootsChanged()`.
	 */
	roots?: {
		/** Returns the current set of roots the host advertises. */
		getRoots: () => Root[] | Promise<Root[]>
	}
}

/**
 * Build the `capabilities` object sent in the `initialize` request, based
 * on which opt-ins are present. A capability key is included IFF the
 * corresponding opt-in was supplied — entirely absent otherwise (NOT
 * present with `false`/empty-object), per MCP semantics where key
 * PRESENCE signals feature support.
 *
 * The exact capability values sent are documented per spec
 * /client/{elicitation,sampling,roots}: each is an empty object `{}` for
 * capabilities with no sub-fields (the spec models them as
 * capability-flags-by-key-presence), matching what compliant servers
 * expect.
 */
export function buildClientCapabilities(
	opts: McpClientCapabilityOptions | undefined,
): Record<string, unknown> {
	const caps: Record<string, unknown> = {}
	if (opts?.elicitation) {
		caps.elicitation = {}
	}
	if (opts?.sampling) {
		caps.sampling = {}
	}
	if (opts?.roots) {
		caps.roots = {}
	}
	return caps
}

// ---------------------------------------------------------------------------
// JSON-RPC error helper (spec: /basic/messages — error codes).
// ---------------------------------------------------------------------------

/** Standard JSON-RPC error codes (spec: /basic/messages). */
const JSON_RPC_ERROR_CODES = {
	PARSE_ERROR: -32700,
	INVALID_REQUEST: -32600,
	METHOD_NOT_FOUND: -32601,
	INVALID_PARAMS: -32602,
	INTERNAL_ERROR: -32603,
} as const

/**
 * A JSON-RPC error response object, sent back to the server when an
 * inbound server-to-client request cannot be honored (capability not
 * opted in, approval refused, handler threw, etc.).
 */
export interface JsonRpcErrorResponse {
	readonly jsonrpc: "2.0"
	readonly id: string | number
	readonly error: JsonRpcError
}

/** The `error` field of a JSON-RPC 2.0 error response. */
export interface JsonRpcError {
	readonly code: number
	readonly message: string
	readonly data?: unknown
}

/**
 * Build a JSON-RPC error response for an inbound server request.
 */
export function jsonRpcError(
	id: string | number,
	code: number,
	message: string,
	data?: unknown,
): JsonRpcErrorResponse {
	const error: { code: number; message: string; data?: unknown } = { code, message }
	if (data !== undefined) error.data = data
	return { jsonrpc: "2.0", id, error }
}

/** Convenience: build a "method not found / capability not opted in" error. */
export function capabilityNotOptedInError(
	id: string | number,
	method: string,
): JsonRpcErrorResponse {
	return jsonRpcError(
		id,
		JSON_RPC_ERROR_CODES.METHOD_NOT_FOUND,
		`MCP method '${method}' not supported: the client did not opt into the corresponding capability.`,
	)
}

// ---------------------------------------------------------------------------
// Capability handler dispatch.
// ---------------------------------------------------------------------------

/**
 * The result of handling an inbound server-to-client request: either a
 * `result` to send back in a JSON-RPC response, or an `error` to send back.
 */
export interface InboundRequestResult {
	result?: unknown
	error?: JsonRpcErrorResponse["error"]
}

/**
 * A minimal driver-registry interface this task needs to route sampling
 * requests. This is a narrow projection of TASK_0009's `DriverRegistry` —
 * just enough to select a driver and call its `chat()`. The real
 * `DriverRegistry` is passed in by `McpClient` (which receives it from
 * TASK_0015's `bh.addMcp()` wiring).
 */
export interface SamplingDriverRegistry {
	/** Look up a registered driver by id. */
	getDriver(id: string): BHZAIDriver | undefined
	/** All registered drivers, in registration order. */
	drivers(): BHZAIDriver[]
}

/**
 * A minimal event-bus interface this task needs to emit `mcp.elicitation`
 * as an observability hook. This is a narrow projection of TASK_0004's
 * `EventBus` — just enough to dispatch a framework event. The real
 * `EventBus` is passed in by `McpClient`.
 */
export interface CapabilityEventBus {
	/** Dispatch a framework event (kernel bypass; non-blockable here). */
	dispatch(event: string, payload: unknown): Promise<void>
}

/**
 * Handle an inbound `elicitation/create` server request (TASK_0014).
 *
 * Behavior:
 *  1. If `elicitation` was not opted into, return a `method not found`
 *     JSON-RPC error (the client never declared the capability, so a
 *     compliant server should not have sent the request — but we respond
 *     with a clear error rather than crashing or silently dropping).
 *  2. Otherwise, emit `mcp.elicitation` through the framework bus as an
 *     OBSERVABILITY hook (the emit's block/patch result does NOT override
 *     `onElicit`'s answer — `onElicit` is authoritative per the design
 *     decision documented on {@link McpClientCapabilityOptions}).
 *  3. Call `onElicit(request)` and resolve with the host's
 *     accept/decline/cancel response.
 *  4. On `accept`, validate `content` against `requestedSchema` if a
 *     validator is available; on validation failure, return an
 *     `invalid params` JSON-RPC error.
 *  5. If `onElicit` throws, return an `internal error` JSON-RPC error
 *     surfacing the failure (do not silently drop the server's request).
 *
 * @param id        The JSON-RPC request id (echoed in the response).
 * @param params    The `elicitation/create` params (validated loosely).
 * @param opts      The capability opt-ins (only `elicitation` is read).
 * @param bus       The framework event bus (for the `mcp.elicitation`
 *                  observability emit).
 * @param validate  Optional JSON Schema validator (reused from
 *                  TASK_0012's ajv instance to avoid a duplicate
 *                  dependency). Returns `true` on valid, `false` + errors
 *                  on invalid, or `undefined` if validation is skipped.
 */
export async function handleElicitation(
	id: string | number,
	params: unknown,
	opts: McpClientCapabilityOptions | undefined,
	bus: CapabilityEventBus | undefined,
	validate?: (schema: unknown, data: unknown) => boolean | undefined,
): Promise<InboundRequestResult> {
	const elicitation = opts?.elicitation
	if (!elicitation) {
		return { error: capabilityNotOptedInError(id, "elicitation/create").error }
	}
	const request = params as ElicitRequest
	// Emit the observability hook. Fire-and-forget — the result does NOT
	// override `onElicit`'s answer (documented design decision). Swallow
	// dispatch errors so a failing observer never breaks the elicitation.
	if (bus) {
		try {
			await bus.dispatch("mcp.elicitation", { request })
		} catch {
			// Observability-only — never block the actual handler.
		}
	}
	try {
		const response = await elicitation.onElicit(request)
		// On `accept`, validate `content` against `requestedSchema` if a
		// validator is available.
		if (
			response.action === "accept" &&
			response.content !== undefined &&
			request.requestedSchema !== undefined &&
			validate
		) {
			const valid = validate(request.requestedSchema, response.content)
			if (valid === false) {
				return {
					error: {
						code: JSON_RPC_ERROR_CODES.INVALID_PARAMS,
						message: "elicitation/create response content did not conform to requestedSchema.",
					},
				}
			}
		}
		return { result: response }
	} catch (err) {
		return {
			error: {
				code: JSON_RPC_ERROR_CODES.INTERNAL_ERROR,
				message: `elicitation handler threw: ${(err as Error).message}`,
			},
		}
	}
}

/**
 * Handle an inbound `sampling/createMessage` server request (TASK_0014).
 *
 * Behavior:
 *  1. If `sampling` was not opted into, return a `method not found`
 *     JSON-RPC error.
 *  2. Run the request through the TASK_0013 `ApprovalGate` (reused
 *     verbatim — sampling calls are gated by the exact same "subscribed
 *     approver OR `autoApproveTools`" policy as tool calls, per § 9.3's
 *     "subject to the same human-in-the-loop approval seam as tool calls"
 *     wording). On refusal, return a `permission denied`-style JSON-RPC
 *     error (do not silently drop the server's request).
 *  3. Select a driver: if `sampling.driver` names a specific id, use it;
 *     otherwise pick the first registered driver (documented as a simple
 *     heuristic — full model/driver negotiation is out of scope).
 *  4. Translate the request into a `ChatRequest` and call the driver's
 *     `chat()` async iterable to completion, concatenating `delta` events
 *     into a final text. (Sampling responses are NOT streamed back to the
 *     MCP server incrementally in this task's scope — the MCP
 *     `sampling/createMessage` response is a single JSON-RPC result, not a
 *     stream. Documented as a simplification.)
 *  5. Translate the result into the MCP-expected `SamplingResponse` shape.
 *
 * @param id        The JSON-RPC request id (echoed in the response).
 * @param params    The `sampling/createMessage` params.
 * @param opts      The capability opt-ins (only `sampling` is read).
 * @param approval  The TASK_0013 approval options (gate + autoApproveTools).
 * @param drivers   The driver registry to route the request into.
 * @param serverName The server name (for the approval-gate call payload).
 */

/**
 * Check the sampling approval gate (TASK_0013 refusal policy, inlined for
 * `handleSampling` because we need a JSON-RPC error — not a thrown
 * `McpApprovalError` — so the server gets a well-formed response).
 *
 * @returns A `JsonRpcError` if the request is refused, or `undefined` if
 *          approved (or auto-approved).
 */
async function checkSamplingApproval(
	approvalCall: ApprovalCall,
	approval: McpApprovalOptions | undefined,
): Promise<JsonRpcError | undefined> {
	if (approval?.autoApproveTools === true) return undefined
	const gate = approval?.approvalGate
	if (!gate) {
		return {
			code: JSON_RPC_ERROR_CODES.INVALID_PARAMS,
			message:
				"sampling/createMessage refused: a human-in-the-loop approver is required and none was configured.",
		}
	}
	const decision = await gate(approvalCall)
	if (!decision.approved) {
		const suffix = decision.reason ? `: ${decision.reason}` : ""
		return {
			code: JSON_RPC_ERROR_CODES.INVALID_PARAMS,
			message: `sampling/createMessage refused by the approval gate${suffix}.`,
		}
	}
	return undefined
}

/**
 * Select the driver and model for a sampling request. If `sampling.driver`
 * is set, use that driver; otherwise pick the first registered driver.
 * If `sampling.model` is set, use it; otherwise pick the first model from
 * the driver's catalogue.
 *
 * @returns Either `{ driver, model }` on success, or `{ error }` on failure.
 */
async function selectSamplingDriver(
	sampling: NonNullable<McpClientCapabilityOptions["sampling"]>,
	drivers: SamplingDriverRegistry,
): Promise<{ driver: BHZAIDriver; model: string } | { error: JsonRpcError }> {
	let driver: BHZAIDriver | undefined
	if (sampling.driver) {
		driver = drivers.getDriver(sampling.driver)
		if (!driver) {
			return {
				error: {
					code: JSON_RPC_ERROR_CODES.INVALID_PARAMS,
					message: `sampling/createMessage: preferred driver '${sampling.driver}' is not registered.`,
				},
			}
		}
	} else {
		const all = drivers.drivers()
		driver = all[0]
		if (!driver) {
			return {
				error: {
					code: JSON_RPC_ERROR_CODES.INTERNAL_ERROR,
					message: "sampling/createMessage: no drivers are registered.",
				},
			}
		}
	}
	let model: string | undefined = sampling.model
	if (!model) {
		try {
			const models = await driver.listModels()
			if (models.length === 0) {
				return {
					error: {
						code: JSON_RPC_ERROR_CODES.INTERNAL_ERROR,
						message: `sampling/createMessage: driver '${driver.id}' has no models.`,
					},
				}
			}
			model = models[0].ref
		} catch (err) {
			return {
				error: {
					code: JSON_RPC_ERROR_CODES.INTERNAL_ERROR,
					message: `sampling/createMessage: driver.listModels() threw: ${(err as Error).message}`,
				},
			}
		}
	}
	// `ChatRequest.model` is the BARE model id, not the qualified
	// `'<driver>/<model>'` ref — the driver knows its own id via `this.id` and
	// decides how to format the model name on the wire. If the resolved model
	// is a qualified ref (e.g. `models[0].ref` or a host-supplied ref), parse
	// out the bare id; if it is already bare, pass it through unchanged.
	const parsedModel = parseModelRef(model)
	if (parsedModel) {
		model = parsedModel.id
	}
	return { driver, model: model ?? "" }
}

export async function handleSampling(
	id: string | number,
	params: unknown,
	opts: McpClientCapabilityOptions | undefined,
	approval: McpApprovalOptions | undefined,
	drivers: SamplingDriverRegistry,
	serverName: string,
): Promise<InboundRequestResult> {
	const sampling = opts?.sampling
	if (!sampling) {
		return { error: capabilityNotOptedInError(id, "sampling/createMessage").error }
	}
	const request = params as SamplingRequest
	// Reuse the TASK_0013 approval gate. The `ApprovalCall.toolName` is the
	// synthetic constant `'sampling/createMessage'` (per the
	// `ApprovalCall` doc); `serverName` identifies the requesting server.
	const approvalCall: ApprovalCall = {
		toolName: "sampling/createMessage",
		serverName,
		params: request,
	}
	// Inline the refusal policy: we can't use `guardCall` directly because
	// we want to return a JSON-RPC error (not throw) on refusal, so the
	// server gets a well-formed response.
	const approvalError = await checkSamplingApproval(approvalCall, approval)
	if (approvalError) return { error: approvalError }
	// Driver + model selection.
	const selection = await selectSamplingDriver(sampling, drivers)
	if ("error" in selection) return { error: selection.error }
	const { driver, model } = selection
	// Build the ChatRequest. The server's `messages` is typed opaquely
	// (`unknown`); this task casts it to the driver's expected
	// `BHZAIMessage[]` shape. A real conversion layer (mapping MCP sampling
	// message roles/content to BHZAI's `BHZAIMessage`) is out of scope for
	// this task — the architecture doc does not specify it, and the
	// drivers in this task group are mocks. A future task may add a
	// proper translator.
	const chatRequest: ChatRequest = {
		model,
		messages: (request.messages as ChatRequest["messages"]) ?? [],
		systemPrompt: request.systemPrompt,
		params: {
			maxTokens: request.maxTokens,
			stop: request.stopSequences,
			temperature: request.temperature,
		},
		signal: new AbortController().signal,
	}
	// Consume the driver's `chat()` async iterable to completion,
	// concatenating `delta` events into a final text. Sampling responses
	// are NOT streamed back to the MCP server incrementally in this task's
	// scope — the MCP `sampling/createMessage` response is a single
	// JSON-RPC result, not a stream (documented simplification).
	const streamResult = await consumeSamplingChat(driver, chatRequest)
	if ("error" in streamResult) return { error: streamResult.error }
	const { text, stopReason } = streamResult
	const response: SamplingResponse = {
		role: "assistant",
		content: { type: "text", text },
		model,
		stopReason,
	}
	return { result: response }
}

/**
 * Consume the driver's `chat()` async iterable to completion, concatenating
 * `delta` events into a final text. Returns `{ text, stopReason }` on
 * success, or `{ error }` if the driver yields a `done(error)` event or
 * `chat()` throws.
 */
async function consumeSamplingChat(
	driver: BHZAIDriver,
	chatRequest: ChatRequest,
): Promise<{ text: string; stopReason: string | undefined } | { error: JsonRpcError }> {
	let text = ""
	let stopReason: string | undefined
	try {
		for await (const event of driver.chat(chatRequest)) {
			if (event.type === "delta") {
				text += event.text
			} else if (event.type === "done") {
				stopReason = event.stopReason
				if (event.stopReason === "error" && event.error) {
					const errMsg =
						event.error instanceof Error ? event.error.message : JSON.stringify(event.error)
					return {
						error: {
							code: JSON_RPC_ERROR_CODES.INTERNAL_ERROR,
							message: `sampling/createMessage: driver chat() error: ${errMsg}`,
						},
					}
				}
			}
		}
	} catch (err) {
		return {
			error: {
				code: JSON_RPC_ERROR_CODES.INTERNAL_ERROR,
				message: `sampling/createMessage: driver chat() threw: ${(err as Error).message}`,
			},
		}
	}
	return { text, stopReason }
}

/**
 * Handle an inbound `roots/list` server request (TASK_0014).
 *
 * Behavior:
 *  1. If `roots` was not opted into, return a `method not found` JSON-RPC
 *     error (mirroring the elicitation/sampling non-opt-in behavior, for
 *     consistency).
 *  2. Otherwise, call `getRoots()` and return the result as the
 *     `roots/list` response `result.roots`.
 */
export async function handleRootsList(
	id: string | number,
	opts: McpClientCapabilityOptions | undefined,
): Promise<InboundRequestResult> {
	const roots = opts?.roots
	if (!roots) {
		return { error: capabilityNotOptedInError(id, "roots/list").error }
	}
	try {
		const result = await roots.getRoots()
		return { result: { roots: result } }
	} catch (err) {
		return {
			error: {
				code: JSON_RPC_ERROR_CODES.INTERNAL_ERROR,
				message: `roots/list handler threw: ${(err as Error).message}`,
			},
		}
	}
}

/**
 * Build the outbound `notifications/roots/list_changed` notification
 * payload (TASK_0014). Sent to the server when the host calls
 * `client.notifyRootsChanged()`. The notification has no params per spec
 * (/client/roots) — this helper returns `undefined` params for the
 * transport layer to omit.
 */
export function rootsListChangedNotification(): { method: string; params: undefined } {
	return { method: "notifications/roots/list_changed", params: undefined }
}
