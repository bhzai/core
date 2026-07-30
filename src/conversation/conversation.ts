/** @file Conversation surface skeleton (TASK_0023) — BHZAIConversation interface and event mirroring */

import type { BHZAI } from "../core/bhzai.js"
import type { BlockSignal, DispatchOptions, Handler } from "../core/event-bus.js"
import { EventBus } from "../core/event-bus.js"
import type { ContentBlock } from "../types/content.js"
import type { EmitResult, Unsubscribe } from "../types/events.js"
import type { BHZAIMessage, ConversationStatus } from "../types/message.js"
// ConversationSnapshot is now defined and versioned in snapshot.ts (TASK_0028).
// Import here to use in internal method signatures.
import type { ConversationSnapshot } from "./snapshot.js"
import { toSnapshot } from "./snapshot.js"

/**
 * Conversation creation options — extensible by later tasks.
 *
 * Later tasks (TASK_0024+) may add fields like `compaction`, `serialTools`,
 * `maxIterations` by extending this interface or adding optional fields.
 */
export interface CreateConversationOptions {
	/**
	 * Qualified `'<driver>/<model>'` ref — explicit model override.
	 * If not set and no host `defaultModel` exists, `model.resolve` fires.
	 */
	model?: string
	/** Per-conversation system prompt (TASK_0024 consumes this). */
	systemPrompt?: string
	/**
	 * Force all tool calls in a batch to run strictly one-at-a-time,
	 * ignoring individual tools' `serial` flag (TASK_0026).
	 */
	serialTools?: boolean
	/**
	 * Maximum number of validate-and-repair synthetic errors issued per turn
	 * before further repairs are marked as terminal (default 2, per TASK_0026).
	 */
	maxToolRepairs?: number
	/**
	 * Maximum number of agent-loop iterations (tool-call rounds) before stopping.
	 * Default 8, per ARCHITECTURE.md § 11.2. When reached, the final assistant
	 * message is flagged `meta.truncatedBy = 'max-iterations'` (TASK_0027).
	 */
	maxIterations?: number
	/**
	 * Per-turn timeout in milliseconds. If set, each iteration's context→request→stream
	 * sequence (including tool batch execution) is raced against this timer. On expiry,
	 * that turn ends in an error state WITHOUT flipping conversation.status to 'aborted'
	 * — the scoping is per-turn only, not conversation-wide. If undefined (default),
	 * no per-turn timeout is enforced (TASK_0027).
	 */
	turnTimeoutMs?: number
	/**
	 * Retry policy for driver calls (TASK_0018). When set, overrides the
	 * DEFAULT_RETRY_POLICY. If undefined, uses DEFAULT_RETRY_POLICY (TASK_0027).
	 */
	retryPolicy?: import("../core/retry.js").RetryPolicy
	/**
	 * Extract `<think>...</think>` sections out of the model's own text stream.
	 *
	 * Some reasoning models have no structured reasoning channel and instead emit
	 * their chain of thought inline, wrapped in `<think>` tags, mixed into the
	 * ordinary text stream. With this enabled the agent loop splits that stream as
	 * it arrives:
	 *
	 * - text inside the tags accumulates on `message.think` and is dispatched as
	 *   `message.delta` with `kind: 'reasoning'`;
	 * - text outside the tags becomes the message body as usual and is dispatched
	 *   with `kind: 'text'`.
	 *
	 * Tags split across chunk boundaries are handled. Consumers therefore see the
	 * same two-channel shape they would get from a driver with a native
	 * `reasoning-delta` channel, and `message.content` never contains `<think>`
	 * markup.
	 *
	 * Defaults to `false`, in which case `<think>` tags pass through into the
	 * message body untouched. A driver's native `reasoning-delta` events are
	 * unaffected either way — those keep populating `meta.reasoning`.
	 */
	parseThink?: boolean

	/**
	 * Auto-compaction configuration (TASK_0031). When set, enables automatic
	 * context-window compaction based on driver-reported window size and usage.
	 * - `auto`: true to enable auto-compaction.
	 * - `reserveTokens`: minimum free tokens to maintain; compaction triggers when
	 *   `contextWindow - (inputTokens + outputTokens) < reserveTokens`.
	 * If `auto` is false or undefined, auto-compaction is disabled.
	 * If the active driver does not report a `contextWindow` capability, auto-compaction
	 * never triggers for this conversation (per ARCHITECTURE.md § 11.5).
	 */
	compaction?: { auto: boolean; reserveTokens: number }
}

// ConversationSnapshot is now defined and versioned in snapshot.ts (TASK_0028).
// It is imported above and re-exported here to maintain a single canonical definition.
// This keeps snapshot-related types together in one place.
export type { ConversationSnapshot }

/**
 * Conversation-scoped events. Expanded by later tasks (TASK_0024+).
 */
export interface ConversationEvents {
	"meta.changed": { meta: Record<string, unknown>; patch: Record<string, unknown> }
	// Additional events (message, tool, context, etc.) added by TASK_0024+
	[key: string]: unknown
}

/**
 * Public conversation interface — the object hosts and plugins interact with.
 *
 * Per ARCHITECTURE.md § 11.1. Methods beyond what's listed here are stubs
 * with `// TODO(TASK_XXXX)` comments naming the owning task.
 */
export interface BHZAIConversation {
	/** Unique conversation identity, generated with `crypto.randomUUID()`. */
	readonly id: string

	/**
	 * Read-only view of messages — prevents external code from mutating the
	 * live array and bypassing the message lifecycle machinery (TASK_0025).
	 */
	readonly messages: readonly BHZAIMessage[]

	/** Conversation status: one of the ConversationStatus values (§ 11.1). */
	get status(): ConversationStatus

	/** Host-extension metadata record (title, task widgets, host flags). */
	readonly meta: Readonly<Record<string, unknown>>

	/**
	 * Shallow-merge patch into meta and fire `meta.changed` event.
	 *
	 * Per § 11.1: shallow-merges patch into current meta, fires `meta.changed`
	 * with `{ meta: this._meta, patch }` where patch is the exact passed-in
	 * object, not the accumulated diff. Returns a Promise that resolves when
	 * the event dispatch completes.
	 */
	setMeta(patch: Record<string, unknown>): Promise<void>

	/** Token usage tracking — initialized to `{ inputTokens: 0, outputTokens: 0 }`. */
	readonly usage: { inputTokens: number; outputTokens: number }

	/**
	 * Register a handler for conversation-scoped event.
	 *
	 * Delegates to the conversation's private EventBus. Any event name is
	 * accepted on the conversation bus, including reserved names (only the
	 * public `emit()` restricts them — `on()` permits observation of reserved
	 * events).
	 */
	on<E extends keyof ConversationEvents>(
		event: E,
		handler: Handler<ConversationEvents[E]>,
	): Unsubscribe

	/**
	 * Emit a namespaced custom event on the conversation-scoped bus.
	 *
	 * Throws synchronously if `event` is reserved or un-namespaced (same
	 * validation as `bh.emit()` — the reserved-name list applies uniformly).
	 */
	emit<E extends keyof ConversationEvents>(
		event: E,
		payload: ConversationEvents[E],
		options?: DispatchOptions,
	): Promise<EmitResult<ConversationEvents[E]>>

	/**
	 * STUB: Abort the conversation (TASK_0027 implements real semantics).
	 *
	 * For this task, sets status to 'aborted' and stores reason. Full
	 * cancellation propagation lands in TASK_0027.
	 */
	abort(reason?: string): void

	/**
	 * STUB: Wait for the conversation to return to idle (TASK_0030).
	 *
	 * For this task, resolves immediately (since no agent loop exists yet).
	 * TASK_0030 implements real queue-draining semantics.
	 */
	waitForIdle(): Promise<void>

	/**
	 * TODO(TASK_0028): serialize conversation to a snapshot.
	 *
	 * Full version policy and validation-on-load are TASK_0028's job.
	 */
	toJSON(): ConversationSnapshot

	/**
	 * Send a user message and drive the agent loop (TASK_0025).
	 *
	 * Implements the full sendMessage behavior, context events, and streaming.
	 */
	sendMessage(
		content: string | ContentBlock[],
		options?: import("./agent-loop.js").SendOptions,
	): Promise<BHZAIMessage>

	/**
	 * Add a message without driving the agent loop (TASK_0025).
	 *
	 * Adds a message directly without recursing into the agent loop.
	 */
	addMessage(
		content: string | ContentBlock[],
		role: "user" | "assistant" | "system",
		options?: import("./agent-loop.js").AddOptions,
	): Promise<BHZAIMessage>

	/**
	 * TODO(TASK_0025/cross-group model switching): set the active model.
	 *
	 * Model resolution and validation are TASK_0022+; this task only stubs.
	 */
	setModel(ref: string): void

	/**
	 * TODO(TASK_0031): compact the conversation (memory/context optimization).
	 *
	 * Compaction trigger mechanics and steering are TASK_0031's job.
	 */
	compact(options?: unknown): Promise<void>
}

/**
 * Core conversation implementation with private event bus and mirroring logic.
 *
 * Implements the `BHZAIConversation` interface. Each instance owns a private
 * `EventBus` (reusing TASK_0004's class, not a duplicate implementation);
 * the crucial `dispatchConversationEvent()` method implements the mirroring
 * mechanic from ARCHITECTURE.md § 8.1: conversation-bus handlers run first,
 * then the framework-bus mirror runs seeded with their patches, sharing one
 * continuing patch chain.
 */
export class BHZAIConversationImpl implements BHZAIConversation {
	/** Unique identity per conversation. Writable by internal methods only. */
	_id: string

	get id(): string {
		return this._id
	}

	/** Private mutable message array. Exposed read-only via the `messages` getter. */
	private _messages: BHZAIMessage[] = []

	/** Lifecycle status: idle, streaming, waiting-tool, compacting, aborted, error. */
	private _status: ConversationStatus = "idle"

	/** Host-extension metadata. Shallow-merged by `setMeta()`. */
	private _meta: Record<string, unknown> = {}

	/** Token usage tracking. */
	private _usage: { inputTokens: number; outputTokens: number } = {
		inputTokens: 0,
		outputTokens: 0,
	}

	/** Active model reference, if set. */
	private _model: string | undefined

	/** Abort reason, if set. */
	private _abortReason: string | undefined

	/**
	 * Flag marking whether this conversation was loaded from a snapshot.
	 *
	 * Set to `true` by `loadConversation()` so TASK_0024's `ensureStarted()`
	 * never fires `start` for a loaded conversation (a loaded transcript is
	 * already settled, not a fresh beginning).
	 */
	private _started = false

	/**
	 * System prompt assembled from layers 1-2 (host default + per-conversation override).
	 * Layer 3 (start-event patches) and layer 4 (context-event patches) are applied
	 * by separate modules when they run.
	 *
	 * Computed at construction as: per-conversation `options?.systemPrompt` if provided
	 * (REPLACES host default entirely), else the host default, else empty string.
	 */
	private _systemPrompt = ""

	/**
	 * Creation options passed to this conversation's constructor (or empty if loaded).
	 * Stored so `ensureStarted()` can pass them to `start` event handlers.
	 */
	private _createOptions: CreateConversationOptions = {}

	/**
	 * Private event bus for this conversation. Reuses TASK_0004's EventBus class
	 * unchanged — no duplicate dispatch/patch-chaining implementation.
	 *
	 * One instance per conversation; the framework has its own separate instance.
	 * Mirroring logic in `dispatchConversationEvent()` bridges them.
	 */
	private readonly bus = new EventBus()

	/**
	 * Abort controller for this conversation.
	 *
	 * Used by TASK_0025's agent loop to wire AbortSignals. Per the architecture,
	 * every live AbortSignal must be derived from one root controller.
	 * The `abort()` method calls `this._abortController.abort(reason)` in addition
	 * to setting `_status` and `_abortReason` (this task's stub behavior).
	 *
	 * @internal
	 */
	private readonly _abortController = new AbortController()

	/**
	 * Steer queue for TASK_0030: messages delivered between tool-call settlement
	 * and the next LLM call. FIFO queue of (content, resolve, reject) tuples.
	 *
	 * @internal
	 */
	private readonly _steerQueue: Array<{
		content: string | ContentBlock[]
		resolve: (msg: BHZAIMessage) => void
		reject: (err: unknown) => void
	}> = []

	/**
	 * FollowUp queue for TASK_0030: messages delivered after loop(end) when status
	 * returns to idle. FIFO queue of (content, resolve, reject) tuples.
	 *
	 * @internal
	 */
	private readonly _followUpQueue: Array<{
		content: string | ContentBlock[]
		resolve: (msg: BHZAIMessage) => void
		reject: (err: unknown) => void
	}> = []

	/**
	 * Construct a new conversation with a fresh UUID and empty state.
	 *
	 * @param bh The owning BHZAI instance (provides access to tool/driver registries and framework bus).
	 * @param options Options for the new conversation (model, systemPrompt, etc.).
	 */
	constructor(
		private readonly bh: BHZAI,
		options?: CreateConversationOptions,
	) {
		this._id = crypto.randomUUID()
		this._createOptions = options ?? {}
		// Compute system prompt: per-conversation override replaces host default entirely
		this._systemPrompt = options?.systemPrompt ?? this.bh._hostSystemPrompt ?? ""
	}

	// ---------------------------------------------------------------------------
	// Read-only properties
	// ---------------------------------------------------------------------------

	/**
	 * Return a read-only (frozen) shallow copy of messages.
	 *
	 * Prevents external code from `push()`ing into the live array and bypassing
	 * TASK_0025's message lifecycle. Internally, the class maintains a mutable
	 * `_messages` array that only the conversation's own methods are allowed to
	 * mutate (and later, TASK_0025's agent loop, which lives in this class).
	 */
	get messages(): readonly BHZAIMessage[] {
		return Object.freeze(this._messages.slice())
	}

	/** Current conversation status. */
	get status(): ConversationStatus {
		return this._status
	}

	/** Read-only snapshot of current metadata. */
	get meta(): Readonly<Record<string, unknown>> {
		return Object.freeze({ ...this._meta })
	}

	/** Token usage snapshot. */
	get usage(): { inputTokens: number; outputTokens: number } {
		return {
			inputTokens: this._usage.inputTokens,
			outputTokens: this._usage.outputTokens,
		}
	}

	// ---------------------------------------------------------------------------
	// Event bus delegation
	// ---------------------------------------------------------------------------

	/**
	 * Register a handler on the conversation-scoped bus.
	 *
	 * Delegates directly to `this.bus.on()`. Any event name is accepted
	 * (subscription is unrestricted; only the public `emit()` enforces
	 * reserved-name rules).
	 */
	on<E extends keyof ConversationEvents>(
		event: E,
		handler: Handler<ConversationEvents[E]>,
	): Unsubscribe {
		return this.bus.on(event as string, handler as Handler<unknown>)
	}

	/**
	 * Emit a namespaced custom event on the conversation-scoped bus.
	 *
	 * Delegates to `this.bus.emit()`, which enforces the reserved-name check
	 * and un-namespaced-name check. The one documented exception is `compact`,
	 * which this method intercepts to run the actual compaction pipeline instead
	 * of dispatching it as a normal event (TASK_0031). This closes TASK_0004's
	 * `// TODO(TASK_0031)` seam by routing the emission into `runCompactionPipeline`
	 * here at the conversation scope (not in EventBus, which must remain scope-agnostic).
	 */
	async emit<E extends keyof ConversationEvents>(
		event: E,
		payload: ConversationEvents[E],
		options?: DispatchOptions,
	): Promise<EmitResult<ConversationEvents[E]>> {
		// Intercept 'compact' emit trigger (TASK_0031) — route into the pipeline
		if (event === "compact") {
			// Dynamic import to avoid circular dependency
			const { compactViaEmit } = await import("./compaction.js")
			await compactViaEmit(this, payload as import("./compaction.js").CompactOptions)
			// Return a synthetic EmitResult reflecting the pipeline's outcome
			// (handled count is 3 for a full before/compacting/complete run, 1 if blocked)
			return {
				handled: 3, // before, compacting (if not pre-supplied), complete
				patch: {},
				blocked: false,
				reason: undefined,
			} as EmitResult<ConversationEvents[E]>
		}

		return this.bus.emit(event as string, payload, options) as Promise<
			EmitResult<ConversationEvents[E]>
		>
	}

	// ---------------------------------------------------------------------------
	// Metadata
	// ---------------------------------------------------------------------------

	/**
	 * Shallow-merge a patch into metadata and fire `meta.changed`.
	 *
	 * Per ARCHITECTURE.md § 11.1 and TASK_0023's "meta / setMeta" section:
	 * (1) shallow-merges patch into current meta: `this._meta = { ...this._meta, ...patch }`
	 * (2) fires `meta.changed` with payload `{ meta: this._meta, patch }` where
	 *     `meta` is the **new, already-merged** value and `patch` is exactly
	 *     what the caller passed in (not the accumulated diff).
	 *
	 * Uses the shared mirroring mechanism so conversation-scoped `meta.changed`
	 * handlers run first, then framework-level `conversation.meta.changed`
	 * handlers see the already-patched state.
	 *
	 * Returns a Promise that resolves when the event dispatch completes.
	 */
	async setMeta(patch: Record<string, unknown>): Promise<void> {
		// Shallow merge
		this._meta = { ...this._meta, ...patch }

		// Fire event via mirroring mechanism and await completion
		await this.dispatchConversationEvent("meta.changed", {
			meta: this._meta,
			patch,
		})
	}

	// ---------------------------------------------------------------------------
	// Event mirroring — the core mechanic
	// ---------------------------------------------------------------------------

	/**
	 * Internal dispatch mechanism implementing the conversation event mirroring
	 * from ARCHITECTURE.md § 8.1.
	 *
	 * **Per § 8.1: "every conversation event is mirrored onto the framework bus
	 * as `conversation.<event>` ... It is one logical dispatch — conversation-
	 * bus handlers run first, then the framework-bus mirrors, sharing a single
	 * patch chain."**
	 *
	 * This is the SINGLE MOST IMPORTANT design decision in TASK_0023: the two
	 * dispatches are NOT independent (both running against the original payload).
	 * Instead, the framework-bus mirror is SEEDED with the conversation-bus
	 * stage's already-applied patch, so framework handlers observe conversation
	 * handlers' effects. A wrong implementation would look like:
	 *
	 * ```typescript
	 * // WRONG — framework handlers never see conversation handlers' patches:
	 * const r1 = await this.bus.dispatch(event, payload)
	 * const r2 = await this.bh._dispatch(`conversation.${event}`, payload) // <— same original payload!
	 * ```
	 *
	 * This method instead:
	 * 1. Dispatch on the conversation's bus first, capturing the patched payload.
	 * 2. Seed the framework dispatch with that patched payload.
	 * 3. If conversation dispatch blocked, return its result (§ 8.2 rule 3:
	 *    "block short-circuits later handlers") — never run the framework mirror.
	 * 4. Otherwise, merge both stages' results into one continuing patch chain.
	 *
	 * Every conversation event firing in this task (`created`/`loaded`) and
	 * every later task (`start`/`message`/`tool`/`context`/etc.) MUST go through
	 * this one shared mechanism.
	 */
	private async dispatchConversationEvent<Payload>(
		event: string,
		payload: Payload,
		options?: DispatchOptions,
	): Promise<EmitResult<Payload>> {
		// STEP 1: Dispatch on the conversation's own bus first.
		const conversationResult = await this.bus.dispatch(event, payload, options)

		// STEP 2: If conversation bus blocked, return immediately.
		// Per § 8.2 rule 3: "block short-circuits later handlers". The framework-
		// bus mirror handlers are "later handlers" in this one logical dispatch,
		// so they do not run if the conversation stage blocked.
		if (conversationResult.blocked) {
			return conversationResult
		}

		// STEP 3: Mirror to the framework bus, SEEDED with the conversation-bus
		// stage's already-patched payload. This is what "sharing a single patch
		// chain" means: the framework handlers run AFTER conversation handlers,
		// see their patches already applied, and any patches they return
		// continue accumulating into the final EmitResult.
		const seededPayload: Payload = {
			...payload,
			...conversationResult.patch,
		}
		const frameworkResult = await this.bh._dispatch(`conversation.${event}`, seededPayload, options)

		// STEP 4: Merge both stages' results into one continuing patch chain.
		// Both stages contributed handlers; `handled` is the sum. `patch` is
		// the cumulative merge of both stages' patches.
		return {
			blocked: frameworkResult.blocked,
			reason: frameworkResult.reason ?? conversationResult.reason,
			patch: { ...conversationResult.patch, ...frameworkResult.patch },
			handled: conversationResult.handled + frameworkResult.handled,
		}
	}

	// ---------------------------------------------------------------------------
	// Stub methods — placeholder implementations
	// ---------------------------------------------------------------------------

	/**
	 * Abort this conversation (TASK_0027).
	 *
	 * Sets `status` to `'aborted'`, stores the abort `reason` for inspection,
	 * and aborts the internal AbortController so all derived AbortSignals fire
	 * simultaneously. Fires the `abort` event (notification-only, per § 8.1)
	 * via the internal dispatch mechanism so conversation-scoped and framework-level
	 * handlers both observe the abort.
	 *
	 * Propagates cancellation through every in-flight tool call and driver request
	 * that uses the conversation's AbortSignal (§ 11.2 guardrail: "abort propagation
	 * through every `AbortSignal`"). Per § 11.2 and TASK_0027, a per-turn timeout
	 * is narrower in scope than a full `abort()` — timeout does not flip status,
	 * but `abort()` does.
	 *
	 * @param reason Optional reason for the abort (e.g. "user cancelled").
	 */
	abort(reason?: string): void {
		this._status = "aborted"
		this._abortReason = reason
		this._abortController.abort(reason)

		// Fire abort event via internal dispatch bypass (not restricted by emit() guard).
		// This is the ONLY place we call dispatchConversationEvent from outside the loop.
		void this.dispatchConversationEvent("abort", {
			reason,
		})
	}

	/**
	 * Wait for the conversation to return to idle.
	 *
	 * Per TASK_0030, resolves once BOTH: (a) no turn is currently streaming
	 * (`conversation.status === 'idle'`), AND (b) both the `steerQueue` and
	 * `followUpQueue` are empty. Implements this as: if both conditions already
	 * hold at call time, resolve immediately (fast path); otherwise, register
	 * an internal one-shot listener on the conversation's `idle` event and
	 * resolve when that fires.
	 */
	waitForIdle(): Promise<void> {
		if (
			this._status === "idle" &&
			this._steerQueue.length === 0 &&
			this._followUpQueue.length === 0
		) {
			return Promise.resolve()
		}

		return new Promise<void>((resolve) => {
			const unsubscribe = this.bus.on("idle", () => {
				unsubscribe()
				resolve()
			})
		})
	}

	/**
	 * Serialize this conversation to a versioned, plain-JSON snapshot (TASK_0028).
	 *
	 * Produces a `ConversationSnapshot` containing the complete, serializable state
	 * of this conversation. The snapshot is suitable for storage in any backend
	 * (SQL, IndexedDB, files, localStorage). No functions, class instances, Map/Set,
	 * or other non-JSON types appear anywhere in the tree.
	 *
	 * To verify JSON-serializability, call `JSON.parse(JSON.stringify(this.toJSON()))`
	 * and compare deep-equality to the result of `this.toJSON()` — if they differ,
	 * non-JSON types are present in the tree somewhere.
	 *
	 * See `snapshot.ts` for the full version policy, serialization contract, and
	 * the inverse operation (`fromSnapshot()`).
	 */
	toJSON(): ConversationSnapshot {
		return toSnapshot(this)
	}

	/**
	 * Send a user message and drive the agent loop (TASK_0025).
	 *
	 * Implements the full pipeline from ensureStarted through message lifecycle,
	 * context event, driver call, and streaming response. Per TASK_0025, if
	 * message(before) blocks, resolves with a synthetic message flagged
	 * `meta.blocked: true` rather than throwing.
	 */
	async sendMessage(
		content: string | ContentBlock[],
		options?: import("./agent-loop.js").SendOptions,
	): Promise<BHZAIMessage> {
		const { sendMessage: sendMessageImpl } = await import("./agent-loop.js")
		return sendMessageImpl(this, content, options)
	}

	/**
	 * Add a message without driving the agent loop (TASK_0025).
	 *
	 * Constructs a message with the given role and content, appends it directly,
	 * fires message(sent), and returns immediately. Does not fire loop, context,
	 * or call the driver.
	 */
	async addMessage(
		content: string | ContentBlock[],
		role: "user" | "assistant" | "system",
		options?: import("./agent-loop.js").AddOptions,
	): Promise<BHZAIMessage> {
		const { addMessage: addMessageImpl } = await import("./agent-loop.js")
		return addMessageImpl(this, content, role, options)
	}

	/**
	 * TODO(TASK_0025/cross-group model switching): set active model.
	 */
	setModel(): void {
		throw new Error("conversation.setModel(): not implemented — see TASK_0025")
	}

	/**
	 * Manual compaction trigger (TASK_0031).
	 *
	 * Compresses the conversation history by summarizing folded messages and
	 * inserting a system summary message, while preserving the complete message
	 * history (folded messages remain in the array, only marked `contextIncluded: false`).
	 * See ARCHITECTURE.md § 11.5 for the full pipeline and event contract.
	 *
	 * @param options Compaction options (reserved for future use).
	 */
	async compact(options?: import("./compaction.js").CompactOptions): Promise<void> {
		const { compact: compactImpl } = await import("./compaction.js")
		return compactImpl(this, options)
	}

	// ---------------------------------------------------------------------------
	// Internal methods for BHZAI to call during createConversation/loadConversation
	// ---------------------------------------------------------------------------

	/**
	 * Internal: set the resolved model reference.
	 *
	 * Called by `BHZAI.createConversation()` / `BHZAI.loadConversation()` after
	 * model resolution completes. Not part of the public interface.
	 *
	 * @internal
	 */
	_setResolvedModel(modelRef: string | undefined): void {
		this._model = modelRef
	}

	/**
	 * Internal: restore conversation state from a snapshot (TASK_0028).
	 *
	 * Called by `fromSnapshot()` in snapshot.ts to populate `_id`, `_messages`, `_meta`,
	 * and `_usage` from a serialized snapshot. This method is the inverse of `toJSON()`
	 * and allows callers to avoid unsafe type casts that reach into private fields.
	 *
	 * Does not fire events or perform model resolution — those are handled by
	 * `fromSnapshot()` itself. This method is purely a state-restore operation.
	 *
	 * @param params Object containing `id`, `messages`, `meta`, and `usage`
	 *
	 * @internal
	 */
	_restoreFromSnapshot(params: {
		id: string
		messages: BHZAIMessage[]
		meta: Record<string, unknown>
		usage: { inputTokens: number; outputTokens: number }
	}): void {
		this._id = params.id
		this._messages = params.messages
		this._meta = params.meta
		this._usage = params.usage
	}

	/**
	 * Internal: mark this conversation as having been loaded (not freshly created).
	 *
	 * Sets a flag so TASK_0024's `ensureStarted()` never fires `start` for a
	 * loaded conversation. Not part of the public interface.
	 *
	 * @internal
	 */
	_markLoaded(): void {
		this._started = true
	}

	/**
	 * Internal: fire the `conversation.created` event.
	 *
	 * Called by `BHZAI.createConversation()` after constructing the conversation.
	 * Uses the shared mirroring mechanism so both conversation-scoped and
	 * framework-level handlers observe the event.
	 *
	 * @internal
	 */
	async _fireCreated(): Promise<void> {
		await this.dispatchConversationEvent("created", { conversation: this })
	}

	/**
	 * Internal: fire the `conversation.loaded` event.
	 *
	 * Called by `BHZAI.loadConversation()` after loading from snapshot.
	 * Uses the shared mirroring mechanism.
	 *
	 * @internal
	 * @param snapshot The snapshot object that was loaded.
	 */
	async _fireLoaded(snapshot: ConversationSnapshot): Promise<void> {
		await this.dispatchConversationEvent("loaded", {
			conversation: this,
			snapshot,
		})
	}

	/**
	 * Internal: check if the conversation has been started.
	 *
	 * Returns `true` if `_markStarted()` has been called (either explicitly or
	 * by `_markLoaded()`), indicating that the `start` event has already fired
	 * or is not applicable (for loaded conversations).
	 *
	 * @internal
	 */
	_isStarted(): boolean {
		return this._started
	}

	/**
	 * Internal: mark the conversation as started.
	 *
	 * Called by `ensureStarted()` before firing the `start` event. Sets the flag
	 * that makes subsequent `ensureStarted()` calls idempotent (they return immediately).
	 *
	 * @internal
	 */
	_markStarted(): void {
		this._started = true
	}

	/**
	 * Internal: read the current system prompt (layers 1-3 resolved).
	 *
	 * Returns the baseline system prompt computed at construction (layers 1-2)
	 * plus any patches applied by `start` event handlers (layer 3). Does not
	 * include layer 4 (`context` event) patches — those are the responsibility
	 * of the TASK_0025 `context` event firing.
	 *
	 * @internal
	 */
	_getSystemPrompt(): string {
		return this._systemPrompt
	}

	/**
	 * Internal: set the system prompt (for layer 3/start patches).
	 *
	 * Called by `ensureStarted()` to apply system-prompt patches from `start`
	 * event handlers. Replaces the entire prompt when called with
	 * `{ systemPrompt: ... }` or appends when the handler used the append rule.
	 *
	 * @internal
	 */
	_setSystemPrompt(value: string): void {
		this._systemPrompt = value
	}

	/**
	 * Internal: prepend messages to the front of the conversation history.
	 *
	 * Inserts messages at the very beginning of `_messages` in the order provided.
	 * Used by `ensureStarted()` to inject synthetic preamble messages from `start`
	 * handlers before the triggering user message is added.
	 *
	 * @internal
	 */
	_prependMessages(messages: BHZAIMessage[]): void {
		this._messages.unshift(...messages)
	}

	/**
	 * Internal: public wrapper around the private `dispatchConversationEvent` method.
	 *
	 * Allows `system-prompt.ts` and other modules to fire conversation-scoped
	 * events using the shared mirroring mechanism (conversation bus first, then
	 * framework bus mirror seeded with conversation patches). This is the SAME
	 * implementation as the private `dispatchConversationEvent()` — not a duplicate.
	 *
	 * @internal
	 */
	_dispatchConversationEvent<Payload>(
		event: string,
		payload: Payload,
		options?: DispatchOptions,
	): Promise<EmitResult<Payload>> {
		return this.dispatchConversationEvent(event, payload, options)
	}

	/**
	 * Internal: retrieve the conversation's original creation options.
	 *
	 * Returns the `CreateConversationOptions` passed to this conversation's
	 * constructor. Used by `ensureStarted()` to pass to `start` event handlers.
	 * For loaded conversations, returns an empty object.
	 *
	 * @internal
	 */
	_getCreateOptions(): CreateConversationOptions {
		return this._createOptions
	}

	/**
	 * Internal: get the owning BHZAI instance.
	 *
	 * Returns the BHZAI instance passed to the constructor. Used by TASK_0025's
	 * agent loop to access the tool registry, driver registry, and model listing.
	 *
	 * @internal
	 */
	_getBh(): BHZAI {
		return this.bh
	}

	/**
	 * Internal: get the resolved model reference.
	 *
	 * Returns the qualified `'<driver>/<model>'` ref set via `_setResolvedModel()`.
	 *
	 * @internal
	 */
	_getModelRef(): string | undefined {
		return this._model
	}

	/**
	 * Internal: set the conversation status.
	 *
	 * Used by TASK_0025's agent loop to transition status through the
	 * conversation lifecycle (e.g. from 'idle' to 'streaming' to 'idle' again).
	 *
	 * @internal
	 */
	_setStatus(status: ConversationStatus): void {
		this._status = status
	}

	/**
	 * Internal: append a message to the conversation history.
	 *
	 * Adds the message directly to the private `_messages` array. Used by
	 * TASK_0025's agent loop and `addMessage()` to insert user/assistant/system messages.
	 *
	 * @internal
	 */
	_pushMessage(message: BHZAIMessage): void {
		this._messages.push(message)
	}

	/**
	 * Internal: accumulate token usage.
	 *
	 * Additively updates `usage.inputTokens` and `usage.outputTokens`.
	 * Per § 11.1: token counting is cumulative across the conversation's lifetime.
	 *
	 * @internal
	 */
	_accumulateUsage(inputTokens: number, outputTokens: number): void {
		this._usage.inputTokens += inputTokens
		this._usage.outputTokens += outputTokens
	}

	/**
	 * Internal: get the abort signal for this conversation.
	 *
	 * Returns the AbortSignal derived from this conversation's root AbortController.
	 * Drivers and tool executors can pass this to their operations so the conversation's
	 * abort() call will cancel them.
	 *
	 * @internal
	 */
	_getAbortSignal(): AbortSignal {
		return this._abortController.signal
	}

	/**
	 * Internal: push an entry to the steer queue (TASK_0030).
	 *
	 * @internal
	 */
	_pushSteerQueue(entry: {
		content: string | ContentBlock[]
		resolve: (msg: BHZAIMessage) => void
		reject: (err: unknown) => void
	}): void {
		this._steerQueue.push(entry)
	}

	/**
	 * Internal: drain the steer queue (TASK_0030).
	 *
	 * Removes and returns all entries currently in the steer queue.
	 *
	 * @internal
	 */
	_drainSteerQueue(): typeof this._steerQueue {
		const entries = [...this._steerQueue]
		this._steerQueue.length = 0
		return entries
	}

	/**
	 * Internal: push an entry to the followUp queue (TASK_0030).
	 *
	 * @internal
	 */
	_pushFollowUpQueue(entry: {
		content: string | ContentBlock[]
		resolve: (msg: BHZAIMessage) => void
		reject: (err: unknown) => void
	}): void {
		this._followUpQueue.push(entry)
	}

	/**
	 * Internal: dequeue one entry from the followUp queue (FIFO) (TASK_0030).
	 *
	 * Removes and returns the first entry, or undefined if the queue is empty.
	 *
	 * @internal
	 */
	_dequeueOneFollowUp():
		| {
				content: string | ContentBlock[]
				resolve: (msg: BHZAIMessage) => void
				reject: (err: unknown) => void
		  }
		| undefined {
		return this._followUpQueue.shift()
	}

	/**
	 * Internal: get the current length of the steer queue (TASK_0030).
	 *
	 * Used for testing and defensive checks.
	 *
	 * @internal
	 */
	_getSteerQueueLength(): number {
		return this._steerQueue.length
	}

	/**
	 * Internal: get the current length of the followUp queue (TASK_0030).
	 *
	 * Used for testing and defensive checks.
	 *
	 * @internal
	 */
	_getFollowUpQueueLength(): number {
		return this._followUpQueue.length
	}

	/**
	 * Internal: insert a message at a specific index in the message array (TASK_0031).
	 *
	 * Used by the compaction pipeline to insert the summary message at the fold point
	 * (immediately before the first retained, non-folded message). This is the ONLY
	 * place where messages are inserted at arbitrary positions rather than appended.
	 *
	 * @param index The position to insert at (0 = front, length = append at end).
	 * @param message The message to insert.
	 * @internal
	 */
	_insertMessageAt(index: number, message: BHZAIMessage): void {
		this._messages.splice(index, 0, message)
	}

	/**
	 * Internal: set the contextIncluded flag on a message by id (TASK_0031).
	 *
	 * Used by the compaction pipeline to mark folded messages with `contextIncluded: false`
	 * so subsequent `context` events exclude them via `effectiveContextMessages()`.
	 * This is a direct mutation of the message's meta, consistent with the convention
	 * established in TASK_0024/0025.
	 *
	 * @param messageId The id of the message to update.
	 * @param included Whether to include this message in context (true/false).
	 * @internal
	 */
	_setMessageContextIncluded(messageId: string, included: boolean): void {
		const msg = this._messages.find((m) => m.id === messageId)
		if (msg) {
			msg.meta.contextIncluded = included
		}
	}
}
