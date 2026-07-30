// Model-catalogue and driver-capability type declarations (§§ 10.1, 10.5).
// Types only — no runtime logic. See TASK_0002 for the scope contract.

/**
 * Driver capability flags reported by `BHZAIDriver.capabilities(model)` (§ 10.1)
 * and embedded in each `ModelInfo` (§ 10.5).
 *
 * Explicit assumption: § 10.1/§ 10.5 give only the field list
 * (`{ streaming, toolCalls, reasoning, embeddings?, contextWindow? }`), not
 * their types. Field types (`boolean`/`number`) are inferred from naming and
 * usage context — `streaming`/`toolCalls`/`reasoning` are capability flags
 * (boolean), `embeddings` is an optional capability flag, and `contextWindow`
 * is an optional token-count bound (number).
 */
export interface DriverCapabilities {
	streaming: boolean
	toolCalls: boolean
	reasoning: boolean
	embeddings?: boolean
	contextWindow?: number
}

/**
 * A model catalogue entry (§ 10.5). `ref` is the qualified
 * `'<driver>/<model>'` reference used everywhere a model is addressed.
 */
export interface ModelInfo {
	ref: string
	driver: string
	id: string
	label?: string
	capabilities: DriverCapabilities
	availability: "ready" | "downloadable" | "unavailable"
	meta?: Record<string, unknown>
}

/**
 * Token accounting (§ 6 `complete()`/`embed()` return shapes, and the
 * `usage` `DriverEvent` variant's fields in § 10.1).
 */
export interface Usage {
	inputTokens: number
	outputTokens: number
}
