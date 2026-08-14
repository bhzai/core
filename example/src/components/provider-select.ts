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
				@input=${this._onInput}
			></lit-typeahead>
		`
	}

	/**
	 * Handle the `change` event from `lit-typeahead` (fires on blur).
	 *
	 * This is the fallback path: the native `<input>` `change` event fires when
	 * the user tabs away, and `lit-typeahead` re-dispatches it as a custom event
	 * with `detail.value`. The primary, immediate path is {@link _onInput}.
	 *
	 * @param event - The custom `change` event from `lit-typeahead`
	 */
	private _onChange(event: Event) {
		const value = (event as CustomEvent<{ value: string }>).detail?.value ?? ""
		this._applyValue(value)
	}

	/**
	 * Handle the `input` event (fires immediately on datalist selection).
	 *
	 * The native `input` event has `composed: true` by default, so it crosses
	 * `lit-typeahead`'s shadow DOM boundary. `event.target` is retargeted to
	 * the `<lit-typeahead>` host, but `composedPath()[0]` is the actual
	 * `<input>` element — that's where the live value lives, because
	 * `lit-typeahead` only syncs its own `value` property on `change` (blur),
	 * not on `input`.
	 *
	 * Only applies the filter when the typed/selected value matches a known
	 * provider label (or is empty/"All"). Partial matches leave the current
	 * filter in place so the model list doesn't flicker while the user types.
	 *
	 * @param event - The native `input` event, retargeted to `<lit-typeahead>`
	 */
	private _onInput(event: Event) {
		const input = event.composedPath()[0] as HTMLInputElement | undefined
		if (!input || input.tagName !== "INPUT") return
		this._applyValue(input.value, { partialMatchOk: true })
	}

	/**
	 * Map a display value to a provider id and dispatch `bhzai-change`.
	 *
	 * @param value - The input value to resolve
	 * @param partialMatchOk - When true, keep the current filter if `value`
	 *   doesn't match any known provider label (avoids flicker while typing).
	 */
	private _applyValue(value: string, options?: { partialMatchOk?: boolean }) {
		const provider =
			value === "" || value === ALL_LABEL
				? ALL_PROVIDERS
				: (this.providers.find((id) => driverLabel(id) === value) ?? null)

		if (provider === null) {
			// No match: if partial matches are OK (input event), keep the
			// current filter. Otherwise (change event on blur), fall back to
			// "All" so a stale partial value doesn't lock the user out.
			if (!options?.partialMatchOk && this.selectedProvider !== ALL_PROVIDERS) {
				this.selectedProvider = ALL_PROVIDERS
				this.dispatchEvent(
					new CustomEvent("bhzai-change", {
						detail: { provider: ALL_PROVIDERS },
						bubbles: true,
						composed: true,
					}),
				)
			}
			return
		}

		if (provider !== this.selectedProvider) {
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
}

declare global {
	interface HTMLElementTagNameMap {
		"bhzai-provider-select": BhzaiProviderSelect
	}
}
