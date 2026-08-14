/** @file The left-rail conversation list as a reusable Lit element. */

import type { ConversationSummary } from "@bhzai/core"
import { LitElement, html, nothing } from "lit"
import { customElement, state } from "lit/decorators.js"
import { formatRelativeTime } from "../lib/format.js"

/**
 * Conversation-list custom element.
 *
 * Rendered in the light DOM so the host page's global styles (and CSS
 * variables) continue to drive its appearance. The list is populated
 * imperatively by the conversations controller via {@link setConversations}
 * / {@link appendConversations}; user actions (new, load, delete, load-more)
 * are dispatched as custom events the controller listens for.
 *
 * @fires bhzai-new-conversation - Dispatched when the user clicks "New".
 * @fires bhzai-load-conversation - Dispatched when the user clicks a
 *   conversation item. Detail: `{ id: string }`.
 * @fires bhzai-delete-conversation - Dispatched when the user clicks a
 *   conversation's delete button. Detail: `{ id: string }`.
 * @fires bhzai-load-more - Dispatched when the user clicks "Load more".
 */
@customElement("bhzai-conversation-list")
export class BhzaiConversationList extends LitElement {
	override createRenderRoot() {
		return this
	}

	@state()
	private _conversations: ConversationSummary[] = []

	@state()
	private _activeId: string | null = null

	@state()
	private _hasMore = false

	/** Replace the entire list (used on first-page load and refreshes). */
	setConversations(summaries: ConversationSummary[]): void {
		this._conversations = summaries
	}

	/** Append a page to the existing list (used for "Load more"). */
	appendConversations(summaries: ConversationSummary[]): void {
		this._conversations = [...this._conversations, ...summaries]
	}

	/** Mark a conversation as the active one (highlighted in the UI). */
	setActive(id: string): void {
		this._activeId = id
	}

	/** Clear the active highlight (e.g., when starting a new conversation). */
	clearActive(): void {
		this._activeId = null
	}

	/** Set whether the "Load more" button should be visible. */
	setHasMore(hasMore: boolean): void {
		this._hasMore = hasMore
	}

	/** Remove a single conversation from the in-memory list (optimistic delete). */
	removeConversation(id: string): void {
		this._conversations = this._conversations.filter((c) => c.id !== id)
		if (this._activeId === id) this._activeId = null
	}

	/** Derive a display title from the summary, falling back to a placeholder. */
	private _title(summary: ConversationSummary): string {
		return summary.title || "New conversation"
	}

	override render() {
		return html`
			<div class="conversation-list-header">
				<span class="conversation-list-title">Conversations</span>
				<button
					type="button"
					class="conversation-list-new-btn"
					aria-label="Start a new conversation"
					@click=${() => this._dispatch("bhzai-new-conversation", null)}
				>
					New
				</button>
			</div>
			<ol class="conversation-list-items" role="list">
				${this._conversations.map(
					(c) => html`
						<li
							class="conversation-list-item ${this._activeId === c.id ? "active" : ""}"
							role="listitem"
							aria-current=${this._activeId === c.id ? "true" : nothing}
						>
							<button
								type="button"
								class="conversation-list-item-btn"
								@click=${() => this._dispatch("bhzai-load-conversation", { id: c.id })}
								aria-label="Load conversation: ${this._title(c)}"
							>
								<span class="conversation-list-item-title">${this._title(c)}</span>
								<span class="conversation-list-item-meta">
									${formatRelativeTime(c.updatedAt)} · ${c.messageCount} msg
								</span>
							</button>
							<button
								type="button"
								class="conversation-list-item-delete"
								aria-label="Delete conversation: ${this._title(c)}"
								@click=${(e: Event) => {
									e.stopPropagation()
									this._dispatch("bhzai-delete-conversation", { id: c.id })
								}}
							>
								×
							</button>
						</li>
					`,
				)}
			</ol>
			${
				this._hasMore
					? html`
					<button
						type="button"
						class="conversation-list-load-more"
						@click=${() => this._dispatch("bhzai-load-more", null)}
					>
						Load more
					</button>
				`
					: nothing
			}
		`
	}

	/** Dispatch a custom event with an optional detail. */
	private _dispatch(name: string, detail: unknown): void {
		this.dispatchEvent(new CustomEvent(name, { detail, bubbles: true, composed: true }))
	}
}

declare global {
	interface HTMLElementTagNameMap {
		"bhzai-conversation-list": BhzaiConversationList
	}
}
