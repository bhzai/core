/** @file Conversations sidebar orchestration: list, load, delete, paginate.
 *
 * Owns no DOM. Everything visible happens through the
 * `<bhzai-conversation-list>` component passed in; everything kernel-related
 * goes through `bh.conversations` and the `idb-conversations.*` plugin events.
 * The controller NEVER touches IndexedDB directly — persistence is the
 * plugin's job, surfaced through the kernel accessor and the event bus.
 */

import type { BHZAI, ConversationSummary } from "@bhzai/core"
import { IdbConversationEvents } from "@bhzai/core/plugins/idb-conversations"
import type { BhzaiComposer } from "../components/composer.js"
import type { BhzaiConversationList } from "../components/conversation-list.js"
import type { BhzaiConversation } from "../components/conversation-view.js"
import type { ChatController } from "./chat-controller.js"

/** Everything the conversations controller drives. */
export interface ConversationsControllerDeps {
	/** The kernel, already initialized with the idb-conversations plugin. */
	bh: BHZAI
	/** UI custom elements. */
	ui: {
		conversationList: BhzaiConversationList
		conversation: BhzaiConversation
		composer: BhzaiComposer
	}
	/** The chat controller, for creating/loading conversations. */
	chat: ChatController
}

/**
 * Wire the conversation-list component to the kernel's conversations API
 * and the idb-conversations plugin's events.
 *
 * @param deps - Kernel, UI elements, and the chat controller.
 */
export function createConversationsController(deps: ConversationsControllerDeps) {
	const { bh, ui, chat } = deps

	/** Number of conversation summaries already loaded into the sidebar. */
	let currentOffset = 0

	/** Reload the first page and reset the offset. */
	async function reloadFirstPage(): Promise<void> {
		await bh.emit(IdbConversationEvents.loadPage, { offset: 0 })
	}

	// ── Plugin event subscriptions ────────────────────────────────────────

	// load.success: the plugin responds to list() and load-page with a page
	// of summaries. offset 0 replaces the list; any other offset appends.
	bh.on(IdbConversationEvents.loadSuccess, (payload: unknown) => {
		const p = payload as {
			conversations: ConversationSummary[]
			offset: number
			hasMore: boolean
		}
		if (p.offset === 0) {
			ui.conversationList.setConversations(p.conversations)
		} else {
			ui.conversationList.appendConversations(p.conversations)
		}
		currentOffset = p.offset + p.conversations.length
		ui.conversationList.setHasMore(p.hasMore)
	})

	// load.error: log and keep whatever the sidebar already shows.
	bh.on(IdbConversationEvents.loadError, (payload: unknown) => {
		const p = payload as { error: Error }
		console.error("Failed to load conversations page:", p.error)
	})

	// conversation.deleted: remove from the in-memory list immediately
	// (optimistic UI) and adjust the offset.
	bh.on(IdbConversationEvents.conversationDeleted, (payload: unknown) => {
		const p = payload as { id: string }
		ui.conversationList.removeConversation(p.id)
		if (currentOffset > 0) currentOffset--
	})

	// ── Kernel event subscriptions (trigger refreshes) ────────────────────

	// conversation.created: a new conversation was created — highlight it and
	// reload the first page so it appears at the top.
	bh.on("conversation.created", (payload: unknown) => {
		const p = payload as { conversation?: { id: string } }
		if (p.conversation?.id) {
			ui.conversationList.setActive(p.conversation.id)
		}
		void reloadFirstPage()
	})

	// conversation.loaded: a past conversation was loaded — highlight it.
	bh.on("conversation.loaded", (payload: unknown) => {
		const p = payload as { conversation?: { id: string } }
		if (p.conversation?.id) {
			ui.conversationList.setActive(p.conversation.id)
		}
	})

	// conversation.message(sent): auto-save just persisted — reload the first
	// page so updatedAt/messageCount refresh.
	bh.on("conversation.message", (payload: unknown) => {
		const p = payload as { state?: string }
		if (p.state === "sent") {
			void reloadFirstPage()
		}
	})

	// ── Component event wiring ────────────────────────────────────────────

	ui.conversationList.addEventListener("bhzai-new-conversation", () => {
		void chat.newConversation()
		ui.conversationList.clearActive()
	})

	ui.conversationList.addEventListener("bhzai-load-conversation", async (event) => {
		const id = (event as CustomEvent<{ id: string }>).detail?.id
		if (!id) return
		try {
			const snapshot = await bh.conversations.load(id)
			if (!snapshot) {
				console.error("Conversation not found:", id)
				return
			}
			const conv = await bh.loadConversation(snapshot)
			chat.setConversation(conv)
		} catch (error) {
			console.error("Failed to load conversation:", error)
		}
	})

	ui.conversationList.addEventListener("bhzai-delete-conversation", async (event) => {
		const id = (event as CustomEvent<{ id: string }>).detail?.id
		if (!id) return
		// Confirm before deleting.
		if (!confirm("Delete this conversation? This cannot be undone.")) return
		try {
			await bh.conversations.delete(id)
			// The conversationDeleted event handles UI removal.
			// If the deleted conversation was active, start a fresh one.
			if (chat.activeConversationId === id) {
				void chat.newConversation()
			}
		} catch (error) {
			console.error("Failed to delete conversation:", error)
		}
	})

	ui.conversationList.addEventListener("bhzai-load-more", () => {
		void bh.emit(IdbConversationEvents.loadPage, { offset: currentOffset })
	})

	return {
		/** Start the controller: request the first page of conversations. */
		async start(): Promise<void> {
			await reloadFirstPage()
		},
	}
}
