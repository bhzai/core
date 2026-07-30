/** @file The weight-download progress panel as a reusable Lit element. */

import { LitElement, html, nothing } from "lit"
import { customElement, state } from "lit/decorators.js"
import { thermalColor } from "../lib/thermal.js"

/**
 * Cold-start panel custom element.
 *
 * Shows a download gauge while a model's weights are being fetched, then can be
 * hidden once the model is ready. Rendered in the light DOM so the host page's
 * global styles (and CSS variables) continue to drive its appearance.
 */
@customElement("bhzai-cold-start")
export class BhzaiColdStart extends LitElement {
	override createRenderRoot() {
		return this
	}

	@state()
	private _visible = false

	@state()
	private _progress = 0

	@state()
	private _text = ""

	/**
	 * Render download progress.
	 *
	 * @param progress - 0..1
	 * @param text - MLC's status line, e.g. "Fetching param cache 3/10"
	 */
	show(progress: number, text: string): void {
		this._progress = progress
		this._text = text
		this._visible = true
	}

	/** Remove the panel. */
	hide(): void {
		this._visible = false
	}

	override render() {
		if (!this._visible) return nothing
		const fill = thermalColor(this._progress)
		return html`
			<div class="telemetry-panel cold-start">
				<div class="telemetry-eyebrow">COLD START</div>
				<div class="gauge-container">
					<div class="gauge-bar">
						<div
							class="gauge-fill"
							style="width: ${this._progress * 100}%; background: ${fill}"
						></div>
					</div>
				</div>
				<div class="telemetry-subtext">
					downloading weights · ${Math.round(this._progress * 100)}%
				</div>
				<div class="telemetry-subtext cold-start-status">${this._text}</div>
			</div>
		`
	}
}

declare global {
	interface HTMLElementTagNameMap {
		"bhzai-cold-start": BhzaiColdStart
	}
}
