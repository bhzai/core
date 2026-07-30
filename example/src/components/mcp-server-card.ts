/**
 * @file One MCP server card as a reusable Lit element.
 *
 * Every text binding in the template is automatically escaped by lit-html. The
 * server name, tool names, tool descriptions and error messages all originate
 * from a remote endpoint the user pasted a URL for, so this escaping is the
 * security boundary. `mcp-server-card.test.ts` still guards it.
 */

import type { McpServerState } from "@bhzai/core/plugins/mcp"
import { LitElement, html } from "lit"
import { customElement, property } from "lit/decorators.js"
import "./mcp-tool-list.js"

/**
 * The `data-*` keys each card carries for the server list's search and sort.
 * Exported so `mcp-server-list.ts` indexes exactly what the card writes.
 */
export const SERVER_INDEX_KEYS = ["name", "status", "tools"]

/** Card-level actions, delegated to whoever owns the `McpManager`. */
export interface McpCardHandlers {
	/** Re-poll the server's tool list. */
	onRefresh(id: string): void
	/** Re-attempt a failed connection. */
	onRetry(id: string): void
	/** Detach the server. */
	onRemove(id: string): void
	/** Open the error-details dialog. */
	onShowError(id: string): void
}

/** Human-readable status line per lifecycle state. */
const STATUS_LABEL: Record<string, string> = {
	connecting: "connecting…",
	connected: "connected",
	error: "failed",
	detached: "detached",
}

/**
 * MCP server-card custom element.
 *
 * Rendered in the light DOM so the host page's global styles (and CSS variables)
 * continue to drive its appearance.
 *
 * @fires bhzai-refresh - The user asked to refresh this server's tools. Detail: `{ id: string }`.
 * @fires bhzai-retry - The user asked to retry this failed connection. Detail: `{ id: string }`.
 * @fires bhzai-remove - The user asked to detach this server. Detail: `{ id: string }`.
 * @fires bhzai-show-error - The user asked to inspect this server's error. Detail: `{ id: string }`.
 */
@customElement("bhzai-mcp-server-card")
export class BhzaiMcpServerCard extends LitElement {
	override createRenderRoot() {
		return this
	}

	@property({ type: Object })
	state!: McpServerState

	override willUpdate(changed: Map<string, unknown>) {
		if (changed.has("state") && this.state) {
			const tools = this.state.tools.map((tool) => tool.shortName).join(" ")
			this.dataset.status = this.state.status
			this.dataset.name = this.state.serverName
			this.dataset.tools = tools
		}
	}

	override render() {
		const state = this.state
		const statusText = this._statusText()
		const buttons: HTMLButtonElement[] = []

		if (state.status === "connected") {
			buttons.push(this._iconButton("⟳", `Refresh tools for ${state.serverName}`, "refresh"))
		}
		if (state.status === "error") {
			buttons.push(this._iconButton("🐛", `Error details for ${state.serverName}`, "show-error"))
			buttons.push(this._iconButton("↻", `Retry connecting to ${state.serverName}`, "retry"))
		}
		buttons.push(this._iconButton("✕", `Remove ${state.serverName}`, "remove"))

		return html`
			<div class="mcp-server-head">
				<span class="status-dot" data-state=${state.status}></span>
				<span class="mcp-server-name" title=${state.config.url}>${state.serverName}</span>
				<div class="mcp-actions">
					${buttons}
				</div>
			</div>
			<div class="mcp-server-status">${statusText}</div>
			<div class="mcp-server-tools">
				${
					state.status === "connected" && state.tools.length > 0
						? html`
							<bhzai-mcp-tool-list
								.serverName=${state.serverName}
								.tools=${state.tools}
							></bhzai-mcp-tool-list>
					  `
						: null
				}
			</div>
		`
	}

	private _statusText(): string {
		const state = this.state
		const label = STATUS_LABEL[state.status] ?? state.status

		if (state.status === "connected") {
			return state.tools.length === 0 ? `${label} · no tools` : label
		}
		if (state.status === "error" && state.error) {
			return `${label} · ${state.error.name}`
		}
		return label
	}

	private _iconButton(
		glyph: string,
		label: string,
		action: "refresh" | "retry" | "remove" | "show-error",
	): HTMLButtonElement {
		const button = document.createElement("button")
		button.type = "button"
		button.className = "mcp-icon-button"
		button.textContent = glyph
		button.title = label
		button.setAttribute("aria-label", label)
		button.addEventListener("click", () => this._dispatch(action))
		return button
	}

	private _dispatch(action: "refresh" | "retry" | "remove" | "show-error"): void {
		const detail = { id: this.state.id }
		switch (action) {
			case "refresh":
				this.dispatchEvent(
					new CustomEvent("bhzai-refresh", { detail, bubbles: true, composed: true }),
				)
				break
			case "retry":
				this.dispatchEvent(
					new CustomEvent("bhzai-retry", { detail, bubbles: true, composed: true }),
				)
				break
			case "remove":
				this.dispatchEvent(
					new CustomEvent("bhzai-remove", { detail, bubbles: true, composed: true }),
				)
				break
			case "show-error":
				this.dispatchEvent(
					new CustomEvent("bhzai-show-error", { detail, bubbles: true, composed: true }),
				)
				break
		}
	}
}

declare global {
	interface HTMLElementTagNameMap {
		"bhzai-mcp-server-card": BhzaiMcpServerCard
	}
}
