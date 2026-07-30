/** @file The native `<dialog>` inspector for a failed MCP connection as a Lit element. */

import type { McpServerError } from "@bhzai/core/plugins/mcp"
import { LitElement, html } from "lit"
import { customElement, property, query } from "lit/decorators.js"
import { errorHint } from "../lib/mcp-store.js"

/**
 * MCP error-dialog custom element.
 *
 * Rendered in the light DOM so the host page's global styles (and CSS variables)
 * continue to drive its appearance, and so the native `<dialog>` `showModal()`
 * participates in the top-level document.
 */
@customElement("bhzai-mcp-error-dialog")
export class BhzaiMcpErrorDialog extends LitElement {
	override createRenderRoot() {
		return this
	}

	@property({ type: Object })
	error: McpServerError | null = null

	@query("dialog")
	private _dialog!: HTMLDialogElement

	/** Open the dialog populated with one server's captured error. */
	show(error: McpServerError): void {
		this.error = error
		this._dialog.showModal()
	}

	/** Close the dialog. */
	hide(): void {
		this._dialog.close()
	}

	override render() {
		const error = this.error
		const explanation = error ? errorHint(error) : null
		return html`
			<dialog class="mcp-error-dialog" aria-labelledby="mcp-error-title">
				<header>
					<h2 id="mcp-error-title">Connection error</h2>
					<button
						type="button"
						aria-label="Close error details"
						@click=${this.hide}
					>
						✕
					</button>
				</header>
				${
					error
						? html`
							<dl class="mcp-error-meta">
								<dt>Error</dt>
								<dd>${error.name}</dd>
								<dt>Endpoint</dt>
								<dd>${error.url}</dd>
								<dt>When</dt>
								<dd>${new Date(error.at).toLocaleTimeString()}</dd>
							</dl>
							<p class="mcp-error-message">${error.message}</p>
							<p class="mcp-error-hint" ?hidden=${explanation === null}>${explanation}</p>
							<details class="mcp-error-stack" ?hidden=${!error.stack}>
								<summary>Stack trace</summary>
								<pre>${error.stack ?? ""}</pre>
							</details>
					  `
						: null
				}
			</dialog>
		`
	}
}

declare global {
	interface HTMLElementTagNameMap {
		"bhzai-mcp-error-dialog": BhzaiMcpErrorDialog
	}
}
