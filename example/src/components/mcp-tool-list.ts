/** @file One connected server's collapsible, filterable tool list as a Lit element. */

import type { McpServerTool } from "@bhzai/core/plugins/mcp"
import { LitElement, html } from "lit"
import { customElement, property, state } from "lit/decorators.js"

/** Tool count above which a filter box appears. */
const FILTER_THRESHOLD = 8

/**
 * MCP tool-list custom element.
 *
 * Rendered in the light DOM so the host page's global styles (and CSS variables)
 * continue to drive its appearance.
 */
@customElement("bhzai-mcp-tool-list")
export class BhzaiMcpToolList extends LitElement {
	override createRenderRoot() {
		return this
	}

	@property({ type: String })
	serverName = ""

	@property({ type: Array })
	tools: McpServerTool[] = []

	@state()
	private _expanded = false

	@state()
	private _query = ""

	override render() {
		const count = this.tools.length
		const filterable = count > FILTER_THRESHOLD
		const needle = this._query.trim().toLowerCase()
		const visible = filterable
			? this.tools.filter(
					(tool) =>
						tool.shortName.toLowerCase().includes(needle) ||
						tool.description.toLowerCase().includes(needle),
				)
			: this.tools

		return html`
			<div>
				<details
					class="mcp-tools"
					?open=${this._expanded}
					@toggle=${this._onToggle}
				>
					<summary>${count === 1 ? "1 tool" : `${count} tools`}</summary>
					${
						filterable
							? html`
								<input
									class="mcp-search"
									type="search"
									placeholder="filter tools…"
									.value=${this._query}
									@input=${this._onSearch}
									aria-label=${`Filter tools for ${this.serverName}`}
								/>
						  `
							: null
					}
					<ul class="mcp-tool-list">
						${visible.map(
							(tool) => html`
								<li class="mcp-tool">
									<code>${tool.shortName}</code>
									${
										tool.description
											? html`<span class="mcp-tool-description">${tool.description}</span>`
											: null
									}
								</li>
							`,
						)}
					</ul>
					${
						filterable
							? html`<p class="mcp-empty mcp-tool-empty" ?hidden=${visible.length > 0}>
								No tools match that filter.
						  </p>`
							: null
					}
				</details>
			</div>
		`
	}

	private _onToggle(event: Event): void {
		const details = event.target as HTMLDetailsElement
		this._expanded = details.open
	}

	private _onSearch(event: Event): void {
		this._query = (event.target as HTMLInputElement).value
	}
}

declare global {
	interface HTMLElementTagNameMap {
		"bhzai-mcp-tool-list": BhzaiMcpToolList
	}
}
