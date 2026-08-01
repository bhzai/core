/** @file Reactive provider filter, sitting to the left of the model picker. */

import { LitElement, html } from "lit"
import { customElement, property } from "lit/decorators.js"

import "@lucasschirm/litjs-typeahead"
import { PROVIDER_LABELS, type ProviderKind } from "../lib/provider-store.js"

/** The value {@link BhzaiProviderSelect.selectedProvider} takes to mean "every provider". */
export const ALL_PROVIDERS = "all"

/** The label shown for {@link ALL_PROVIDERS} in the typeahead. */
const ALL_LABEL = "All"

/**
 * Human-readable label for a driver id.
 *
 * `PROVIDER_LABELS` (from `provider-store.ts`) only covers the addable local
 * HTTP kinds — `webllm` is deliberately excluded there since it is not one of
 * those, so it gets its own case here.
 *
 * @param driverId - A `ModelInfo.driver` value (e.g. `"webllm"`, `"ollama"`)
 * @returns The display label, falling back to the raw id for an unknown driver
 */
function driverLabel(driverId: string): string {
	if (driverId === "webllm") return "WebLLM"
	return PROVIDER_LABELS[driverId as ProviderKind] ?? driverId
}

/**
 * Custom element that wraps the same `<lit-typeahead>` the model picker uses,
 * filtering the model picker down to one provider's models. The host feeds it
 * the distinct `driver` ids present in the current model catalogue.
 *
 * @fires bhzai-change - Dispatched when the user selects a provider.
 *   Detail: `{ provider: string }` — a driver id, or `"all"`.
 */
@customElement("bhzai-provider-select")
export class BhzaiProviderSelect extends LitElement {
	override createRenderRoot() {
		return this
	}

	/** Distinct driver ids currently contributing to the model catalogue. */
	@property({ type: Array })
	providers: string[] = []

	/** Currently selected driver id, or `"all"` to show every provider's models. */
	@property({ type: String })
	selectedProvider: string = ALL_PROVIDERS

	/** Placeholder text for the empty picker. */
	@property({ type: String })
	placeholder = "Provider…"

	override render() {
		const items = [ALL_LABEL, ...this.providers.map(driverLabel)]
		const value =
			this.selectedProvider === ALL_PROVIDERS ? ALL_LABEL : driverLabel(this.selectedProvider)
		return html`
			<lit-typeahead
				class="provider-select"
				name="provider"
				.items=${items}
				.value=${value}
				.placeholder=${this.placeholder}
				@change=${this._onChange}
			></lit-typeahead>
		`
	}

	private _onChange(event: Event) {
		const value = (event as CustomEvent<{ value: string }>).detail?.value ?? ""
		const provider =
			value === "" || value === ALL_LABEL
				? ALL_PROVIDERS
				: (this.providers.find((id) => driverLabel(id) === value) ?? ALL_PROVIDERS)
		this.selectedProvider = provider
		this.dispatchEvent(
			new CustomEvent("bhzai-change", {
				detail: { provider },
				bubbles: true,
				composed: true,
			}),
		)
	}
}

declare global {
	interface HTMLElementTagNameMap {
		"bhzai-provider-select": BhzaiProviderSelect
	}
}
