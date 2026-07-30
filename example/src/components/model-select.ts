/** @file Reactive model picker that consumes a live `BHZAI` catalogue. */

import type { ModelInfo } from "@bhzai/core"
import { LitElement, html } from "lit"
import { customElement, property } from "lit/decorators.js"

import "@lucasschirm/litjs-typeahead"

/**
 * Custom element that wraps the external `<lit-typeahead>` with a reactive
 * `models` property. The host feeds it from `bh.listModels()` and the kernel's
 * model lifecycle events; it never touches DOM directly.
 *
 * @fires bhzai-change - Dispatched when the user selects a model.
 *   Detail: `{ model: ModelInfo, ref: string }`.
 */
@customElement("bhzai-model-select")
export class BhzaiModelSelect extends LitElement {
	override createRenderRoot() {
		return this
	}

	/** Live catalogue from the kernel. */
	@property({ type: Array })
	models: ModelInfo[] = []

	/** Bare id of the currently-selected model. */
	@property({ type: String })
	selectedModelId = ""

	/** Placeholder text for the empty picker. */
	@property({ type: String })
	placeholder = "Select a model…"

	/** The currently selected catalogue entry, or `undefined` if none. */
	get selectedModel(): ModelInfo | undefined {
		return this.models.find((m) => m.id === this.selectedModelId)
	}

	override render() {
		const items = this.models.map((m) => m.id)
		return html`
			<lit-typeahead
				class="model-select"
				name="model"
				.items=${items}
				.value=${this.selectedModelId}
				.placeholder=${this.placeholder}
				@change=${this._onChange}
			></lit-typeahead>
		`
	}

	private _onChange(event: Event) {
		const value = (event as CustomEvent<{ value: string }>).detail?.value ?? ""
		this.selectedModelId = value
		const model = this.selectedModel
		this.dispatchEvent(
			new CustomEvent("bhzai-change", {
				detail: { model, ref: model?.ref ?? "" },
				bubbles: true,
				composed: true,
			}),
		)
	}
}

declare global {
	interface HTMLElementTagNameMap {
		"bhzai-model-select": BhzaiModelSelect
	}
}
