/** @file The per-turn telemetry readouts as a reusable Lit element. */

import { LitElement, html, nothing } from "lit"
import { customElement, state } from "lit/decorators.js"
import { formatTokens } from "../lib/format.js"

/** Everything the panel renders, pre-formatted by the caller. */
export interface TelemetryStats {
	/** Formatted prefill tokens/s, or an em dash. */
	prefillTps: string
	/** Formatted decode tokens/s, or an em dash. */
	decodeTps: string
	/** Formatted time-to-first-token, or an em dash. */
	ttft: string
	/** Formatted cumulative input token count. */
	inputTokens: string
	/** Formatted cumulative output token count. */
	outputTokens: string
	/** Formatted total tokens consumed (cumulative in + out). */
	totalTokens: string
	/** Formatted last-turn input tokens, or an em dash when unavailable. */
	lastTurnInput: string
	/** Formatted last-turn output tokens, or an em dash when unavailable. */
	lastTurnOutput: string
	/** Model context window, when the driver reports one. */
	contextWindow?: number
	/** Percentage of the context window used, when it can be computed. */
	contextUsagePercent: number | null
	/** CSS color for the decode gauge fill. */
	decodeColor: string
	/** 0..1 decode thermal ratio, driving the gauge width. */
	decodeRatio: number
}

/**
 * Telemetry panel custom element.
 *
 * Replaces its previous content with a fresh set of readouts on every turn.
 * Rendered in the light DOM so the host page's global styles (and CSS variables)
 * continue to drive its appearance.
 */
@customElement("bhzai-telemetry")
export class BhzaiTelemetry extends LitElement {
	override createRenderRoot() {
		return this
	}

	@state()
	private _stats: TelemetryStats | null = null

	@state()
	private _message: string | null = null

	/** Replace the readouts with a fresh set of stats. */
	updateStats(stats: TelemetryStats): void {
		this._stats = stats
		this._message = null
	}

	/** Replace the readouts with a single message — used for fatal errors. */
	showMessage(message: string): void {
		this._message = message
		this._stats = null
	}

	override render() {
		if (this._message !== null) {
			return html`<div class="telemetry-message">${this._message}</div>`
		}
		if (this._stats === null) return nothing
		const stats = this._stats

		const contextPanel =
			stats.contextWindow && stats.contextUsagePercent !== null
				? html`
						<div class="telemetry-panel">
							<div class="telemetry-eyebrow">Context</div>
							<div class="context-bar">${this._contextBar(stats.contextUsagePercent)}</div>
							<div class="telemetry-subtext telemetry-subtext-small">
								max: ${formatTokens(stats.contextWindow)} tokens
							</div>
						</div>
				  `
				: nothing

		return html`
			<div class="telemetry-panel">
				<div class="telemetry-eyebrow">Decode</div>
				<div class="telemetry-value">${stats.decodeTps || "—"}</div>
				<div class="gauge-container">
					<div class="gauge-bar">
						<div
							class="gauge-fill"
							style="width: ${stats.decodeRatio * 100}%; background: ${stats.decodeColor}"
						></div>
					</div>
				</div>
			</div>
			<div class="telemetry-panel">
				<div class="telemetry-eyebrow">Prefill</div>
				<div class="telemetry-value">${stats.prefillTps || "—"}</div>
			</div>
			<div class="telemetry-panel">
				<div class="telemetry-eyebrow">TTFT</div>
				<div class="telemetry-value">${stats.ttft || "—"}</div>
			</div>
			<div class="telemetry-panel">
				<div class="telemetry-eyebrow">Tokens consumed</div>
				<div class="telemetry-value">${stats.totalTokens}</div>
				<div class="telemetry-subtext">cumulative in: ${stats.inputTokens}</div>
				<div class="telemetry-subtext">cumulative out: ${stats.outputTokens}</div>
				<div class="telemetry-subtext">last turn in: ${stats.lastTurnInput}</div>
				<div class="telemetry-subtext">last turn out: ${stats.lastTurnOutput}</div>
			</div>
			${contextPanel}
		`
	}

	private _contextBar(percent: number): string {
		const filled = Math.max(0, Math.min(10, Math.round(percent / 10)))
		const bar = "▓".repeat(filled) + "░".repeat(10 - filled)
		return `${bar} ${percent}%`
	}
}

declare global {
	interface HTMLElementTagNameMap {
		"bhzai-telemetry": BhzaiTelemetry
	}
}
