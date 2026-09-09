import type { PluginContext, PluginDefinition } from "../kernel/types"
import type { PreStepContext, PreStepPayload } from "../loop/types"
import type { SessionService } from "../sessions/types"
import { executeCompaction } from "./pipeline"
import type { CompactionOptions, CompactionResult, CompactionService } from "./types"

const DEFAULT_COMPACTION_THRESHOLD = 0.8

/**
 * Concrete implementation of CompactionService claimed by the compaction plugin.
 */
export class CompactionServiceImpl implements CompactionService {
	private readonly ctx: PluginContext
	private readonly defaultConfig: CompactionOptions

	constructor(ctx: PluginContext, defaultConfig: CompactionOptions = {}) {
		this.ctx = ctx
		this.defaultConfig = defaultConfig
	}

	async compact(sessionId: string, options: CompactionOptions = {}): Promise<CompactionResult> {
		const sessions = this.ctx.sessions as SessionService | undefined
		if (!sessions) {
			throw new Error("Sessions service is required for compaction.")
		}
		const session = await sessions.open(sessionId)
		const merged = { ...this.defaultConfig, ...options }
		return await executeCompaction(this.ctx, session, merged)
	}

	async shouldCompact(sessionId: string, options: CompactionOptions = {}): Promise<boolean> {
		if (!this.ctx.contextTracking) return false
		const merged = { ...this.defaultConfig, ...options }
		const budget = await this.ctx.contextTracking.computeBudget(sessionId, {
			model: merged.model,
		})
		const effectiveWindow = merged.contextWindow ?? budget.contextWindow
		if (effectiveWindow && effectiveWindow > 0) {
			const utilization = budget.totalTokens / effectiveWindow
			const threshold = merged.threshold ?? DEFAULT_COMPACTION_THRESHOLD
			return budget.totalTokens > effectiveWindow || utilization >= threshold
		}
		return budget.isOverflow
	}
}

/**
 * Plugin providing conversation compaction by claiming ctx.compaction.
 */
export const compactionPlugin: PluginDefinition<CompactionOptions> = {
	name: "compaction",
	dependencies: ["sessions"],
	setup(ctx: PluginContext, config: CompactionOptions = {}) {
		const service = new CompactionServiceImpl(ctx, config)
		ctx.claim("compaction", service)

		const unsubPreStep = ctx.events.waterfall<PreStepPayload, PreStepContext>(
			"pre-step",
			async (payload, context, next) => {
				const should = await service.shouldCompact(context.sessionId, config)
				if (should) {
					const result = await service.compact(context.sessionId, config)
					if (result.compacted) {
						const sessions = ctx.sessions as SessionService | undefined
						if (sessions) {
							const session = await sessions.open(context.sessionId)
							payload.messages = session.deriveMessages()
						}
					}
				}
				return await next(payload)
			},
		)

		return () => {
			unsubPreStep()
		}
	},
}
