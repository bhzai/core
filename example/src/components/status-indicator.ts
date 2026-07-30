/** @file The statusbar's dot + label as a reusable Lit element. */

import { LitElement, html } from "lit"
import { customElement, property } from "lit/decorators.js"

/** Lifecycle states the dot renders, via its `data-state` attribute. */
export type StatusState = "cold" | "warming" | "ready" | "generating"

/**
 * Status indicator custom element.
 *
 * Rendered in the light DOM so the host page's global styles (and CSS variables)
 * continue to drive its appearance.
 */
@customElement("bhzai-status-indicator")
export class BhzaiStatusIndicator extends LitElement {
	override createRenderRoot() {
		return this
	}

	@property({ type: String, reflect: true })
	state: StatusState = "cold"

	@property({ type: String })
	label = ""

	/** Set the dot's state and the text beside it. */
	set(state: StatusState, label: string): void {
		this.state = state
		this.label = label
	}

	override render() {
		return html`
			<span class="status-dot" data-state=${this.state}></span>
			<span class="status-label">${this.label}</span>
		`
	}
}

declare global {
	interface HTMLElementTagNameMap {
		"bhzai-status-indicator": BhzaiStatusIndicator
	}
}
