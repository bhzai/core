/** @file The MCP servers panel's list as a reusable Lit element. */

import type { McpServerState } from "@bhzai/core/plugins/mcp"
import { LitElement, html } from "lit"
import { customElement, property, state } from "lit/decorators.js"
import { classMap } from "lit/directives/class-map.js"
import { repeat } from "lit/directives/repeat.js"
import "./mcp-server-card.js"

type SortKey = "name" | "status"

/**
 * MCP server-list custom element.
 *
 * Renders the server cards, a filter box, and name/status sort buttons. Filtering
 * and sorting are done reactively inside the component, which keeps the DOM under
 * Lit's control and lets us preserve per-card state (like open tool disclosures)
 * across updates.
 *
 * Rendered in the light DOM so the host page's global styles (and CSS variables)
 * continue to drive its appearance.
 *
 * @fires bhzai-refresh - A server's refresh button was clicked. Detail: `{ id: string }`.
 * @fires bhzai-retry - A server's retry button was clicked. Detail: `{ id: string }`.
 * @fires bhzai-remove - A server's remove button was clicked. Detail: `{ id: string }`.
 * @fires bhzai-show-error - A server's error-inspection button was clicked. Detail: `{ id: string }`.
 */
@customElement("bhzai-mcp-server-list")
export class BhzaiMcpServerList extends LitElement {
	override createRenderRoot() {
		return this
	}

	@property({ type: Array })
	states: McpServerState[] = []

	@state()
	private _query = ""

	@state()
	private _sortKey: SortKey | null = null

	@state()
	private _sortAsc = true

	override render() {
		const total = this.states.length
		const visible = this._sortedFiltered()

		return html`
			<div class="mcp-servers">
				<div class="mcp-list-controls" ?hidden=${total === 0}>
					<input
						class="mcp-search"
						type="search"
						placeholder="filter servers…"
						.value=${this._query}
						@input=${this._onSearch}
						aria-label="Filter MCP servers"
						aria-controls="mcp-server-list"
					/>
					<div class="mcp-sort-group">
						<button
							type="button"
							class="mcp-sort ${classMap({
								asc: this._sortKey === "name" && this._sortAsc,
								desc: this._sortKey === "name" && !this._sortAsc,
							})}"
							data-sort="name"
							@click=${this._onSort}
						>
							name
						</button>
						<button
							type="button"
							class="mcp-sort ${classMap({
								asc: this._sortKey === "status" && this._sortAsc,
								desc: this._sortKey === "status" && !this._sortAsc,
							})}"
							data-sort="status"
							@click=${this._onSort}
						>
							status
						</button>
					</div>
				</div>

				<div class="mcp-list" id="mcp-server-list">
					${repeat(
						visible,
						(state) => state.id,
						(state) =>
							html`
								<bhzai-mcp-server-card
									class="mcp-server"
									.state=${state}
								></bhzai-mcp-server-card>
							`,
					)}
				</div>

				<p class="mcp-empty" ?hidden=${total > 0}>No servers attached.</p>
				<p class="mcp-empty" ?hidden=${visible.length > 0 || total === 0}>
					No servers match that filter.
				</p>
			</div>
		`
	}

	private _onSearch(event: Event): void {
		this._query = (event.target as HTMLInputElement).value
	}

	private _onSort(event: MouseEvent): void {
		const key = (event.target as HTMLElement).dataset.sort as SortKey
		if (this._sortKey === key) {
			this._sortAsc = !this._sortAsc
		} else {
			this._sortKey = key
			this._sortAsc = true
		}
	}

	private _sortedFiltered(): McpServerState[] {
		const needle = this._query.trim().toLowerCase()
		let visible = this.states

		if (needle) {
			visible = visible.filter((state) => {
				const toolNames = state.tools.map((tool) => tool.shortName).join(" ")
				const haystack = `${state.serverName}\t${state.status}\t${toolNames}`.toLowerCase()
				return haystack.includes(needle)
			})
		}

		if (this._sortKey) {
			visible = [...visible].sort((a, b) => {
				let left: string
				let right: string
				if (this._sortKey === "name") {
					left = a.serverName.toLowerCase()
					right = b.serverName.toLowerCase()
				} else {
					left = a.status
					right = b.status
				}
				if (left === right) return 0
				const order = left < right ? -1 : 1
				return this._sortAsc ? order : -order
			})
		}

		return visible
	}
}

declare global {
	interface HTMLElementTagNameMap {
		"bhzai-mcp-server-list": BhzaiMcpServerList
	}
}
