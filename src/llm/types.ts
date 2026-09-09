import type {
	BHZAIDriver,
	ChatRequest,
	DriverEvent,
	GenerationParams,
	ToolWireDefinition,
} from "../types/driver"
import type { BHZAIMessage } from "../types/message"
import type { DriverCapabilities, ModelInfo, Usage } from "../types/model"

/**
 * Retry policy options for driver requests.
 */
export interface RetryPolicy {
	/** Maximum number of retry attempts following an initial failure. */
	maxRetries: number

	/** Backoff strategy between attempts. */
	backoff: "exponential" | "none"
}

/**
 * Request payload for streaming LLM calls.
 */
export interface LlmStreamRequest {
	/** Qualified reference ('driver/model') or bare model ID. */
	model?: string

	/** Conversation message history passed to the driver. */
	messages: BHZAIMessage[]

	/** Optional system prompt prepended or formatted for the model. */
	systemPrompt?: string

	/** Optional tool schemas exposed to the model. */
	tools?: ToolWireDefinition[]

	/** Optional generation parameters (temperature, maxTokens, etc.). */
	params?: GenerationParams

	/** Abort signal to cancel execution. */
	signal?: AbortSignal

	/** Optional retry policy override. */
	retry?: RetryPolicy
}

/**
 * Request payload for one-shot LLM completion.
 */
export interface LlmCompleteRequest {
	/** Qualified reference ('driver/model') or bare model ID. */
	model?: string

	/** Input prompt string or structured message array. */
	messages: string | BHZAIMessage[]

	/** Optional system prompt. */
	systemPrompt?: string

	/** Optional generation parameters. */
	params?: GenerationParams

	/** Abort signal to cancel execution. */
	signal?: AbortSignal

	/** Optional retry policy override. */
	retry?: RetryPolicy
}

/**
 * Result returned from a one-shot LLM completion call.
 */
export interface LlmCompleteResult {
	/** Aggregated text response. */
	text: string

	/** Model reasoning/thinking output if generated. */
	reasoning?: string

	/** Token usage reported by the driver. */
	usage?: Usage
}

/**
 * Resolved driver and bare model ID pair.
 */
export interface ResolvedModel {
	/** The driver responsible for executing the model. */
	driver: BHZAIDriver

	/** The bare model ID expected by the driver. */
	model: string

	/** The fully qualified 'driver/model' identifier. */
	qualifiedRef: string
}

/**
 * Context provided to request waterfall handlers.
 */
export interface RequestWaterfallContext {
	/** Driver ID handling the request. */
	driverId: string

	/** Bare model ID. */
	modelId: string

	/** Qualified model ref. */
	qualifiedRef: string
}

/**
 * Service managing LLM drivers, model catalogue, retry, and streaming execution.
 */
export interface LlmService {
	/**
	 * Registers an LLM driver into the service.
	 * @param driver The driver implementation to register.
	 * @returns Disposable function to unregister the driver.
	 */
	addDriver(driver: BHZAIDriver): () => void

	/**
	 * Retrieves a registered driver by its identifier.
	 * @param id Driver identifier (e.g. 'openai', 'ollama').
	 */
	getDriver(id: string): BHZAIDriver | undefined

	/**
	 * Lists all currently registered drivers.
	 */
	listDrivers(): BHZAIDriver[]

	/**
	 * Merges and returns model catalogues from all registered drivers.
	 */
	listModels(): Promise<ModelInfo[]>

	/**
	 * Resolves a model reference (bare or qualified) against the active drivers.
	 * @param ref Bare model ID or 'driver/model' qualified reference.
	 */
	resolveModel(ref?: string): Promise<ResolvedModel>

	/**
	 * Sets the default model reference used when none is explicitly provided.
	 * @param modelRef Qualified reference or bare model ID.
	 */
	setDefaultModel(modelRef?: string): void

	/**
	 * Returns the currently configured default model reference.
	 */
	getDefaultModel(): string | undefined

	/**
	 * Streams generation events from the resolved driver with retry and waterfall hooks.
	 * @param request Stream execution parameters.
	 */
	stream(request: LlmStreamRequest): AsyncIterable<DriverEvent>

	/**
	 * Executes a one-shot completion and aggregates the response text.
	 * @param request One-shot execution parameters.
	 */
	complete(request: LlmCompleteRequest): Promise<LlmCompleteResult>
}

declare module "../kernel/types" {
	interface HarnessServices {
		llm?: LlmService
	}
}

export type {
	BHZAIDriver,
	BHZAIMessage,
	ChatRequest,
	DriverCapabilities,
	DriverEvent,
	GenerationParams,
	ModelInfo,
	ToolWireDefinition,
	Usage,
}
