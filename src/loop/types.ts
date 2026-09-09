import type { ToolFilter } from "../tools/types"
import type { ContentBlock } from "../types/content"
import type { ToolWireDefinition } from "../types/driver"
import type { BHZAIMessage, ToolCallRecord } from "../types/message"
import type { Usage } from "../types/model"

/**
 * Input content for a turn, either a plain text string or structured content blocks.
 */
export type TurnInput = string | ContentBlock[]

/**
 * Options configuring the execution of a turn.
 */
export interface TurnOptions {
	/** Optional model reference or qualified ID. */
	model?: string

	/** Optional base system prompt override or addition. */
	systemPrompt?: string

	/** Maximum number of model round-trip steps allowed in this turn (default: 25). */
	maxSteps?: number

	/** Abort signal to cancel turn execution. */
	signal?: AbortSignal

	/** Custom wire tool definitions or filter criteria for registered tools. */
	tools?: ToolWireDefinition[] | ToolFilter

	/** Optional caller-assigned turn ID. */
	turnId?: string
}

/**
 * Summary record of a single step within a turn.
 */
export interface TurnStep {
	/** Zero-based index of this step in the turn. */
	stepIndex: number

	/** Assistant text generated in this step. */
	assistantText: string

	/** Optional reasoning thoughts emitted by the model. */
	reasoning?: string

	/** Tool calls requested by the model in this step. */
	toolCalls?: ToolCallRecord[]

	/** Token usage reported by the driver for this step. */
	usage?: Usage
}

/**
 * Final result returned upon completion of a turn.
 */
export interface TurnResult {
	/** Unique turn identifier. */
	turnId: string

	/** Session identifier. */
	sessionId: string

	/** Aggregated assistant response text from the final step. */
	text: string

	/** Aggregated assistant reasoning from the final step, if any. */
	reasoning?: string

	/** All steps executed during this turn. */
	steps: TurnStep[]

	/** True if execution was halted because maxSteps was reached. */
	maxStepsExceeded?: boolean

	/** True if execution was aborted via AbortSignal. */
	aborted?: boolean
}

/**
 * Payload transformed by the 'pre-step' waterfall middleware.
 */
export interface PreStepPayload {
	/** Zero-based step index. */
	stepIndex: number

	/** Projected conversation messages sent to the driver. */
	messages: BHZAIMessage[]

	/** System prompt passed to the driver. */
	systemPrompt?: string

	/** Wire tool definitions offered to the model. */
	tools?: ToolWireDefinition[]
}

/**
 * Context passed to 'pre-step' waterfall handlers.
 */
export interface PreStepContext {
	sessionId: string
	turnId: string
	stepIndex: number
}

/**
 * Payload passed to 'turn/start' serial listeners.
 */
export interface TurnStartPayload {
	sessionId: string
	turnId: string
	input: TurnInput
}

/**
 * Payload evaluated by 'turn/end' bail handlers upon loop termination.
 */
export interface TurnEndPayload {
	sessionId: string
	turnId: string
	steps: TurnStep[]
	text: string
}

/**
 * Continuation result returned by a 'turn/end' bail handler to keep the turn alive.
 */
export interface TurnEndResult {
	/** Follow-up user message or synthetic continuation prompt. */
	followUp?: TurnInput
}

/**
 * Error thrown when a turn is initiated while a session is already executing a turn.
 */
export class TurnBusyError extends Error {
	constructor(sessionId: string) {
		super(`Agent loop is busy executing a turn for session "${sessionId}".`)
		this.name = "TurnBusyError"
	}
}

/**
 * Service managing turn execution and the agent loop.
 */
export interface AgentLoopService {
	/**
	 * Runs a turn in the specified session until termination or max steps.
	 * @param sessionId Target session ID.
	 * @param input User prompt or input blocks.
	 * @param options Turn configuration options.
	 */
	runTurn(sessionId: string, input: TurnInput, options?: TurnOptions): Promise<TurnResult>

	/**
	 * Checks if a turn is currently executing, optionally for a specific session.
	 * @param sessionId Optional session ID to check.
	 */
	isBusy(sessionId?: string): boolean
}

declare module "../kernel/types" {
	interface HarnessServices {
		agentLoop?: AgentLoopService
	}
}
