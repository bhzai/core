/** @file Conversation serialization contract (TASK_0028) — snapshot shape, round-trip serialization, and version policy */

import type { BHZAI } from "../core/bhzai.js"
import type { MessageFieldRegistry } from "../core/message-fields.js"
import type { ContentBlock } from "../types/content.js"
import type { GenerationParams } from "../types/driver.js"
import type { BHZAIMessage } from "../types/message.js"
import type { BHZAIConversationImpl } from "./conversation.js"
import type { CreateConversationOptions } from "./conversation.js"
import { createMessage } from "./message.js"

/**
 * Plain-JSON representation of a {@link BHZAIMessage}, excluding methods.
 *
 * Used during snapshot serialization to strip the `append()` and `setContent()` methods
 * (which are not JSON-serializable) while preserving all data fields. When a snapshot
 * is loaded, {@link toPlainMessage} reverses this process by re-attaching the methods.
 *
 * Per ARCHITECTURE.md § 11.3, the snapshot must contain only plain JSON-serializable
 * data: no functions, class instances, Map/Set, or other non-JSON types anywhere in the tree.
 *
 * @internal
 */
export interface PlainMessage {
	id: string
	role: "user" | "assistant" | "system" | "tool"
	content: string
	blocks: ContentBlock[]
	time: number
	meta: Record<string, unknown>
}

/**
 * Versioned snapshot structure for conversation persistence (TASK_0028).
 *
 * Per ARCHITECTURE.md § 11.3 ("Serialization is deliberately boring so any backend
 * (SQL rows, IndexedDB, JSONL files, localStorage) can implement it"), a snapshot is
 * a plain-JSON object with no functions, class instances, Map/Set, or other non-JSON
 * types anywhere in the tree. Version 1 is the only supported version until v2 is designed
 * and a migration table is implemented (TASK_0028's deliberate v1-only policy).
 *
 * The kernel makes NO assumption that `messages` is a complete, un-truncated history —
 * this shape is used identically for full snapshots and for truncated prefixes (enabling
 * host-side conversation forking per § 11.5 without any kernel forking code).
 */
export interface ConversationSnapshot {
	/**
	 * Version marker for schema compatibility. Currently always `1`.
	 *
	 * Per TASK_0028's explicit v1-only policy: `fromSnapshot()` throws with a clear,
	 * version-mismatch error if `snapshot.v !== 1`, rather than attempting best-effort
	 * loading or silently guessing at an unknown shape. This is a deliberate decision —
	 * silently guessing risks corrupting conversation state in ways that are hard to detect.
	 */
	v: 1

	/** Unique conversation identity, regenerated via `crypto.randomUUID()` on creation. */
	id: string

	/**
	 * Message history: all messages in the conversation.
	 *
	 * Per ARCHITECTURE.md § 11.5 ("Forking"): the kernel guarantees that `loadConversation()`
	 * accepts any prefix of a valid snapshot. A host can slice this array to message N,
	 * call `loadConversation()` on the truncated result, and get a fully functional,
	 * independent conversation with the truncated history and the snapshot's usage/meta.
	 *
	 * Each element is a plain-JSON message object with data only — no methods.
	 * {@link toPlainMessage} and {@link fromSnapshot} handle the strip/restore cycle.
	 */
	messages: PlainMessage[]

	/**
	 * Qualified `'<driver>/<model>'` reference string (e.g., `'ollama/llama3.3'`).
	 *
	 * Empty string or falsy if the conversation was never assigned a model (e.g., because
	 * `model.resolve` fired but yielded nothing usable). The `fromSnapshot()` contract
	 * re-fires `model.resolve` if this field is falsy or does not match a currently-
	 * registered model (see § 11.3 step 4 in the task spec), ensuring the reloaded
	 * conversation's model is resolved before return.
	 */
	model: string | ""

	/**
	 * Optional conversation-level generation parameter overrides.
	 *
	 * Used by later tasks (e.g., TASK_0032) to store per-conversation model settings
	 * (temperature, top_p, max_tokens, etc.). Omitted if not set. For TASK_0028,
	 * this field is passed through as-is from the conversation's internal state.
	 */
	params?: GenerationParams

	/** Token usage tracking accumulated over the conversation's lifetime. */
	usage: { inputTokens: number; outputTokens: number }

	/**
	 * Last turn's input token count — the actual context size the provider
	 * processed on the most recent LLM call. Optional: absent on old snapshots
	 * and on conversations whose driver has not yet reported usage.
	 */
	lastInputTokens?: number
	/** Last turn's output token count. Optional, same caveats as `lastInputTokens`. */
	lastOutputTokens?: number
	/** Last turn's total token count. Optional, same caveats as `lastInputTokens`. */
	lastTotalTokens?: number

	/** Host-extension metadata (title, task widgets, host flags, etc.). */
	meta: Record<string, unknown>
}

/**
 * Convert a live {@link BHZAIMessage} to plain-JSON form by stripping methods.
 *
 * The live in-memory `BHZAIMessage` objects carry two methods (`append`, `setContent`)
 * alongside their data fields — these are not JSON-serializable and must be stripped.
 * This function copies every data field (`id`, `role`, `content`, `blocks`, `time`, `meta`)
 * into a fresh plain object with no method properties.
 *
 * The returned `PlainMessage` is suitable for `JSON.stringify()`. The reverse operation
 * ({@link fromSnapshot}) will reconstruct method-bearing objects from this plain data.
 *
 * @param message The live message to strip
 * @returns A plain-JSON message object with no methods
 *
 * @internal
 */
export function toPlainMessage(message: BHZAIMessage): PlainMessage {
	return {
		id: message.id,
		role: message.role,
		content: message.content,
		blocks: message.blocks,
		time: message.time,
		meta: message.meta,
	}
}

/**
 * Serialize a live conversation to a versioned, plain-JSON snapshot.
 *
 * Per § 11.3, this produces a snapshot shape suitable for storage in any backend
 * (SQL, IndexedDB, files, localStorage). The snapshot contains only plain-JSON data:
 * no functions, class instances, Map/Set, or other non-JSON types anywhere in the tree.
 *
 * To verify JSON-serializability, call `JSON.parse(JSON.stringify(snapshot))` and
 * compare deep-equality to the original snapshot — this proves no non-JSON semantics
 * are present (e.g., `undefined`-vs-absent-key subtleties, class prototypes, etc.).
 *
 * @param conversation The live conversation to serialize
 * @returns A versioned snapshot ready for storage or network transmission
 *
 * @internal
 */
export function toSnapshot(conversation: BHZAIConversationImpl): ConversationSnapshot {
	const snapshot: ConversationSnapshot = {
		v: 1,
		id: conversation.id,
		messages: conversation.messages.map(toPlainMessage),
		model: conversation._getModelRef() ?? "",
		usage: { ...conversation.usage },
		meta: { ...conversation.meta },
		// params is intentionally omitted if not set (optional field)
	}
	// Persist last-turn usage when available (additive — old snapshots
	// load fine without these fields).
	const { lastInputTokens, lastOutputTokens, lastTotalTokens } = conversation.contextUsage
	if (lastInputTokens !== undefined) snapshot.lastInputTokens = lastInputTokens
	if (lastOutputTokens !== undefined) snapshot.lastOutputTokens = lastOutputTokens
	if (lastTotalTokens !== undefined) snapshot.lastTotalTokens = lastTotalTokens
	return snapshot
}

/**
 * Reconstruct a live conversation from a plain-JSON snapshot.
 *
 * This is the full `loadConversation()` contract, replacing TASK_0023's loose shape check:
 *
 * 1. **Version check**: if `snapshot.v !== 1`, throws a clear error. Documented as an
 *    explicit v1-only policy — no migration table yet, revisit when v2 lands.
 *
 * 2. **Shape validation**: confirms `id` is non-empty string and `messages` is an array.
 *    Each message must loosely match the plain-message shape. Throws on shape mismatch.
 *
 * 3. **Reconstruction**: builds a new `BHZAIConversationImpl`, restores `id`/`messages`/
 *    `usage`/`meta`/`params` from snapshot, re-attaches `append()`/`setContent()` methods
 *    (which throw if called on a reloaded message — documented as consistent with § 11.1's
 *    "legal only while state === 'before'" rule), and marks the conversation as already-
 *    started (`_markStarted()`, per TASK_0024) so `ensureStarted()` never fires `start`.
 *
 * 4. **Model re-resolution**: if `snapshot.model` is falsy or does not match a currently-
 *    registered model, fires `model.resolve` event with `{ catalogue, conversation }` and
 *    awaits a `{ model }` patch. If no handler supplies a usable model, propagates the
 *    failure mode documented by TASK_0022's resolution machinery (e.g., `NoModelError`).
 *    If nothing usable comes back, leaves the conversation's model unresolved (`undefined`),
 *    consistent with how `createConversation`'s own no-model branch already behaves.
 *
 * 5. **Fire `conversation.loaded`** via `conversation._fireLoaded(snapshot)` (already exists),
 *    never `conversation.created`. This fires through the shared mirroring mechanism.
 *
 * 6. Return the conversation.
 *
 * **Truncated-prefix support**: This function makes no assumption that `messages` is a
 * complete/untruncated history — it works identically for full snapshots and for truncated
 * prefixes (enabling host-side forking per § 11.5). No code path assumes the first message
 * is role `'user'`, assumes `messages.length` matches something external, or rejects a
 * short/truncated `messages` array.
 *
 * @param snapshot Untrusted snapshot data from storage (validated here)
 * @param bh The BHZAI instance (provides model registries and event bus)
 * @param options Creation options for the reconstructed conversation (optional, merged with snapshot state)
 * @returns A fully functional, live conversation ready for `sendMessage()` or other use
 * @throws On version mismatch (`v !== 1`), shape validation failure, or model resolution failure
 *
 * @internal
 */
export async function fromSnapshot(
	snapshot: unknown,
	bh: BHZAI,
	options?: CreateConversationOptions,
): Promise<BHZAIConversationImpl> {
	// =========================================================================
	// STEP 1: Version check
	// =========================================================================
	// Per TASK_0028's explicit v1-only policy, throw on any unrecognized version.
	// This is a deliberate decision, not a silently-assumed default: silently guessing
	// at an unknown shape risks corrupting conversation state in ways that are hard to detect.
	// Revisit the day v2 is introduced and implement a version-migration table.
	if (!snapshot || typeof snapshot !== "object") {
		throw new Error(`fromSnapshot: invalid snapshot — expected an object, got ${typeof snapshot}`)
	}

	const snapshotObj = snapshot as Record<string, unknown>
	const versionField = snapshotObj.v

	// Check version explicitly: must be exactly 1, no other versions supported.
	if (versionField !== 1) {
		throw new Error(
			`Unsupported ConversationSnapshot version: ${versionField} (only v1 is supported; no migrations exist yet)`,
		)
	}

	// =========================================================================
	// STEP 2: Shape validation
	// =========================================================================
	// Confirm `id` is a non-empty string and `messages` is an array.
	// Each message element must loosely match the plain-message shape (field-presence check).
	const id = snapshotObj.id
	const messages = snapshotObj.messages

	if (typeof id !== "string" || id.length === 0) {
		throw new Error("fromSnapshot: invalid snapshot — `id` must be a non-empty string")
	}

	if (!Array.isArray(messages)) {
		throw new Error("fromSnapshot: invalid snapshot — `messages` must be an array")
	}

	// Loose per-element shape check: each must have required fields
	for (let i = 0; i < messages.length; i++) {
		const msg = messages[i]
		if (
			!msg ||
			typeof msg !== "object" ||
			typeof (msg as Record<string, unknown>).id !== "string" ||
			typeof (msg as Record<string, unknown>).role !== "string" ||
			!Array.isArray((msg as Record<string, unknown>).blocks)
		) {
			throw new Error(
				`fromSnapshot: invalid snapshot — message[${i}] does not match PlainMessage shape`,
			)
		}
	}

	// =========================================================================
	// STEP 3: Reconstruction — build new conversation and restore state
	// =========================================================================
	const conversation = new (await import("./conversation.js")).BHZAIConversationImpl(bh, options)

	// Reconstruct via a new internal method `_restoreFromSnapshot()`:
	// Re-attaches `append()`/`setContent()` methods to plain messages.
	// These methods throw if called on a reloaded message, consistent with
	// § 11.1's "legal only while state === 'before'" rule.
	const plainMessages = messages as PlainMessage[]
	const messageFields = bh._getMessageFields()
	const restoredMessages: BHZAIMessage[] = plainMessages.map((plain) =>
		createMessageFromPlain(plain, messageFields),
	)

	conversation._restoreFromSnapshot({
		id,
		messages: restoredMessages,
		meta: (snapshotObj.meta as Record<string, unknown>) ?? {},
		usage: ((snapshotObj.usage as Record<string, unknown>) ?? {
			inputTokens: 0,
			outputTokens: 0,
		}) as { inputTokens: number; outputTokens: number },
		lastInputTokens: snapshotObj.lastInputTokens as number | undefined,
		lastOutputTokens: snapshotObj.lastOutputTokens as number | undefined,
		lastTotalTokens: snapshotObj.lastTotalTokens as number | undefined,
	})

	// Mark as loaded so ensureStarted() doesn't fire 'start' for a reloaded conversation.
	conversation._markStarted()

	// =========================================================================
	// STEP 4: Model re-resolution
	// =========================================================================
	const snapshotModel = snapshotObj.model as string | undefined
	const models = await bh.listModels()

	// Check if model is registered and available
	if (snapshotModel && snapshotModel !== "") {
		const modelExists = models.some((m) => m.ref === snapshotModel)
		if (modelExists) {
			// Model is available — use it directly
			conversation._setResolvedModel(snapshotModel)
		} else {
			// Model unavailable — fire model.resolve to get a substitute
			const catalogue = models
			const modelResolveResult = await bh._dispatch("model.resolve", {
				catalogue,
				conversation,
			})
			if (modelResolveResult.patch && "model" in modelResolveResult.patch) {
				const resolvedModel = modelResolveResult.patch.model as string | undefined
				conversation._setResolvedModel(resolvedModel)
			}
			// If no handler supplied a model, the conversation is left with no model (undefined)
		}
	} else {
		// Model field is empty/falsy — fire model.resolve to find one
		const catalogue = models
		const modelResolveResult = await bh._dispatch("model.resolve", {
			catalogue,
			conversation,
		})
		if (modelResolveResult.patch && "model" in modelResolveResult.patch) {
			const resolvedModel = modelResolveResult.patch.model as string | undefined
			conversation._setResolvedModel(resolvedModel)
		}
		// If no handler supplied a model, the conversation is left with no model (undefined)
	}

	// =========================================================================
	// STEP 5: Fire conversation.loaded event
	// =========================================================================
	// Fire via conversation._fireLoaded() using the shared mirroring mechanism.
	// Never fires conversation.created for a loaded conversation.
	// Pass the original snapshot object for reference equality (useful for event handlers
	// to verify the exact input), but cast it to the full type for type safety.
	await conversation._fireLoaded(snapshot as unknown as ConversationSnapshot)

	// =========================================================================
	// STEP 6: Return the fully functional conversation
	// =========================================================================
	return conversation
}

/**
 * Helper to reconstruct a full {@link BHZAIMessage} from a {@link PlainMessage}.
 *
 * Re-attaches the `append()` and `setContent()` methods. Since a reloaded message
 * is never in the `'before'` lifecycle state, these methods throw with a clear error
 * if called — consistent with § 11.1's "legal only while state === 'before'" rule.
 *
 * @param plain The plain-JSON message data
 * @returns A message object with methods attached
 *
 * @internal
 */
function createMessageFromPlain(plain: PlainMessage, fields?: MessageFieldRegistry): BHZAIMessage {
	// Fields are installed on reloaded messages too, so `message.think` (and any
	// plugin field) keeps reading the value persisted inside `meta`.
	return createMessage(
		{
			id: plain.id,
			role: plain.role,
			content: plain.content,
			blocks: plain.blocks,
			time: plain.time,
			meta: plain.meta,
		},
		fields,
		{ mutable: false },
	)
}
