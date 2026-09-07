import type { ToolWireDefinition } from "../../types/driver"
import type { BHZAIMessage } from "../../types/message"
import type { SessionEvent } from "../sessions/types"

/**
 * Pluggable tokenizer backend interface.
 */
export interface Tokenizer {
	/** Unique name of the tokenizer backend (e.g. "heuristic", "wasm"). */
	readonly name: string

	/**
	 * Counts or estimates tokens in the given text string.
	 * @param text Text string to measure.
	 */
	countTokens(text: string): Promise<number> | number
}

/**
 * Breakdown of tokens across different segments of an LLM request context.
 */
export interface TokenBreakdown {
	/** Tokens occupied by conversation history messages. */
	messagesTokens: number

	/** Tokens occupied by the system prompt. */
	systemPromptTokens: number

	/** Tokens occupied by tool definitions and function-calling wrappers. */
	toolsTokens: number
}

/**
 * Context window utilization and token budget evaluation for a session.
 */
export interface ContextBudget {
	/** Total context tokens occupied (messages + system prompt + tools). */
	totalTokens: number

	/** Model context window limit in tokens, if known. */
	contextWindow?: number

	/** Remaining tokens before reaching context window capacity. */
	remainingTokens?: number

	/** Utilization fraction between 0.0 and 1.0 (or > 1.0 if over capacity). */
	utilization: number

	/** Authoritative ground truth prompt tokens from the last completed driver step. */
	groundTruthTokens?: number

	/** Estimated tokens for events appended since the last driver ground truth. */
	estimatedDeltaTokens: number

	/** Detailed breakdown of tokens across categories. */
	breakdown: TokenBreakdown

	/** True if utilization has reached or exceeded the warning threshold (default 80%). */
	isNearLimit: boolean

	/** True if totalTokens exceeds contextWindow. */
	isOverflow: boolean
}

/**
 * Internal state maintained by the context tracker for a session.
 */
export interface SessionContextState {
	/** Session identifier. */
	sessionId: string

	/** Authoritative ground truth prompt tokens from the latest driver response. */
	lastGroundTruthPromptTokens?: number

	/** Event ID corresponding to the latest ground truth anchor point. */
	lastGroundTruthEventId?: string

	/** Map of event IDs to their reconciled or estimated token counts. */
	eventTokens: Map<string, number>

	/** List of event IDs appended since the last ground truth reconciliation. */
	unreconciledEventIds: string[]

	/** Cumulative reconciled drift bounded to the most recent step. */
	lastReconciledDrift?: number
}

/**
 * Options for computing session context budget.
 */
export interface ComputeBudgetOptions {
	/** Target model identifier or reference to inspect contextWindow capability. */
	model?: string

	/** Effective system prompt string. */
	systemPrompt?: string

	/** Effective wire tools offered to the model. */
	tools?: ToolWireDefinition[]

	/** Optional pre-projected messages. If omitted, messages are derived from session events. */
	messages?: BHZAIMessage[]

	/** Warning threshold fraction for isNearLimit (default: 0.8). */
	warningThreshold?: number
}

/**
 * Service managing tokenizer backends and estimating token counts for messages, tools, and events.
 */
export interface TokenizerService {
	/**
	 * Registers a pluggable tokenizer backend. Returns an unregister callback.
	 * @param name Unique backend identifier.
	 * @param backend Tokenizer implementation.
	 */
	registerBackend(name: string, backend: Tokenizer): () => void

	/**
	 * Retrieves a registered backend by name, or the active/default backend.
	 * @param name Optional backend identifier.
	 */
	getBackend(name?: string): Tokenizer | undefined

	/**
	 * Counts tokens in a plain text string.
	 * @param text The text string.
	 * @param backendName Optional backend name override.
	 */
	countTokens(text: string, backendName?: string): Promise<number>

	/**
	 * Estimates tokens for a conversation message.
	 * @param message Message to estimate.
	 * @param backendName Optional backend name override.
	 */
	estimateMessage(message: BHZAIMessage, backendName?: string): Promise<number>

	/**
	 * Estimates tokens for wire tool definitions including framing overhead.
	 * @param tools Tool wire definitions.
	 * @param backendName Optional backend name override.
	 */
	estimateTools(tools: ToolWireDefinition[], backendName?: string): Promise<number>

	/**
	 * Estimates tokens for a raw session event.
	 * @param event Session event to estimate.
	 * @param backendName Optional backend name override.
	 */
	estimateEvent(event: SessionEvent, backendName?: string): Promise<number>
}

/**
 * Service managing context usage accounting, ground-truth reconciliation, and budget evaluation.
 */
export interface ContextTrackingService {
	/**
	 * Computes the context budget and utilization for a session.
	 * @param sessionId Target session ID.
	 * @param options Optional configuration overrides.
	 */
	computeBudget(sessionId: string, options?: ComputeBudgetOptions): Promise<ContextBudget>

	/**
	 * Evaluates context capacity and throws ContextOverflowError if the window is exceeded.
	 * @param sessionId Target session ID.
	 * @param options Optional configuration overrides.
	 */
	checkLimit(sessionId: string, options?: ComputeBudgetOptions): Promise<ContextBudget>

	/**
	 * Reconciles estimated event tokens against authoritative driver prompt tokens.
	 * @param sessionId Target session ID.
	 * @param promptTokens Ground truth prompt tokens reported by the driver.
	 * @param throughEventId Event ID marking the end of the evaluated prompt.
	 */
	reconcile(sessionId: string, promptTokens: number, throughEventId: string): void

	/**
	 * Ingests newly appended session events and calculates initial estimates.
	 * @param sessionId Target session ID.
	 * @param events Newly appended events.
	 */
	recordEvents(sessionId: string, events: SessionEvent[]): Promise<void>

	/**
	 * Returns the context tracking state for a session.
	 * @param sessionId Target session ID.
	 */
	getSessionState(sessionId: string): SessionContextState | undefined

	/**
	 * Returns the tracked token count for a specific event.
	 * @param sessionId Target session ID.
	 * @param eventId Target event ID.
	 */
	getEventTokens(sessionId: string, eventId: string): number | undefined

	/**
	 * Resets or clears tracking state for a session.
	 * @param sessionId Target session ID.
	 */
	reset(sessionId: string): void
}

declare module "../kernel/types" {
	interface HarnessServices {
		tokenizer?: TokenizerService
		contextTracking?: ContextTrackingService
	}
}
