import type { CompactionBoundaryEvent, SessionEvent } from "../sessions/types"

/**
 * Configuration options for a compaction pass.
 */
export interface CompactionOptions {
	/** Context utilization fraction (0-1) above which compaction is triggered (default: 0.8). */
	threshold?: number

	/** Explicit context window limit in tokens to evaluate utilization against. */
	contextWindow?: number

	/** Number of most recent visible events to preserve outside compaction (default: 4). */
	keepRecentEvents?: number

	/** Model to use for generating the summary (if LLM summarization is used). */
	model?: string

	/** Custom system prompt instructing the summarizer. */
	systemPrompt?: string

	/** Custom summarizer function override. */
	summarizer?: (events: SessionEvent[], priorSummary?: string) => Promise<string>
}

/**
 * Result returned after evaluating or executing a compaction pass.
 */
export interface CompactionResult {
	/** True if compaction was executed and a boundary was recorded. */
	compacted: boolean

	/** Summary text produced, if compacted. */
	summary?: string

	/** Compaction boundary event appended to the log, if compacted. */
	boundaryEvent?: CompactionBoundaryEvent

	/** Number of events folded into the compaction boundary. */
	compactedEventsCount?: number

	/** Context tokens estimated before compaction. */
	tokensBefore?: number

	/** Context tokens estimated after compaction. */
	tokensAfter?: number
}

/**
 * Service orchestrating conversation compaction and boundary creation.
 */
export interface CompactionService {
	/**
	 * Compacts older history in the specified session, recording a CompactionBoundaryEvent.
	 * @param sessionId Target session ID.
	 * @param options Optional compaction settings.
	 */
	compact(sessionId: string, options?: CompactionOptions): Promise<CompactionResult>

	/**
	 * Determines if a session has exceeded compaction threshold pressure.
	 * @param sessionId Target session ID.
	 * @param options Optional compaction settings.
	 */
	shouldCompact(sessionId: string, options?: CompactionOptions): Promise<boolean>
}

/**
 * Payload emitted on 'compaction/start'.
 */
export interface CompactionStartPayload {
	/** Session identifier. */
	sessionId: string

	/** Events selected to be summarized and pruned. */
	eventsToCompact: SessionEvent[]

	/** Previous summary string if a prior boundary was present. */
	priorSummary?: string
}

/**
 * Payload emitted on 'compaction/complete'.
 */
export interface CompactionCompletePayload {
	/** Session identifier. */
	sessionId: string

	/** Final result of the compaction pass. */
	result: CompactionResult
}

declare module "../kernel/types" {
	interface HarnessServices {
		compaction?: CompactionService
	}
}
