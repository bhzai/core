import { ContextOverflowError } from "../llm/errors"
import type { LlmService } from "../llm/types"
import type { SessionService } from "../sessions/types"
import type { SessionEvent } from "../sessions/types"
import type {
	ComputeBudgetOptions,
	ContextBudget,
	ContextTrackingService,
	SessionContextState,
	TokenBreakdown,
	TokenizerService,
} from "./types"

const DEFAULT_WARNING_THRESHOLD = 0.8

/**
 * Distributes drift proportionally across unreconciled events.
 * @param eventIds Unreconciled event IDs.
 * @param eventTokens Map of event token counts.
 * @param drift Total drift to distribute.
 */
function distributeDrift(
	eventIds: string[],
	eventTokens: Map<string, number>,
	drift: number,
): void {
	if (eventIds.length === 0 || drift === 0) return

	let estimatedSum = 0
	for (const id of eventIds) {
		estimatedSum += eventTokens.get(id) ?? 0
	}

	if (estimatedSum <= 0) {
		const perEvent = Math.round(drift / eventIds.length)
		for (const id of eventIds) {
			const curr = eventTokens.get(id) ?? 0
			eventTokens.set(id, Math.max(1, curr + perEvent))
		}
		return
	}

	for (const id of eventIds) {
		const curr = eventTokens.get(id) ?? 0
		const fraction = curr / estimatedSum
		const adjusted = Math.max(1, Math.round(curr + drift * fraction))
		eventTokens.set(id, adjusted)
	}
}

/**
 * Resolves context window for a given model from the LLM service if available.
 * @param llm Optional LLM service.
 * @param modelRef Model reference string.
 */
async function resolveContextWindow(
	llm?: LlmService,
	modelRef?: string,
): Promise<number | undefined> {
	if (!llm || !modelRef) return undefined
	try {
		const resolved = await llm.resolveModel(modelRef)
		const caps = resolved.driver.capabilities(resolved.model)
		return caps.contextWindow
	} catch {
		return undefined
	}
}

/**
 * Implementation of ContextTrackingService providing usage-based accounting.
 */
export class ContextTracker implements ContextTrackingService {
	private readonly states = new Map<string, SessionContextState>()
	private readonly tokenizer: TokenizerService
	private readonly getLlm?: () => LlmService | undefined
	private readonly getSessions?: () => SessionService | undefined

	constructor(
		tokenizer: TokenizerService,
		getLlm?: () => LlmService | undefined,
		getSessions?: () => SessionService | undefined,
	) {
		this.tokenizer = tokenizer
		this.getLlm = getLlm
		this.getSessions = getSessions
	}

	private getOrCreateState(sessionId: string): SessionContextState {
		let state = this.states.get(sessionId)
		if (!state) {
			state = {
				sessionId,
				eventTokens: new Map(),
				unreconciledEventIds: [],
			}
			this.states.set(sessionId, state)
		}
		return state
	}

	getSessionState(sessionId: string): SessionContextState | undefined {
		return this.states.get(sessionId)
	}

	getEventTokens(sessionId: string, eventId: string): number | undefined {
		return this.states.get(sessionId)?.eventTokens.get(eventId)
	}

	reset(sessionId: string): void {
		this.states.delete(sessionId)
	}

	async recordEvents(sessionId: string, events: SessionEvent[]): Promise<void> {
		const state = this.getOrCreateState(sessionId)

		for (const event of events) {
			const tokens = await this.tokenizer.estimateEvent(event)
			state.eventTokens.set(event.id, tokens)
			state.unreconciledEventIds.push(event.id)

			if (event.type === "assistant_message" && event.usage) {
				if (typeof event.usage.promptTokens === "number") {
					this.reconcile(sessionId, event.usage.promptTokens, event.id)
				}
				if (typeof event.usage.completionTokens === "number") {
					state.eventTokens.set(event.id, event.usage.completionTokens)
				}
			}
		}
	}

	reconcile(sessionId: string, promptTokens: number, throughEventId: string): void {
		const state = this.getOrCreateState(sessionId)
		const throughIndex = state.unreconciledEventIds.indexOf(throughEventId)
		const reconcilingIds =
			throughIndex >= 0
				? state.unreconciledEventIds.slice(0, throughIndex + 1)
				: [...state.unreconciledEventIds]

		let estimatedDelta = 0
		for (const id of reconcilingIds) {
			estimatedDelta += state.eventTokens.get(id) ?? 0
		}

		const previousBase = state.lastGroundTruthPromptTokens ?? 0
		const expectedPrompt = previousBase + estimatedDelta
		const drift = promptTokens - expectedPrompt

		distributeDrift(reconcilingIds, state.eventTokens, drift)

		state.lastGroundTruthPromptTokens = promptTokens
		state.lastGroundTruthEventId = throughEventId
		state.lastReconciledDrift = drift
		state.unreconciledEventIds =
			throughIndex >= 0 ? state.unreconciledEventIds.slice(throughIndex + 1) : []
	}

	async computeBudget(
		sessionId: string,
		options: ComputeBudgetOptions = {},
	): Promise<ContextBudget> {
		const state = this.getOrCreateState(sessionId)
		let estimatedDelta = 0
		for (const id of state.unreconciledEventIds) {
			estimatedDelta += state.eventTokens.get(id) ?? 0
		}

		let messagesTokens = (state.lastGroundTruthPromptTokens ?? 0) + estimatedDelta
		if (state.lastGroundTruthPromptTokens === undefined) {
			let total = 0
			for (const count of state.eventTokens.values()) {
				total += count
			}
			messagesTokens = total
		}

		const systemPromptTokens = options.systemPrompt
			? await this.tokenizer.countTokens(options.systemPrompt)
			: 0
		const toolsTokens = options.tools ? await this.tokenizer.estimateTools(options.tools) : 0

		const breakdown: TokenBreakdown = {
			messagesTokens,
			systemPromptTokens,
			toolsTokens,
		}

		const totalTokens = messagesTokens + systemPromptTokens + toolsTokens
		const llm = this.getLlm?.()
		const contextWindow = await resolveContextWindow(llm, options.model)
		const remainingTokens =
			contextWindow !== undefined ? Math.max(0, contextWindow - totalTokens) : undefined
		const utilization = contextWindow && contextWindow > 0 ? totalTokens / contextWindow : 0
		const threshold = options.warningThreshold ?? DEFAULT_WARNING_THRESHOLD
		const isNearLimit = contextWindow !== undefined && utilization >= threshold
		const isOverflow = contextWindow !== undefined && totalTokens > contextWindow

		return {
			totalTokens,
			contextWindow,
			remainingTokens,
			utilization,
			groundTruthTokens: state.lastGroundTruthPromptTokens,
			estimatedDeltaTokens: estimatedDelta,
			breakdown,
			isNearLimit,
			isOverflow,
		}
	}

	async checkLimit(sessionId: string, options: ComputeBudgetOptions = {}): Promise<ContextBudget> {
		const budget = await this.computeBudget(sessionId, options)
		if (budget.isOverflow) {
			throw new ContextOverflowError(
				`Context window overflow: estimated ${budget.totalTokens} tokens exceed model limit of ${budget.contextWindow}.`,
				{ budget },
			)
		}
		return budget
	}
}
