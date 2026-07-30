/** @file The MCP panel's "Add HTTP server" form as a reusable Lit element. */

import { LitElement, html } from "lit"
import { customElement, query } from "lit/decorators.js"

/** Raw field values, unvalidated — parsing lives in `lib/mcp-store.ts`. */
export interface McpFormValues {
	/** The endpoint URL as typed. */
	url: string
	/** The optional bhzai-local server name as typed. */
	name: string
	/** The raw headers textarea contents, one `Key: Value` per line. */
	headersText: string
}

/**
 * MCP add-form custom element.
 *
 * Rendered in the light DOM so the host page's global styles (and CSS variables)
 * continue to drive its appearance.
 *
 * @fires bhzai-submit - Dispatched when the user submits the form. Call
 *   `event.preventDefault()` if you want to handle it entirely in JavaScript.
 */
@customElement("bhzai-mcp-add-form")
export class BhzaiMcpAddForm extends LitElement {
	override createRenderRoot() {
		return this
	}

	@query("input[name=url]")
	private _url!: HTMLInputElement

	@query("input[name=name]")
	private _name!: HTMLInputElement

	@query("textarea[name=headers]")
	private _headers!: HTMLTextAreaElement

	@query("button[type=submit]")
	private _submit!: HTMLButtonElement

	@query("p[role=alert]")
	private _error!: HTMLParagraphElement

	private _onSubmitHandler: (() => void) | null = null

	/** Read the current field values. */
	values(): McpFormValues {
		return {
			url: this._url.value,
			name: this._name.value,
			headersText: this._headers.value,
		}
	}

	/** Disable the fields and relabel the submit button while connecting. */
	setBusy(busy: boolean): void {
		this._submit.disabled = busy
		this._submit.textContent = busy ? "Connecting…" : "Connect"
		this._url.disabled = busy
		this._name.disabled = busy
		this._headers.disabled = busy
	}

	/** Show a validation or connection error above the submit button. */
	showError(message: string): void {
		this._error.textContent = message
		this._error.hidden = false
	}

	/** Clear the error line. */
	clearError(): void {
		this._error.textContent = ""
		this._error.hidden = true
	}

	/** Clear the fields and collapse the disclosure. */
	reset(): void {
		const form = this.querySelector("form")
		form?.reset()
		this.clearError()
		const details = this.querySelector("details")
		if (details) details.open = false
	}

	/** Register the submit handler. Called once, after the controllers exist. */
	onSubmit(handler: () => void): void {
		this._onSubmitHandler = handler
	}

	override render() {
		return html`
			<details class="mcp-add">
				<summary>Add HTTP server</summary>
				<form @submit=${this._onSubmit} novalidate>
					<label class="mcp-field">
						<span>Endpoint URL</span>
						<input
							name="url"
							type="url"
							required
							autocomplete="off"
							spellcheck="false"
							placeholder="https://example.com/mcp"
						/>
					</label>

					<label class="mcp-field">
						<span>Name <em>optional</em></span>
						<input
							name="name"
							type="text"
							autocomplete="off"
							spellcheck="false"
							placeholder="derived from the hostname"
						/>
					</label>

					<label class="mcp-field">
						<span>Headers <em>optional</em></span>
						<textarea
							name="headers"
							rows="2"
							spellcheck="false"
							placeholder="Authorization: Bearer …"
						></textarea>
					</label>

					<p class="mcp-note">
						Saved in this browser's localStorage, headers included — don't paste a
						token you wouldn't leave on disk.
					</p>

					<p class="mcp-form-error" role="alert" hidden></p>

					<button type="submit">Connect</button>
				</form>
			</details>
		`
	}

	private _onSubmit(event: SubmitEvent): void {
		event.preventDefault()
		this.dispatchEvent(new CustomEvent("bhzai-submit", { bubbles: true, composed: true }))
		this._onSubmitHandler?.()
	}
}

declare global {
	interface HTMLElementTagNameMap {
		"bhzai-mcp-add-form": BhzaiMcpAddForm
	}
}
