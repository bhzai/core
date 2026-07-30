/** @file The footer composer as a reusable Lit element. */

import { LitElement, html, nothing } from "lit"
import { customElement, property, query } from "lit/decorators.js"

/** Whether a turn is in flight. */
export type ComposerState = "idle" | "generating"

/** What the composer reports upward. */
export interface ComposerHandlers {
	/** The user submitted a non-empty message. */
	onSend(text: string): void
	/** The user pressed Stop during generation. */
	onStop(): void
}

/**
 * Message-composer custom element.
 *
 * Rendered in the light DOM so the host page's global styles (and CSS variables)
 * continue to drive its appearance.
 *
 * @fires bhzai-send - Dispatched when the user submits a non-empty message. Detail: `{ text: string }`.
 * @fires bhzai-stop - Dispatched when the user presses Stop while generating.
 */
@customElement("bhzai-composer")
export class BhzaiComposer extends LitElement {
	override createRenderRoot() {
		return this
	}

	@property({ type: String })
	placeholder = "Message the local model…"

	@property({ type: String, reflect: true })
	state: ComposerState = "idle"

	@query("textarea")
	private _input!: HTMLTextAreaElement

	private _handlers: ComposerHandlers | null = null

	/** Toggle between the idle (Send) and generating (Stop) presentations. */
	setState(state: ComposerState): void {
		this.state = state
	}

	/** Empty the textarea. */
	clear(): void {
		if (this._input) {
			this._input.value = ""
		}
	}

	/** Hide the composer entirely — used when a fatal error blocks interaction. */
	hide(): void {
		this.style.display = "none"
	}

	/** Attach the send/stop handlers. Called once, after the controllers exist. */
	wire(handlers: ComposerHandlers): void {
		this._handlers = handlers
	}

	override render() {
		const generating = this.state === "generating"
		const label = generating ? "Stop" : "Send"
		return html`
			<textarea
				id="composer-input"
				placeholder=${this.placeholder || nothing}
				rows="2"
				?disabled=${generating}
				@keydown=${this._onKeyDown}
			></textarea>
			<button
				type="button"
				id="composer-send"
				data-state=${generating ? "stop" : "send"}
				?disabled=${generating}
				@click=${this._onClick}
			>
				${label}
			</button>
		`
	}

	private _pendingText(): string | null {
		const text = this._input?.value.trim() ?? ""
		return text === "" ? null : text
	}

	private _onClick(): void {
		if (this.state === "generating") {
			this._handlers?.onStop()
			this.dispatchEvent(new CustomEvent("bhzai-stop", { bubbles: true, composed: true }))
			return
		}
		const text = this._pendingText()
		if (text) {
			this._handlers?.onSend(text)
			this.dispatchEvent(
				new CustomEvent("bhzai-send", { detail: { text }, bubbles: true, composed: true }),
			)
		}
	}

	private _onKeyDown(event: KeyboardEvent): void {
		// Enter without Shift sends; Shift+Enter keeps its newline.
		if (event.key !== "Enter" || event.shiftKey) return
		event.preventDefault()
		const text = this._pendingText()
		if (text) {
			this._handlers?.onSend(text)
			this.dispatchEvent(
				new CustomEvent("bhzai-send", { detail: { text }, bubbles: true, composed: true }),
			)
		}
	}
}

declare global {
	interface HTMLElementTagNameMap {
		"bhzai-composer": BhzaiComposer
	}
}
