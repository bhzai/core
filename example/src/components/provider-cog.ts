/** @file The status bar's providers cog button as a reusable Lit element. */

import { LitElement, html } from "lit"
import { customElement } from "lit/decorators.js"

/**
 * Providers cog custom element.
 *
 * A single icon button that opens the providers panel. Rendered in the light
 * DOM so the host page's global styles (and CSS variables) continue to drive
 * its appearance. No state — it just dispatches an event the controller owns.
 *
 * @fires bhai-open-providers - Dispatched when the cog is clicked. No detail.
 */
@customElement("bhai-provider-cog")
export class BhaiProviderCog extends LitElement {
	override createRenderRoot() {
		return this
	}

	override render() {
		return html`
			<button
				type="button"
				class="provider-cog"
				aria-label="Providers"
				title="Providers"
				@click=${this._onClick}
			>
				⚙
			</button>
		`
	}

	private _onClick(): void {
		this.dispatchEvent(new CustomEvent("bhai-open-providers", { bubbles: true, composed: true }))
	}
}

declare global {
	interface HTMLElementTagNameMap {
		"bhai-provider-cog": BhaiProviderCog
	}
}
