import type { HarnessContext } from "../kernel/types"
import type { LlmService } from "../llm/types"
import type { CompactionBoundaryEvent, Session, SessionEvent } from "../sessions/types"
import { generateSummary } from "./summarize"
import type {
	CompactionCompletePayload,
	CompactionOptions,
	CompactionResult,
	CompactionStartPayload,
} from "./types"

const DEFAULT_KEEP_RECENT_EVENTS = 4

/**
 * Finds the latest compaction boundary and slices the visible event window.
 * @param events Full session event log.
 */
export function resolveVisibleWindow(events: readonly SessionEvent[]): {
	visibleEvents: SessionEvent[]
	boundary?: CompactionBoundaryEvent
} {
	let latestBoundary: CompactionBoundaryEvent | undefined
	for (let i = events.length - 1; i >= 0; i--) {
		if (events[i].type === "compaction_boundary") {
			latestBoundary = events[i] as CompactionBoundaryEvent
			break
		}
	}

	if (!latestBoundary) {
		return { visibleEvents: [...events] }
	}

	const cutoffId = latestBoundary.compactedThroughEventId
	const cutoffIndex = events.findIndex((e) => e.id === cutoffId)
	if (cutoffIndex === -1) {
		return { visibleEvents: [...events], boundary: latestBoundary }
	}

	return {
		visibleEvents: events.slice(cutoffIndex + 1).filter((e) => e.type !== "compaction_boundary"),
		boundary: latestBoundary,
	}
}

/**
 * Determines the cutoff index for compaction while ensuring tool call/result pairs remain atomic.
 * @param visible Visible events in the active window.
 * @param keepCount Number of recent events to keep.
 */
export function findCompactionCutoff(visible: SessionEvent[], keepCount: number): number {
	if (visible.length <= keepCount) return -1

	let candidate = visible.length - keepCount - 1
	if (candidate < 0) return -1

	if (visible[candidate].type === "tool_call") {
		candidate--
	}
	return candidate
}

/**
 * Executes the single-path compaction pipeline: prune, summarize, and record boundary.
 * @param ctx Harness context.
 * @param session Active session instance.
 * @param options Compaction configuration options.
 */
export async function executeCompaction(
	ctx: HarnessContext,
	session: Session,
	options: CompactionOptions = {},
): Promise<CompactionResult> {
	const keepRecent = options.keepRecentEvents ?? DEFAULT_KEEP_RECENT_EVENTS
	const { visibleEvents, boundary } = resolveVisibleWindow(session.getEvents())

	const cutoffIdx = findCompactionCutoff(visibleEvents, keepRecent)
	if (cutoffIdx < 0) {
		return { compacted: false }
	}

	const cutoffEvent = visibleEvents[cutoffIdx]
	const eventsToCompact = visibleEvents.slice(0, cutoffIdx + 1)

	let tokensBefore: number | undefined
	if (ctx.contextTracking) {
		const budgetBefore = await ctx.contextTracking.computeBudget(session.id)
		tokensBefore = budgetBefore.totalTokens
	}

	const startPayload: CompactionStartPayload = {
		sessionId: session.id,
		eventsToCompact,
		priorSummary: boundary?.summary,
	}
	ctx.events.emit("compaction/start", startPayload)

	const summary = await generateSummary({
		events: eventsToCompact,
		priorSummary: boundary?.summary,
		llm: ctx.llm as LlmService | undefined,
		model: options.model,
		systemPrompt: options.systemPrompt,
		customSummarizer: options.summarizer,
	})

	const boundaryEvent: CompactionBoundaryEvent = {
		id: crypto.randomUUID(),
		sessionId: session.id,
		timestamp: Date.now(),
		type: "compaction_boundary",
		summary,
		compactedThroughEventId: cutoffEvent.id,
		tokensBefore,
	}

	await session.append([boundaryEvent])

	let tokensAfter: number | undefined
	if (ctx.contextTracking) {
		const budgetAfter = await ctx.contextTracking.computeBudget(session.id)
		tokensAfter = budgetAfter.totalTokens
		boundaryEvent.tokensAfter = tokensAfter
	}

	const result: CompactionResult = {
		compacted: true,
		summary,
		boundaryEvent,
		compactedEventsCount: eventsToCompact.length,
		tokensBefore,
		tokensAfter,
	}

	const completePayload: CompactionCompletePayload = {
		sessionId: session.id,
		result,
	}
	ctx.events.emit("compaction/complete", completePayload)

	return result
}
