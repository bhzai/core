/** @file The conversation stream as a reusable Lit element. */

import { LitElement, html } from "lit"
import { customElement, state } from "lit/decorators.js"

interface UserMessage {
	kind: "user"
	text: string
}

interface AssistantMessage {
	kind: "assistant"
	thought: string
	answer: string
	hasThought: boolean
}

interface ErrorMessage {
	kind: "error"
	text: string
}

/**
 * A compaction marker inserted between messages.
 *
 * Shown when the conversation history was compacted (auto-compaction) or when
 * the user's message was prompt-compacted before sending. Gives the user a
 * visible signal that older context was summarized.
 */
interface CompactedMessage {
	kind: "compacted"
	/** Short label describing which compaction type fired. */
	label: string
}

type Message = UserMessage | AssistantMessage | ErrorMessage | CompactedMessage

/**
 * A handle on one in-flight assistant message.
 *
 * Mirrors the old imperative controller: the caller holds the object and the
 * methods close over the message's own state, so nothing has to look the
 * element back up by id on every delta.
 */
export interface AssistantTurn {
	/** Append reasoning text to the collapsible Thought region. */
	appendThought(delta: string): void
	/** Append answer text to the message body. */
	appendAnswer(delta: string): void
}

/**
 * Conversation-view custom element.
 *
 * Rendered in the light DOM so the host page's global styles (and CSS variables)
 * continue to drive its appearance. Deltas are streamed through the imperative
 * handles returned by {@link BhzaiConversation.beginAssistantTurn}.
 */
@customElement("bhzai-conversation")
export class BhzaiConversation extends LitElement {
	override createRenderRoot() {
		return this
	}

	@state()
	private _messages: Message[] = []

	private _emptyRemoved = false

	/** Add a user message bubble. */
	appendUserMessage(text: string): void {
		this.clearEmptyState()
		this._messages = [...this._messages, { kind: "user", text }]
	}

	/** Start a new assistant message and return a handle for streaming into it. */
	beginAssistantTurn(): AssistantTurn {
		this.clearEmptyState()
		const message: AssistantMessage = {
			kind: "assistant",
			thought: "",
			answer: "",
			hasThought: false,
		}
		this._messages = [...this._messages, message]

		const self = this
		return {
			appendThought(delta) {
				message.thought += delta
				message.hasThought = true
				self.requestUpdate()
			},
			appendAnswer(delta) {
				message.answer += delta
				self.requestUpdate()
			},
		}
	}

	/** Show a non-fatal, per-turn error inline, leaving the composer usable. */
	showTurnError(text: string): void {
		this._messages = [...this._messages, { kind: "error", text }]
	}

	/**
	 * Insert a compaction marker between messages.
	 *
	 * Called by the chat controller when a `compact` (conversation compaction)
	 * or `prompt_compactation` (single-message compaction) event fires, so the
	 * user can see that older context was summarized before the next turn.
	 *
	 * @param label - Short description of the compaction type
	 */
	appendCompactedMarker(label: string): void {
		this._messages = [...this._messages, { kind: "compacted", label }]
	}

	/** Remove the intro placeholder once the first turn begins. */
	clearEmptyState(): void {
		this._emptyRemoved = true
		this.requestUpdate()
	}

	/**
	 * Clear all displayed messages and reset to the empty state.
	 *
	 * Called when starting a new conversation or loading a past one — the
	 * old messages must not linger in the DOM.
	 */
	clear(): void {
		this._messages = []
		this._emptyRemoved = false
		this.requestUpdate()
	}

	/**
	 * Replay a snapshot's message history into the view.
	 *
	 * Used when loading a past conversation: the kernel's
	 * `loadConversation()` restores the conversation object, but the view is
	 * purely imperative — it only shows what was streamed into it. This
	 * method rebuilds the visible message list from the snapshot's
	 * `PlainMessage[]`, mapping `role` to the view's `UserMessage` /
	 * `AssistantMessage` shapes. System and tool messages are skipped (they
	 * are not part of the chat UI), except compaction-summary system messages
	 * which are rendered as compacted markers.
	 *
	 * @param messages - The snapshot's `messages` array (plain JSON objects).
	 */
	loadMessages(
		messages: Array<{
			role: "user" | "assistant" | "system" | "tool"
			content: string
			blocks: Array<{ type: string; text?: string; thought?: string }>
			meta?: Record<string, unknown>
		}>,
	): void {
		this.clear()
		for (const msg of messages) {
			if (msg.role === "user") {
				// Prompt-compacted user messages carry a `promptCompactionSummary` meta
				// flag — render them as a compacted marker instead of a normal bubble.
				if (msg.meta?.promptCompactionSummary) {
					this._messages = [...this._messages, { kind: "compacted", label: "prompt compacted" }]
				} else {
					this._messages = [...this._messages, { kind: "user", text: msg.content }]
				}
			} else if (msg.role === "assistant") {
				// The think splitter stores reasoning in `meta.think` (via the
				// `think` message field), not in a separate content block —
				// `ContentBlock` has no `thought` variant. The answer text lives
				// in `content` / `text` blocks as usual.
				const thought = typeof msg.meta?.think === "string" ? msg.meta.think : ""
				const hasThought = thought.length > 0
				let answer = msg.content
				if (msg.blocks && msg.blocks.length > 0) {
					const textBlocks = msg.blocks.filter((b) => b.type === "text")
					if (textBlocks.length > 0) {
						answer = textBlocks.map((b) => b.text ?? "").join("")
					}
				}
				this._messages = [...this._messages, { kind: "assistant", thought, answer, hasThought }]
			} else if (msg.role === "system" && msg.meta?.compactionSummary) {
				// Compaction-summary system messages are rendered as compacted markers.
				this._messages = [...this._messages, { kind: "compacted", label: "conversation compacted" }]
			}
			// Skip plain "system" and "tool" messages — not shown in the chat UI.
		}
		this._emptyRemoved = true
		this.requestUpdate()
	}

	override updated() {
		// Keep the newest content in view after every append.
		this.scrollTop = this.scrollHeight
	}

	override render() {
		return html`
			<div>
				${
					this._emptyRemoved
						? null
						: html`<div class="empty-state">No model loaded. Pick a model and send a message to warm it up.</div>`
				}
				${this._messages.map((message) => this._renderMessage(message))}
			</div>
		`
	}

	private _renderMessage(message: Message) {
		switch (message.kind) {
			case "user":
				return html`
					<div class="message user">
						<div class="message-answer">${message.text}</div>
					</div>
				`
			case "error":
				return html`<div class="message error" role="alert">${message.text}</div>`
			case "compacted":
				return html`
					<div class="message compacted" role="status">
						<span class="compacted-icon">⏷</span>
						<span class="compacted-label">${message.label}</span>
					</div>
				`
			case "assistant":
				return html`
					<div class="message assistant">
						${
							message.hasThought
								? html`
									<details class="message-thought" ?open=${false}>
										<summary>Thought</summary>
										<div class="message-thought-content">${message.thought}</div>
										<div class="message-divider"></div>
									</details>
							  `
								: null
						}
						<div class="message-answer">${message.answer}</div>
					</div>
				`
		}
	}
}

declare global {
	interface HTMLElementTagNameMap {
		"bhzai-conversation": BhzaiConversation
	}
}
