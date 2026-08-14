/** @file Kernel-side storage wiring (TASK_0029) — auto-save on message(sent) and bh.conversations accessor */

import type { ConversationSnapshot } from "../conversation/snapshot.js"
import type { ConversationStore, ConversationSummary } from "../types/storage.js"
import type { BHZAI } from "./bhzai.js"
import type { BHZAIPlugin } from "./bhzai.js"

/**
 * Find the active (last-registered-wins) ConversationStore among the given plugins.
 *
 * POLICY NOTE: If multiple plugins register a `conversationStore` capability,
 * only the LAST one (by registration order) becomes the active store. This is
 * consistent with the "last-registration-wins" shadowing convention used
 * elsewhere in the codebase (tools, drivers). This explicit policy is documented
 * here since § 11.4 does not address multiple stores.
 *
 * @param plugins Array of normalized plugins in `use()` registration order.
 * @returns The last-registered `conversationStore` capability, or `undefined` if none found.
 * @internal
 */
export function resolveActiveConversationStore(
	plugins: readonly BHZAIPlugin[],
): ConversationStore | undefined {
	let activeStore: ConversationStore | undefined
	for (const plugin of plugins) {
		if (plugin.capabilities?.conversationStore) {
			activeStore = plugin.capabilities.conversationStore
		}
	}
	return activeStore
}

/**
 * Wire up auto-save subscription on the BHZAI framework bus.
 *
 * When a `ConversationStore` is registered (not undefined), this function
 * subscribes to the framework-level `bh.on('conversation.message', handler)`
 * event (which, via TASK_0023's mirroring, observes every conversation created
 * or loaded by this kernel instance). The handler:
 *
 * 1. Checks if `state === 'sent'`.
 * 2. If true, calls `store.save(conversation.toJSON())`.
 * 3. If false or any other state, returns (no-op).
 *
 * This is a single subscription per kernel instance, not per conversation, so it
 * observes all conversations automatically via the mirroring mechanism.
 *
 * If NO `ConversationStore` is registered, this function is a no-op and no
 * subscription is created.
 *
 * ASYNC ORDERING: auto-save does not await the `store.save()` promise — it
 * fires and forgets. If save fails, the error is not propagated to the kernel
 * or the conversation; logs or error tracking are the host's concern.
 *
 * @param bh The BHZAI kernel instance.
 * @param store The active `ConversationStore` capability (if any).
 * @internal
 */
export function wireAutoSave(bh: BHZAI, store: ConversationStore | undefined): void {
	if (!store) {
		// No store registered — auto-save is a no-op. Do not create any subscription.
		return
	}

	// Subscribe to the framework-level message event. The payload includes both
	// `state` and `conversation`, as documented in TASK_0025.
	bh.on("conversation.message", (payload: unknown) => {
		const p = payload as { state?: string; conversation?: { toJSON?: () => unknown } }
		if (p.state !== "sent" || !p.conversation || !p.conversation.toJSON) {
			return
		}

		// Call store.save() with the full current snapshot. Fire and forget —
		// errors are not propagated. Each message(sent) triggers one save.
		void store.save(p.conversation.toJSON() as Parameters<ConversationStore["save"]>[0])
	})
}

/**
 * The `bh.conversations` accessor object — provides query access to stored conversations.
 *
 * This object is set on the BHZAI instance during `init()` and provides a single method:
 * - `list(query?)`: delegates to the registered `ConversationStore.list()` (if present),
 *   or throws a descriptive error if no store is registered.
 *
 * The error-on-missing-store policy is intentional and documented: a host calling
 * `bh.conversations.list()` with no store registered almost certainly has a
 * configuration bug (forgot to wire persistence), and failing loudly surfaces this
 * immediately during development rather than silently returning a misleading empty array.
 *
 * @internal
 */
export interface ConversationsAccessor {
	/**
	 * List stored conversations.
	 *
	 * Delegates directly to the registered `ConversationStore.list()` if one exists,
	 * forwarding the `query` argument unchanged.
	 *
	 * @param query Optional filtering: `limit` (max results), `before` (cursor).
	 * @returns Array of {@link ConversationSummary} objects.
	 * @throws If no `ConversationStore` is registered, throws with message matching `/no conversationStore/i`.
	 */
	list(query?: { limit?: number; before?: number }): Promise<ConversationSummary[]>

	/**
	 * Load a stored conversation's full snapshot by id.
	 *
	 * Delegates directly to the registered `ConversationStore.load()` if one
	 * exists. The returned snapshot can be passed to
	 * {@link BHZAI.loadConversation} to reconstruct a live conversation.
	 *
	 * @param id The conversation's unique identifier.
	 * @returns The snapshot if found, `undefined` if not found.
	 * @throws If no `ConversationStore` is registered, throws with message matching `/no conversationStore/i`.
	 */
	load(id: string): Promise<ConversationSnapshot | undefined>

	/**
	 * Delete a stored conversation by id.
	 *
	 * Delegates directly to the registered `ConversationStore.delete()` if one
	 * exists. A missing id is treated as a no-op by the store (per the
	 * {@link ConversationStore.delete} contract).
	 *
	 * @param id The conversation's unique identifier.
	 * @throws If no `ConversationStore` is registered, throws with message matching `/no conversationStore/i`.
	 */
	delete(id: string): Promise<void>
}

/**
 * Create the `bh.conversations` accessor object.
 *
 * This factory is called once from `BHZAI.init()` after storage resolution is complete.
 * It captures the active `ConversationStore` (if any) and returns an accessor that
 * delegates `list()` calls to it, or throws if the store is missing.
 *
 * @param store The active `ConversationStore`, or `undefined` if none is registered.
 * @returns The `ConversationsAccessor` object.
 * @internal
 */
export function createConversationsAccessor(
	store: ConversationStore | undefined,
): ConversationsAccessor {
	const noStoreError = (op: string) =>
		new Error(
			`bh.conversations.${op}(): no conversationStore is registered. Did you forget to pass a plugin with conversationStore capability to bh.use()?`,
		)
	return {
		async list(query?: { limit?: number; before?: number }): Promise<ConversationSummary[]> {
			if (!store) throw noStoreError("list")
			// Delegate to the store, forwarding the query unchanged.
			return store.list(query)
		},
		async load(id: string): Promise<ConversationSnapshot | undefined> {
			if (!store) throw noStoreError("load")
			return store.load(id)
		},
		async delete(id: string): Promise<void> {
			if (!store) throw noStoreError("delete")
			return store.delete(id)
		},
	}
}
