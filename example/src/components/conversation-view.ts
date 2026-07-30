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
