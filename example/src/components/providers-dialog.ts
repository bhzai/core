/**
 * @file The providers panel modal as a reusable Lit element.
 *
 * A positioned overlay (not a native `<dialog>`, so it can be styled with the
 * page's CSS variables without fighting the UA shadow) with three views:
 * list, add, and edit. Every text binding is escaped by lit-html, so a
 * provider's base URL or error message — both user/remote-controlled — can
 * never inject markup. See `providers-dialog.test.ts` for the guard.
 *
 * Rendered in the light DOM so the host page's global styles (and CSS
 * variables) continue to drive its appearance.
 */

import { LitElement, html } from "lit"
import { customElement, property, query, state } from "lit/decorators.js"

import "@lucasschirm/litjs-typeahead"
import { DEFAULT_OLLAMA_API } from "../lib/provider-store.js"

/** The connection status a provider row renders, via its `data-state`. */
export type ProviderStatus = "connected" | "error" | "connecting"

/** One row in the providers list. */
export interface ProviderViewState {
	/** Stable id; matches the persisted `OllamaProviderConfig.id` for ollama rows. */
	id: string
	/** The provider kind. `webllm` is the always-on built-in. */
	kind: "webllm" | "ollama"
	/** Human-readable label. */
	label: string
	/** Connection status driving the dot color. */
	status: ProviderStatus
	/** Optional error text shown on error rows. */
	error?: string
	/** Optional bearer token (ollama rows only), pre-filled in the edit view. */
	token?: string
}

/** The three views the dialog cycles through. */
type DialogView = "list" | "add" | "edit"

/**
 * Providers dialog custom element.
 *
 * @fires bhai-add-provider - The add form was submitted. Detail: `{ type: 'ollama', baseUrl, token }`.
 * @fires bhai-update-provider - The edit form was submitted. Detail: `{ id, baseUrl, token }`.
 * @fires bhai-remove-provider - The edit form's remove button was clicked. Detail: `{ id }`.
 */
@customElement("bhai-providers-dialog")
export class BhaiProvidersDialog extends LitElement {
	override createRenderRoot() {
		return this
	}

	/** The provider rows the list view renders. */
	@property({ type: Array })
	providers: ProviderViewState[] = []

	/** Which view is active. */
	@state()
	private _view: DialogView = "list"

	/** The id of the provider being edited (edit view only). */
	@state()
	private _editId = ""

	/** Inline error text for the current form view. */
	@state()
	private _error = ""

	/** Whether the form buttons/inputs are disabled while connecting. */
	@state()
	private _busy = false

	@query("input[name=api-url]")
	private _apiUrl!: HTMLInputElement

	@query("input[name=api-token]")
	private _apiToken!: HTMLInputElement

	@query("button.provider-connect")
	private _connectButton!: HTMLButtonElement

	@query("p[role=alert]")
	private _errorLine!: HTMLParagraphElement

	/** Make the dialog visible and reset to the list view. */
	show(): void {
		this._view = "list"
		this._error = ""
		this._busy = false
		this.setAttribute("open", "")
	}

	/** Hide the dialog. */
	hide(): void {
		this.removeAttribute("open")
	}

	/** Replace the provider rows and re-render. */
	setProviders(list: ProviderViewState[]): void {
		this.providers = list
	}

	/** Switch to the add view with fresh fields. */
	showAddView(): void {
		this._view = "add"
		this._editId = ""
		this._error = ""
		this._busy = false
	}

	/** Switch to the edit view for a given provider id, pre-filling its fields. */
	showEditView(id: string): void {
		this._view = "edit"
		this._editId = id
		this._error = ""
		this._busy = false
	}

	/** Show an inline error line in the current form view. */
	showError(message: string): void {
		this._error = message
	}

	/** Clear the inline error line. */
	clearError(): void {
		this._error = ""
	}

	/** Disable the form buttons and inputs while a connection is in flight. */
	setBusy(busy: boolean): void {
		this._busy = busy
	}

	override render() {
		return html`
			<div class="providers-dialog-backdrop" @click=${this._onBackdrop}></div>
			<div class="providers-dialog" role="dialog" aria-modal="true" aria-label="Providers">
				${this._renderView()}
			</div>
		`
	}

	private _renderView() {
		if (this._view === "add") return this._renderAdd()
		if (this._view === "edit") return this._renderEdit()
		return this._renderList()
	}

	private _renderList() {
		const builtIn: ProviderViewState = {
			id: "webllm",
			kind: "webllm",
			label: "WebLLM (built-in)",
			status: "connected",
		}
		const rows = [builtIn, ...this.providers]
		return html`
			<header class="providers-header">
				<h2>Providers</h2>
				<button type="button" class="providers-close" aria-label="Close" @click=${this.hide}>
					✕
				</button>
			</header>
			<ul class="provider-list">
				${rows.map((row) => this._renderRow(row))}
			</ul>
			<button type="button" class="provider-add" @click=${this.showAddView}>
				Add provider
			</button>
		`
	}

	private _renderRow(row: ProviderViewState) {
		const clickable = row.kind === "ollama"
		return html`
			<li
				class="provider-row"
				data-kind=${row.kind}
				data-state=${row.status}
				?data-clickable=${clickable}
				@click=${clickable ? () => this.showEditView(row.id) : undefined}
			>
				<span class="provider-dot" data-state=${row.status}></span>
				<span class="provider-label">${row.label}</span>
			</li>
		`
	}

	private _renderAdd() {
		return html`
			<header class="providers-header">
				<h2>Add provider</h2>
				<button type="button" class="providers-close" aria-label="Close" @click=${this.hide}>
					✕
				</button>
			</header>
			<form class="provider-form" @submit=${this._onAddSubmit} novalidate>
				<label class="provider-field">
					<span>Type</span>
					<lit-typeahead
						class="provider-typeahead"
						name="provider-type"
						.items=${["ollama"]}
						.value=${"ollama"}
						selectFirst
					></lit-typeahead>
				</label>
				${this._renderFields(DEFAULT_OLLAMA_API, "")}
				<p class="provider-form-error" role="alert" ?hidden=${!this._error}>${this._error}</p>
				<div class="provider-actions">
					<button type="button" ?disabled=${this._busy} @click=${() => this._back()}>
						Back
					</button>
					<button type="submit" class="provider-connect" ?disabled=${this._busy}>
						${this._busy ? "Connecting…" : "Connect"}
					</button>
				</div>
			</form>
		`
	}

	private _renderEdit() {
		const existing = this.providers.find((p) => p.id === this._editId)
		const apiUrl = existing?.label ?? DEFAULT_OLLAMA_API
		const apiToken = existing?.token ?? ""
		return html`
			<header class="providers-header">
				<h2>Edit provider</h2>
				<button type="button" class="providers-close" aria-label="Close" @click=${this.hide}>
					✕
				</button>
			</header>
			<form class="provider-form" @submit=${this._onEditSubmit} novalidate>
				${this._renderFields(apiUrl, apiToken)}
				<p class="provider-form-error" role="alert" ?hidden=${!this._error}>${this._error}</p>
				<div class="provider-actions">
					<button type="button" ?disabled=${this._busy} @click=${() => this._back()}>
						Back
					</button>
					<button
						type="button"
						class="provider-remove"
						?disabled=${this._busy}
						@click=${this._onRemove}
					>
						Remove
					</button>
					<button type="submit" class="provider-connect" ?disabled=${this._busy}>
						${this._busy ? "Connecting…" : "Connect"}
					</button>
				</div>
			</form>
		`
	}

	private _renderFields(apiUrl: string, apiToken: string) {
		return html`
			<label class="provider-field">
				<span>Ollama API address</span>
				<input
					name="api-url"
					type="url"
					.value=${apiUrl}
					autocomplete="off"
					spellcheck="false"
					placeholder=${DEFAULT_OLLAMA_API}
					?disabled=${this._busy}
				/>
			</label>
			<label class="provider-field">
				<span>API token <em>optional</em></span>
				<input
					name="api-token"
					type="password"
					.value=${apiToken}
					autocomplete="off"
					spellcheck="false"
					placeholder="optional"
					?disabled=${this._busy}
				/>
			</label>
		`
	}

	private _back(): void {
		this._view = "list"
		this._error = ""
		this._busy = false
	}

	private _onBackdrop(): void {
		this.hide()
	}

	private _onAddSubmit(event: SubmitEvent): void {
		event.preventDefault()
		const baseUrl = this._apiUrl.value
		const token = this._apiToken.value
		this.dispatchEvent(
			new CustomEvent("bhai-add-provider", {
				detail: { type: "ollama", baseUrl, token },
				bubbles: true,
				composed: true,
			}),
		)
	}

	private _onEditSubmit(event: SubmitEvent): void {
		event.preventDefault()
		const baseUrl = this._apiUrl.value
		const token = this._apiToken.value
		this.dispatchEvent(
			new CustomEvent("bhai-update-provider", {
				detail: { id: this._editId, baseUrl, token },
				bubbles: true,
				composed: true,
			}),
		)
	}

	private _onRemove(): void {
		this.dispatchEvent(
			new CustomEvent("bhai-remove-provider", {
				detail: { id: this._editId },
				bubbles: true,
				composed: true,
			}),
		)
	}
}

declare global {
	interface HTMLElementTagNameMap {
		"bhai-providers-dialog": BhaiProvidersDialog
	}
}
