// Driver-interface type declarations (§ 10.1).
// Types only — no runtime logic. See TASK_0002 for the scope contract.
//
// CROSS-TASK COORDINATION NOTE: TASK_0002 originally scoped the full
// `BHZAIDriver` interface (with `listModels`, `capabilities`, `chat`, optional
// `embed`) as TASK_0009's responsibility and supplied only the shapes that
// cross the kernel/driver boundary (`GenerationParams`, `DriverEvent`,
// `ChatRequest`, `ToolWireDefinition`). TASK_0009 adds `BHZAIDriver` here — in
// the canonical types home, alongside the other driver types — per TASK_0009's
// "if TASK_0002 has not yet declared `BHZAIDriver`, this task must add it there
// ... and explicitly flag in a code comment that it did so on TASK_0002's
// behalf" instruction. The shape matches ARCHITECTURE.md § 10.1 lines 753-767
// verbatim, including `embed?` being optional.

import type { JSONSchema } from "./content.js"
import type { BHZAIMessage } from "./message.js"
import type { DriverCapabilities, ModelInfo, Usage } from "./model.js"

/**
 * Generation overrides passed through `ChatRequest.params` (§ 10.1).
 *
 * Explicit assumption: the spec does not state which of
 * `temperature`/`maxTokens`/`stop` are optional vs required. All are marked
 * optional because generation params are typically overrides on top of
 * driver/model defaults — a caller that wants the driver default for any of
 * them simply omits the field. `reasoning` standardizes thinking effort across
 * drivers (pi's `thinkingLevel` scale); drivers whose `capabilities()` report
 * `reasoning: false` ignore it.
 */
export interface GenerationParams {
	temperature?: number
	maxTokens?: number
	stop?: string[]
	reasoning?: "off" | "minimal" | "low" | "medium" | "high" | "max"
}

/**
 * The unified streaming event shape emitted by `BHZAIDriver.chat()` (§ 10.1).
 * A discriminated union on `type` with the exact string-literal discriminants
 * and field names per the spec.
 *
 * `unknown` (never `any`) is used for `tool-call`'s `input` and `done`'s
 * `error` fields, since their concrete shape is driver/tool-specific and not
 * knowable at this layer.
 */
export type DriverEvent =
	| { type: "delta"; text: string }
	| { type: "reasoning-delta"; text: string }
	| { type: "tool-call-delta"; toolCallId: string; argsDelta: string }
	| { type: "tool-call"; toolCallId: string; name: string; input: unknown }
	| {
			type: "usage"
			/** Prompt tokens for this turn, or `undefined` when the provider does not report them. */
			inputTokens?: number
			/** Completion tokens for this turn, or `undefined` when the provider does not report them. */
			outputTokens?: number
			/** Total tokens (`input + output`) when the provider reports it, else `undefined`. */
			totalTokens?: number
	  }
	| {
			type: "done"
			stopReason: "stop" | "tool-calls" | "length" | "abort" | "error"
			error?: unknown
	  }

/**
 * Minimal wire-projection of a tool definition onto what's sent to a
 * driver/model (§ 10.1's `tools?: ToolWireDefinition[]`).
 *
 * Explicit assumption: this is the minimal wire-projection implied by § 10.1's
 * parenthetical ("name/description/inputSchema, projected from the MCP Tool
 * records (§ 9.1)"). The full `BHZAIToolDefinition` (with `execute`, `tags`,
 * `serial`, `outputSchema`, `annotations`, etc. per § 9.1) is TASK_0008's
 * responsibility. `ToolWireDefinition` intentionally strips the bhzai-local,
 * non-serializable fields since it represents what's sent to a driver/model,
 * not the internal registry record.
 */
export interface ToolWireDefinition {
	name: string
	description: string
	inputSchema: JSONSchema
}

/**
 * The request handed to `BHZAIDriver.chat()` (§ 10.1). `messages` use the
 * normalized internal `BHZAIMessage` shape; drivers map to their wire format.
 *
 * `model` is the **bare model id** (e.g. `'meta-llama/Llama-3.1-8B-Instruct'`),
 * NOT the qualified `'<driver>/<model>'` ref. The kernel parses the qualified
 * ref before calling `chat()` and passes only the model id; the driver already
 * knows its own id via `this.id` and decides how to format the model name on
 * the wire (e.g. the vLLM driver's `prefixProvider` option controls whether
 * `'vllm/'` is prepended). The same contract applies to `embed()`'s `model`
 * field and to `capabilities(model)`.
 */
export interface ChatRequest {
	model: string
	messages: BHZAIMessage[]
	systemPrompt?: string
	tools?: ToolWireDefinition[]
	params?: GenerationParams
	signal: AbortSignal
}

/**
 * The driver interface every model provider implements (§ 10.1). The kernel
 * treats WebLLM, Ollama, and any future provider identically via this one
 * `chat()`/`listModels()`/`capabilities()` surface — "transport-agnostic
 * streaming" per #1338.
 *
 * Added by TASK_0009 on TASK_0002's behalf (see the file-header coordination
 * note). The shape matches § 10.1 lines 753-767 verbatim, including `embed?`
 * being optional — only drivers whose `capabilities(model).embeddings === true`
 * are expected to implement it.
 */
export interface BHZAIDriver {
	/** Stable driver identifier, e.g. `'webllm'`, `'ollama'`. */
	id: string
	/**
	 * Static or probed model catalogue; merged with plugins' `modelSource`
	 * hooks by the driver registry (TASK_0009) and `modelSource` resolution
	 * (TASK_0015).
	 */
	listModels(): Promise<ModelInfo[]>
	/** Per-model capability flags (§ 10.1, § 10.5). `model` is the bare model id. */
	capabilities(model: string): DriverCapabilities
	/**
	 * One LLM call. Unified streaming: an async iterable of typed
	 * {@link DriverEvent}s. Non-streaming providers yield a single `delta` +
	 * `done`.
	 */
	chat(request: ChatRequest): AsyncIterable<DriverEvent>
	/**
	 * Optional embedding generation for models whose `capabilities(model)`
	 * reports `embeddings: true` — the portable substrate RAG plugins
	 * index/query with (§ 11.8).
	 */
	embed?(request: {
		model: string
		input: string[]
		signal?: AbortSignal
	}): Promise<{ embeddings: number[][]; usage?: Usage }>
}
