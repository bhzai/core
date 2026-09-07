import type { PluginContext, PluginDefinition } from "../kernel/types"
import type { LlmService } from "../llm/types"
import type { PreStepContext, PreStepPayload } from "../loop/types"
import type { SessionEvent, SessionService } from "../sessions/types"
import { TokenizerServiceImpl } from "./tokenizer"
import { ContextTracker } from "./tracker"
import type { TokenizerService } from "./types"

/**
 * Plugin providing pluggable tokenizer management by claiming ctx.tokenizer.
 */
export const tokenizerPlugin: PluginDefinition = {
	name: "tokenizer",
	setup(ctx: PluginContext) {
		const tokenizer = new TokenizerServiceImpl()
		ctx.claim("tokenizer", tokenizer)
	},
}

/**
 * Plugin providing usage-based context accounting by claiming ctx.contextTracking.
 */
export const contextTrackingPlugin: PluginDefinition = {
	name: "contextTracking",
	dependencies: ["sessions", "tokenizer"],
	setup(ctx: PluginContext) {
		const tokenizer = ctx.tokenizer as TokenizerService
		if (!tokenizer) {
			throw new Error("Tokenizer service must be claimed prior to contextTracking.")
		}

		const tracker = new ContextTracker(
			tokenizer,
			() => ctx.llm as LlmService | undefined,
			() => ctx.sessions as SessionService | undefined,
		)
		ctx.claim("contextTracking", tracker)

		const unsubEvent = ctx.events.on<{ sessionId: string; events: SessionEvent[] }>(
			"session/event",
			async ({ sessionId, events }) => {
				await tracker.recordEvents(sessionId, events)
				const budget = await tracker.computeBudget(sessionId)
				ctx.events.emit("context/updated", { sessionId, budget })
			},
		)

		const unsubDeleted = ctx.events.on<{ sessionId: string }>(
			"session/deleted",
			({ sessionId }) => {
				tracker.reset(sessionId)
			},
		)

		const unsubPreStep = ctx.events.waterfall<PreStepPayload, PreStepContext>(
			"pre-step",
			async (payload, context, next) => {
				const budget = await tracker.computeBudget(context.sessionId, {
					systemPrompt: payload.systemPrompt,
					tools: payload.tools,
					messages: payload.messages,
				})
				ctx.events.emit("context/budget", {
					sessionId: context.sessionId,
					stepIndex: context.stepIndex,
					budget,
				})
				return await next(payload)
			},
		)

		return () => {
			unsubEvent()
			unsubDeleted()
			unsubPreStep()
		}
	},
}
