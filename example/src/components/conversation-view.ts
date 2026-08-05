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

type Message = UserMessage | AssistantMessage | ErrorMessage

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
	 * are not part of the chat UI).
	 *
	 * @param messages - The snapshot's `messages` array (plain JSON objects).
	 */
	loadMessages(
		messages: Array<{
			role: "user" | "assistant" | "system" | "tool"
			content: string
			blocks: Array<{ type: string; text?: string; thought?: string }>
		}>,
	): void {
		this.clear()
		for (const msg of messages) {
			if (msg.role === "user") {
				this._messages = [...this._messages, { kind: "user", text: msg.content }]
			} else if (msg.role === "assistant") {
				// Extract thought (reasoning) and answer from content blocks.
				// The snapshot stores `content` as the full text; blocks carry
				// the structured split. Fall back to `content` if no blocks.
				let thought = ""
				let answer = msg.content
				let hasThought = false
				if (msg.blocks && msg.blocks.length > 0) {
					const textBlocks = msg.blocks.filter((b) => b.type === "text")
					const thoughtBlocks = msg.blocks.filter((b) => b.type === "thought")
					if (thoughtBlocks.length > 0) {
						thought = thoughtBlocks.map((b) => b.text ?? "").join("")
						hasThought = true
					}
					if (textBlocks.length > 0) {
						answer = textBlocks.map((b) => b.text ?? "").join("")
					}
				}
				this._messages = [...this._messages, { kind: "assistant", thought, answer, hasThought }]
			}
			// Skip "system" and "tool" messages — not shown in the chat UI.
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
