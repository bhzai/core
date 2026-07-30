/**
 * @file System-prompt layering and start-event firing (TASK_0024), plus the
 * standalone fold-based `Conversation` system-prompt resolver that landed on
 * `main` ahead of the kernel (issue #4: replace-then-append ordering across
 * `start` handlers). Both surfaces are exported: the kernel path
 * (`ensureStarted`/`computePreContextSystemPrompt`) ships from `./core`, the
 * standalone resolver (`Conversation`) ships from the root barrel only.
 */

import type { BHZAI } from "../core/bhzai.js"
import type { MessageFieldRegistry } from "../core/message-fields.js"
import type { ContentBlock } from "../types/content.js"
import type { EmitResult } from "../types/events.js"
import type { BHZAIMessage } from "../types/message.js"
import type { CreateConversationOptions } from "./conversation.js"
import type { BHZAIConversationImpl } from "./conversation.js"
import { EventBus } from "./event-bus.js"
import { createMessage } from "./message.js"

/**
 * Message initialization shape — input to `prepend` arrays in start-event patches.
 *
 * Each `MessageInit` is converted to a full `BHZAIMessage` (with fresh UUID, timestamp,
 * derived blocks/content fields) and inserted into the conversation history via `prepend`.
 *
 * The `contextIncluded` field (default `true`) is stored as `meta.contextIncluded` to signal
 * downstream whether this message should be included in the `context` event's filtered
 * message list. This is a documented convention: TASK_0025+ must honor it when computing
 * the effective message set for `context` events and later compaction (TASK_0031).
 */
export interface MessageInit {
	/** Role: user, assistant, or system. */
	role: "user" | "assistant" | "system"

	/** Message content — plain string or structured blocks. */
	content: string | ContentBlock[]

	/** Optional metadata record. Merged with `{ contextIncluded }` on the final message. */
	meta?: Record<string, unknown>

	/**
	 * Whether this message is included in context-event filtering (default `true`).
	 * Stored as `message.meta.contextIncluded` for downstream tasks to key off.
	 * Display-only messages (e.g., explanatory preamble) use `false` to stay out
	 * of the effective message list passed to the LLM in `context` events.
	 */
	contextIncluded?: boolean
}

/**
 * Start-event patch shape — returned by handlers listening for the kernel
 * conversation's `start` event (`conversation.start`).
 *
 * Not to be confused with {@link StartEventPatch}, the patch shape of the
 * standalone fold-based {@link Conversation} resolver below — that one carries
 * `prepend: string[]` and is the shape exported from the root barrel.
 *
 * Handlers may return any combination of:
 * - `{ systemPrompt: string }` — REPLACES the current prompt outright (layer 3)
 * - `{ appendSystemPrompt: string }` — APPENDS to the current prompt (layer 3)
 * - `{ prepend: MessageInit[] }` — inserts messages at the top of history (§ 11.6)
 */
export interface KernelStartEventPatch {
	/** Replaces the system prompt outright. */
	systemPrompt?: string

	/** Appends to the system prompt with a blank-line separator. */
	appendSystemPrompt?: string

	/**
	 * Messages to prepend to the conversation history.
	 *
	 * CONVENTION FOR ACCUMULATING ARRAYS ACROSS HANDLERS:
	 * Multiple handlers may each contribute a `prepend` array. The EventBus patch-chain
	 * mechanism passes the incoming payload (containing patches from previous handlers)
	 * to each handler in registration order. A handler that wants to append to a
	 * prepend array must READ the incoming `payload.prepend` (if any) and concatenate
	 * its own array onto it before returning, e.g.:
	 *
	 * ```typescript
	 * conversation.on('start', async (payload) => {
	 *   const existingPrepend = payload.prepend ?? []
	 *   return { prepend: [...existingPrepend, myMessage] }
	 * })
	 * ```
	 *
	 * This idiom (read-then-append rather than blindly returning a fresh array)
	 * is the general BHZAI solution for accumulating array-typed patch fields when
	 * multiple handlers each want to contribute. The same pattern applies to any
	 * future accumulating array field in any event patch.
	 */
	prepend?: MessageInit[]
}

/**
 * Compute the fully-resolved system prompt (layers 1-3).
 *
 * Returns the system prompt with host default (layer 1) and per-conversation override
 * (layer 2) already applied, plus any `start`-event patches (layer 3) that handlers
 * have registered. Layer 4 (`context`-event patches) is explicitly deferred — TASK_0025
 * owns computing and applying those.
 *
 * This function is the handoff point for TASK_0025: call this at the top of `sendMessage`
 * to get the base prompt before firing the `context` event, then feed its result into
 * the `context` payload's `systemPrompt` field as the starting value before `context`
 * handlers run.
 *
 * @param conversation The conversation to read the prompt from.
 * @returns The fully-resolved pre-context system prompt.
 */
export function computePreContextSystemPrompt(conversation: BHZAIConversationImpl): string {
	return conversation._getSystemPrompt()
}

/**
 * Idempotent `start`-event firing and preamble injection.
 *
 * Fires the `start` event exactly once per conversation (on first call; subsequent calls
 * return immediately). Collects patches from registered handlers and applies them:
 * - `systemPrompt` patches REPLACE the prompt outright
 * - `appendSystemPrompt` patches APPEND with a blank-line separator
 * - `prepend` arrays are concatenated (via the read-then-append handler idiom) and
 *   inserted at the top of the message history
 *
 * The `_started` flag is set BEFORE dispatch (not after) to prevent re-entrant double-fire
 * in case of concurrent `sendMessage` calls racing on the same conversation.
 *
 * For conversations loaded via `loadConversation()`, the `_started` flag is already `true`,
 * so this function returns immediately without firing anything.
 *
 * @param conversation The conversation to start.
 * @param bh The BHZAI instance (passed for potential future use; currently unused).
 * @param options The conversation's creation options, passed to start-event handlers.
 * @param firstMessage The triggering user message (if any), passed to start-event handlers.
 *                     Prepended messages are inserted BEFORE this message in history.
 */
export async function ensureStarted(
	conversation: BHZAIConversationImpl,
	bh: BHZAI,
	options: CreateConversationOptions,
	firstMessage: BHZAIMessage | undefined,
): Promise<void> {
	// Idempotency check: if already started, return immediately.
	if (conversation._isStarted()) {
		return
	}

	// Set the flag BEFORE awaiting dispatch to prevent re-entrant double-fire.
	// The flag itself is the single source of truth for "has start begun," not
	// "has start finished" — this ensures that a concurrent call to ensureStarted()
	// sees the flag as true and skips dispatch, even if the first call hasn't
	// awaited past the dispatch yet.
	conversation._markStarted()

	// Dispatch the start event via the shared mirroring mechanism.
	const result = await conversation._dispatchConversationEvent<{
		conversation: BHZAIConversationImpl
		options: CreateConversationOptions
		firstMessage: BHZAIMessage | undefined
	}>("start", {
		conversation,
		options,
		firstMessage,
	})

	// Apply patches from handlers.
	const patch = result.patch as Partial<KernelStartEventPatch>

	// Layer 3: apply system-prompt patches.
	if ("systemPrompt" in patch && patch.systemPrompt !== undefined) {
		// REPLACE: systemPrompt completely overwrites the current prompt.
		conversation._setSystemPrompt(patch.systemPrompt)
	} else if ("appendSystemPrompt" in patch && patch.appendSystemPrompt !== undefined) {
		// APPEND: concatenate with exactly one blank line separator if current is non-empty.
		const current = conversation._getSystemPrompt()
		const appended = current
			? `${current}\n\n${patch.appendSystemPrompt}`
			: patch.appendSystemPrompt
		conversation._setSystemPrompt(appended)
	}

	// Layer 3: inject prepended messages at the top of history.
	if ("prepend" in patch && patch.prepend && patch.prepend.length > 0) {
		const fields = conversation._getBh()._getMessageFields()
		const messages = patch.prepend.map((init) => initToMessage(init, fields))
		conversation._prependMessages(messages)
	}
}

/**
 * Convert a `MessageInit` to a full `BHZAIMessage`.
 *
 * Assigns a fresh UUID, timestamp, and derives the `blocks` array from `content`
 * if it is a plain string. Merges `meta` with the `contextIncluded` convention.
 *
 * @internal
 */
function initToMessage(init: MessageInit, fields?: MessageFieldRegistry): BHZAIMessage {
	// Synthetic messages inserted here have simple content mutation (append/setContent).
	// This is safe for prepended preamble messages since they are not actively streaming.
	// TASK_0025+ will own the real state-based mutation-legality enforcement.
	return createMessage(
		{
			role: init.role,
			content: init.content,
			// Merge metadata with the contextIncluded convention.
			meta: { ...init.meta, contextIncluded: init.contextIncluded ?? true },
		},
		fields,
	)
}

// ============================================================================
// Standalone fold-based system-prompt resolver (merged from `main`).
// Backed by the conversation-local `EventBus.fold` primitive so that
// replace-then-append ordering across `start` handlers is preserved (issue #4).
// Exported from the root barrel only (`Conversation`, `StartEventPatch`,
// `ResolvedSystemPrompt`, `StartHandler`).
// ============================================================================

/**
 * Sugar patch a `start` handler may return to influence the resolved system
 * prompt. All fields are optional; a handler that returns `undefined` (or has no
 * `return`) leaves the running value untouched.
 *
 * - `systemPrompt` — **replace** the running system prompt outright.
 * - `appendSystemPrompt` — **append** a section after the running system prompt
 *   (separated by a blank line).
 * - `prepend` — accumulate lines onto the front of the running `prepend` list.
 *
 * When a single patch carries both `systemPrompt` and `appendSystemPrompt`, the
 * replace applies first and the append second, so `{ systemPrompt: "X",
 * appendSystemPrompt: "Y" }` resolves to `"X\n\nY"`.
 */
export interface StartEventPatch {
	systemPrompt?: string
	appendSystemPrompt?: string
	prepend?: string[]
}

/** The fully resolved system-prompt state after all `start` handlers have run. */
export interface ResolvedSystemPrompt {
	systemPrompt: string
	prepend: readonly string[]
}

/**
 * A `start` handler. Receives the value left behind by the previous handler and
 * returns a {@link StartEventPatch} describing how to combine against it.
 *
 * Because each handler reads the *running* resolved value rather than emitting an
 * isolated patch that is later shallow-merged, the ordering between replace-style
 * and append-style handlers is preserved: handler A returning
 * `{ systemPrompt: "X" }` followed by handler B returning
 * `{ appendSystemPrompt: "Y" }` resolves to `"X\n\nY"`, while the reverse order
 * resolves to `"X"`.
 */
// biome-ignore lint/suspicious/noConfusingVoidType: a handler may return a patch or nothing (leaving the running value unchanged)
export type StartHandler = (current: ResolvedSystemPrompt) => StartEventPatch | undefined | void

type ConversationEvents = {
	start: ResolvedSystemPrompt
}

/**
 * The slice of the kernel a {@link Conversation} needs in order to inherit
 * global plugin activation state.
 *
 * Declared structurally rather than importing `BHZAI` so `src/conversation/`
 * stays independent of `src/core/` — the two subtrees are deliberately
 * decoupled (`src/index.ts` even has to alias one's `EventBus` around the
 * other's). A `BHZAI` instance satisfies this interface without declaring it.
 */
export interface PluginActivationSource {
	/** Whether `name` is currently active kernel-wide. */
	isPluginEnabled(name: string): boolean
	/** Every registered plugin, in registration order. */
	listPlugins(): Array<{ name: string }>
}

/** Construction options for a {@link Conversation}. */
export interface ConversationOptions {
	/**
	 * Kernel whose global plugin activation this conversation inherits. Omit for
	 * a standalone conversation, in which case every handler always runs and the
	 * per-conversation overrides below still work for any owner name you use.
	 */
	BHZAI?: PluginActivationSource
}

/** One plugin's activation state as seen by a single conversation. */
export interface ConversationPluginStatus {
	name: string
	/** The kernel-wide state this conversation would inherit. */
	globalEnabled: boolean
	/** This conversation's override: `undefined` means "inherit". */
	override: boolean | undefined
	/** What actually applies here — `override ?? globalEnabled`. */
	effective: boolean
}

function appendSection(base: string, addition: string): string {
	return base.length > 0 ? `${base}\n\n${addition}` : addition
}

/**
 * Combine `patch` against the running resolved value.
 *
 * `systemPrompt` (replace) is applied before `appendSystemPrompt` (append) so a
 * single patch carrying both keys yields `"<replace>\n\n<append>"`. `prepend`
 * lines from this patch are placed ahead of whatever the running value already
 * accumulated.
 */
function applyStartPatch(
	current: ResolvedSystemPrompt,
	patch: StartEventPatch,
): ResolvedSystemPrompt {
	let systemPrompt = current.systemPrompt
	if (patch.systemPrompt !== undefined) {
		systemPrompt = patch.systemPrompt
	}
	if (patch.appendSystemPrompt !== undefined) {
		systemPrompt = appendSection(systemPrompt, patch.appendSystemPrompt)
	}

	const prepend =
		patch.prepend !== undefined ? [...patch.prepend, ...current.prepend] : current.prepend

	return { systemPrompt, prepend }
}

/**
 * Owns the resolution of a conversation's system prompt from a base prompt plus
 * an ordered chain of `start` handlers.
 *
 * Resolution is lazy: handlers run once, on the first {@link ensureStarted} (or
 * {@link systemPrompt}) call, and the result is cached for the lifetime of the
 * conversation.
 */
export class Conversation {
	private readonly bus = new EventBus<ConversationEvents>()
	private readonly baseSystemPrompt: string
	private resolved: ResolvedSystemPrompt | undefined

	/** Kernel supplying global plugin activation state, if this conversation has one. */
	private readonly source: PluginActivationSource | undefined

	/**
	 * Per-conversation activation overrides. A key present means this
	 * conversation has taken an explicit position on that plugin; a key absent
	 * means "inherit whatever the kernel says". That three-state distinction is
	 * why this is a `Map` to `boolean` rather than a `Set` of disabled names —
	 * a conversation must be able to force a plugin ON that is globally off.
	 */
	private readonly overrides: Map<string, boolean> = new Map()

	constructor(baseSystemPrompt = "", options: ConversationOptions = {}) {
		this.baseSystemPrompt = baseSystemPrompt
		this.source = options.BHZAI
	}

	/**
	 * Register a `start` handler. Handlers run in registration order when the
	 * conversation is first started. Returns a disposer that unregisters the
	 * handler (only meaningful before {@link ensureStarted} has run).
	 *
	 * `owner` attributes the handler to a plugin, so it is skipped while that
	 * plugin is inactive for this conversation ({@link isPluginEnabled}). A
	 * handler registered without an `owner` — which every pre-existing caller
	 * does — is host-owned and always runs.
	 *
	 * A skipped handler leaves the running value untouched, exactly as a handler
	 * returning `undefined` does, so deactivating a plugin is indistinguishable
	 * from it never having registered anything.
	 */
	onStart(handler: StartHandler, owner?: string): () => void {
		return this.bus.on("start", (current) => {
			if (owner !== undefined && !this.isPluginEnabled(owner)) {
				return current
			}
			const patch = handler(current)
			return patch === undefined ? current : applyStartPatch(current, patch)
		})
	}

	// ---------------------------------------------------------------------------
	// Per-conversation plugin activation.
	// ---------------------------------------------------------------------------

	/**
	 * Force `name` ON for this conversation, whatever the kernel says. Overrides
	 * a global deactivation.
	 */
	enablePlugin(name: string): this {
		this.overrides.set(name, true)
		return this
	}

	/**
	 * Force `name` OFF for this conversation, leaving every other conversation
	 * and the kernel itself untouched.
	 */
	disablePlugin(name: string): this {
		this.overrides.set(name, false)
		return this
	}

	/**
	 * Drop this conversation's override for `name`, returning it to inheriting
	 * the kernel's state. A no-op if no override was set.
	 */
	resetPlugin(name: string): this {
		this.overrides.delete(name)
		return this
	}

	/**
	 * Whether `name` is active for this conversation: its override if one is set,
	 * otherwise the kernel's global state. With no kernel and no override, the
	 * answer is `true` — a standalone conversation gates nothing.
	 */
	isPluginEnabled(name: string): boolean {
		const override = this.overrides.get(name)
		if (override !== undefined) return override
		return this.source?.isPluginEnabled(name) ?? true
	}

	/**
	 * Every plugin the kernel knows about, with the global state, this
	 * conversation's override, and the effective result. Empty when this
	 * conversation has no kernel — overrides can still be set against arbitrary
	 * owner names, there is just no plugin list to enumerate.
	 */
	listPlugins(): ConversationPluginStatus[] {
		const plugins = this.source?.listPlugins() ?? []
		return plugins.map(({ name }) => ({
			name,
			globalEnabled: this.source?.isPluginEnabled(name) ?? true,
			override: this.overrides.get(name),
			effective: this.isPluginEnabled(name),
		}))
	}

	/**
	 * Discard the cached resolution so the next read re-runs every `start`
	 * handler against the current activation state.
	 *
	 * Needed because resolution is cached for the conversation's lifetime (see
	 * {@link ensureStarted}), which means a toggle made after the conversation
	 * has already started has no effect on its own. That is the intended default:
	 * a running conversation's system prompt should not mutate underneath it just
	 * because a plugin was switched off elsewhere. `restart()` is how a caller
	 * explicitly opts into re-resolving, accepting that every handler runs again.
	 */
	restart(): void {
		this.resolved = undefined
	}

	/**
	 * Resolve and cache the system prompt by folding the seed value through every
	 * registered `start` handler in order. Idempotent: subsequent calls return the
	 * cached result without re-running handlers.
	 */
	ensureStarted(): ResolvedSystemPrompt {
		if (this.resolved === undefined) {
			const seed: ResolvedSystemPrompt = { systemPrompt: this.baseSystemPrompt, prepend: [] }
			this.resolved = this.bus.fold("start", seed)
		}
		return this.resolved
	}

	/** The resolved system-prompt string (starts the conversation if needed). */
	get systemPrompt(): string {
		return this.ensureStarted().systemPrompt
	}

	/** The resolved prepend lines (starts the conversation if needed). */
	get prepend(): readonly string[] {
		return this.ensureStarted().prepend
	}
}
