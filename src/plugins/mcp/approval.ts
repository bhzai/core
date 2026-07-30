// MCP human-in-the-loop approval gate + untrusted-by-default flag
// (ARCHITECTURE.md § 9.3 items 6-7, § 13 Security considerations).
//
// Scope of THIS file (TASK_0013):
//  - Define the `ApprovalGate` injectable function type — the temporary
//    integration seam that wraps every MCP `tools/call` (and, via
//    TASK_0014, every `sampling/createMessage`) in a human-in-the-loop
//    approval step.
//  - Implement the refusal policy: refuse unless either a gate subscriber
//    exists OR the host explicitly opted out via `autoApproveTools: true`.
//  - Provide the `McpApprovalOptions` shape consumed by `McpClient`'s
//    constructor (and threaded through `bh.addMcp()` by TASK_0015).
//
// TEMPORARY INTEGRATION SEAM — READ THIS BEFORE WIRING FURTHER:
// The `ApprovalGate` function type below is a PLACEHOLDER for the real
// `tool(beforeCall)` blockable framework/conversation event that
// TASK_0026 will build as part of the full agent-loop tool-invocation
// sequence. Until TASK_0026 lands, this gate is a bare injected function
// supplied at `McpClient` construction / `bh.addMcp()` time. When
// TASK_0026 lands, it MUST replace/wire this `approvalGate` parameter so
// that it actually dispatches through the framework's event bus
// (patch-chaining, block semantics, etc. from TASK_0004) rather than
// being a bare injected function. TASK_0013's own responsibility is
// limited to defining the seam's shape and implementing the refusal
// policy around it — NOT building the real event. This is documented
// prominently here and in TASK_0013's notes so a future reader does not
// mistake the bare function for the final mechanism.
//
// ENVIRONMENT BOUNDARY (§ 5): web-standard APIs only. This file touches
// nothing outside of plain TypeScript — no `fetch`, no `crypto`, no Node
// built-ins. It is runtime-agnostic and side-effect-free apart from the
// injected gate callback.

/**
 * The input handed to an {@link ApprovalGate} when an MCP tool (or, via
 * TASK_0014, a sampling request) is about to be invoked.
 *
 * `toolName` is the namespaced `mcp__<server>__<tool>` form for tool calls;
 * for sampling requests (TASK_0014), it is the synthetic constant
 * `'sampling/createMessage'` and `serverName` identifies the requesting
 * server. `params` is the raw argument payload the model/server supplied.
 */
export interface ApprovalCall {
	/** Namespaced tool name (`mcp__<server>__<tool>`) or `'sampling/createMessage'`. */
	toolName: string
	/** bhzai-local server name the call is being routed to. */
	serverName: string
	/** Raw argument payload for the call. */
	params: unknown
}

/**
 * The result an {@link ApprovalGate} resolves with.
 *
 * - `{ approved: true }` → the call proceeds to the transport layer.
 * - `{ approved: false, reason? }` → the call is refused; `reason` (if
 *   provided) is surfaced in the thrown/returned error to the caller.
 */
export interface ApprovalResult {
	/** Whether the human (or host policy) approved the call. */
	approved: boolean
	/** Optional human-readable reason, surfaced in the refusal error when present. */
	reason?: string
}

/**
 * Injectable approval-gate function type (TASK_0013's placeholder seam).
 *
 * TEMPORARY INTEGRATION SEAM (see the file-level comment): this is a bare
 * injected function, NOT the real `tool(beforeCall)` blockable
 * framework/conversation event. TASK_0026 must wire the real event-bus
 * dispatch through this seam when it lands.
 *
 * Reused verbatim by TASK_0014's sampling routing — do NOT invent a
 * second, parallel approval type for sampling. Sampling calls are gated
 * by the exact same "subscribed approver OR `autoApproveTools`" policy
 * as tool calls (§ 9.3's "subject to the same human-in-the-loop approval
 * seam as tool calls" wording).
 */
export type ApprovalGate = (call: ApprovalCall) => Promise<ApprovalResult>

/**
 * Dedicated error type for an MCP call refused by the approval gate
 * (TASK_0013, § 9.3 item 6). Distinct from {@link McpCallError} so
 * callers can branch on "the human said no / no approver was configured"
 * vs "the server returned an error" without string-matching the message.
 *
 * The error message is part of this task's "visibly delegated, never
 * silently dropped" requirement (§ 9.3 item 6): a refusal always comes
 * with a clear, descriptive explanation — never a silent no-op or a
 * silent auto-approval.
 */
export class McpApprovalError extends Error {
	/** The namespaced tool name (or `'sampling/createMessage'`) that was refused. */
	readonly toolName: string
	/** Optional human-supplied reason for the refusal, surfaced when provided. */
	readonly reason?: string
	constructor(toolName: string, message: string, reason?: string) {
		super(message)
		this.name = "McpApprovalError"
		this.toolName = toolName
		this.reason = reason
	}
}

/**
 * Approval configuration consumed by {@link McpClient}'s constructor
 * (and threaded through `bh.addMcp()` by TASK_0015).
 *
 * Per § 9.3 item 6, the default configuration REQUIRES either a
 * subscribed approver (a non-null {@link ApprovalGate}) OR an explicit
 * `autoApproveTools: true` opt-out (for headless/CI hosts). A call with
 * neither is REFUSED with a clear, descriptive error — never silently
 * auto-approved.
 */
export interface McpApprovalOptions {
	/**
	 * The approval-gate subscriber. When `autoApproveTools` is not `true`,
	 * this MUST be supplied or every call is refused. May be `undefined`
	 * when the host opts out via `autoApproveTools`.
	 */
	approvalGate?: ApprovalGate
	/**
	 * Explicit opt-out that short-circuits the gate entirely (§ 9.3 item 6).
	 * When `true`, calls proceed directly to the transport layer with NO
	 * gate check at all — not even calling `approvalGate` if one happens to
	 * be set. Intended for headless/CI hosts where no human is present to
	 * approve. Defaults to `false`.
	 */
	autoApproveTools?: boolean
}

/**
 * Resolve the effective `autoApproveTools` value (default `false`).
 *
 * Centralizing the default here keeps the refusal policy in one place and
 * lets {@link McpClient} construct the policy once at construction time
 * rather than re-deriving it per call.
 */
export function resolveAutoApprove(opts: McpApprovalOptions | undefined): boolean {
	return opts?.autoApproveTools === true
}

/**
 * Run an MCP call through the approval-gate refusal policy (§ 9.3 item 6).
 *
 * Refusal order (see TASK_0013's "Refusal policy" section):
 *  1. If `autoApproveTools` is `true`, proceed to the call with NO gate
 *     check at all (the explicit opt-out short-circuits entirely).
 *  2. Otherwise, if no `approvalGate` was supplied, REFUSE with a clear,
 *     descriptive error explaining that a human-in-the-loop approver is
 *     required and none was configured, and that the host must either
 *     supply one or set `autoApproveTools: true`. The transport layer is
 *     never reached.
 *  3. Otherwise (a gate is present and `autoApproveTools` is not set),
 *     call `approvalGate(call)` and await its result:
 *      - `{ approved: true }` → proceed to the real call.
 *      - `{ approved: false, reason? }` → REFUSE, surfacing `reason` (if
 *        provided) in the thrown error. The transport layer is never
 *        reached.
 *
 * @param call       The call about to be made.
 * @param opts       The approval options (gate + autoApproveTools flag).
 * @param onApproved The function to run once the call is approved — this
 *                   is the real `tools/call` (or sampling) transport
 *                   invocation. Returning the promise here lets the
 *                   caller `await` the full call chain in one expression.
 * @returns The result of `onApproved()`, once approved.
 * @throws {McpApprovalError} when the call is refused by either branch 2
 *         or branch 3 above.
 */
export async function guardCall<T>(
	call: ApprovalCall,
	opts: McpApprovalOptions | undefined,
	onApproved: () => Promise<T>,
): Promise<T> {
	// Branch 1: explicit opt-out short-circuits entirely (no gate call).
	if (resolveAutoApprove(opts)) {
		return onApproved()
	}
	const gate = opts?.approvalGate
	// Branch 2: no subscriber — refuse with a clear, descriptive error.
	if (!gate) {
		throw new McpApprovalError(
			call.toolName,
			`MCP call to '${call.toolName}' refused: a human-in-the-loop approver is required and none was configured. Either supply an \`approvalGate\` or set \`autoApproveTools: true\` to opt out (§ 9.3 item 6 — the MCP spec's MUST is delegated visibly, never silently dropped).`,
		)
	}
	// Branch 3: a gate is present — delegate the decision to it.
	const result = await gate(call)
	if (!result.approved) {
		const reason = result.reason ? `: ${result.reason}` : ""
		throw new McpApprovalError(
			call.toolName,
			`MCP call to '${call.toolName}' refused by the approval gate${reason}.`,
			result.reason,
		)
	}
	return onApproved()
}
