import type { HarnessContext } from "../kernel/types"
import type { Session } from "../sessions/types"
import type { ToolFilter, ToolService } from "../tools/types"
import type { ToolWireDefinition } from "../types/driver"
import { executeStepToolCalls, recordStepAssistantMessage, streamModelStep } from "./step"
import type {
	PreStepContext,
	PreStepPayload,
	TurnEndPayload,
	TurnEndResult,
	TurnInput,
	TurnOptions,
	TurnResult,
	TurnStartPayload,
	TurnStep,
} from "./types"

const DEFAULT_MAX_STEPS = 25

/**
 * Resolves wire tool definitions from options or the claimed tools service.
 * @param ctx Runtime harness context.
 * @param tools Optional tool filter or explicit wire definition array.
 */
export function resolveWireTools(
	ctx: HarnessContext,
	tools?: ToolWireDefinition[] | ToolFilter,
): ToolWireDefinition[] | undefined {
	if (Array.isArray(tools)) {
		return tools
	}
	const toolService = ctx.tools as ToolService | undefined
	if (toolService) {
		return toolService.projectWireTools(tools)
	}
	return undefined
}

/**
 * Runs the iterative step loop for a turn up to maxSteps.
 * @param ctx Harness context.
 * @param session Active session.
 * @param turnId Unique turn ID.
 * @param options Turn execution options.
 */
/**
 * Evaluates turn/end bail handlers and determines if a follow-up continuation was requested.
 * @param ctx Harness context.
 * @param session Active session.
 * @param turnId Unique turn ID.
 * @param steps Completed turn steps.
 * @param assistantText Final assistant text.
 */
export async function handleTurnTermination(
	ctx: HarnessContext,
	session: Session,
	turnId: string,
	steps: TurnStep[],
	assistantText: string,
): Promise<{ continueLoop: boolean; result?: TurnResult }> {
	const endPayload: TurnEndPayload = {
		sessionId: session.id,
		turnId,
		steps,
		text: assistantText,
	}
	const cont = await ctx.events.runBail<TurnEndPayload, TurnEndResult>("turn/end", endPayload)
	if (cont?.followUp) {
		await session.append([
			{
				id: crypto.randomUUID(),
				sessionId: session.id,
				timestamp: Date.now(),
				type: "user_message",
				content: cont.followUp,
			},
		])
		return { continueLoop: true }
	}

	const lastStep = steps[steps.length - 1]
	return {
		continueLoop: false,
		result: {
			turnId,
			sessionId: session.id,
			text: assistantText,
			reasoning: lastStep?.reasoning,
			steps,
		},
	}
}

/**
 * Runs the iterative step loop for a turn up to maxSteps.
 * @param ctx Harness context.
 * @param session Active session.
 * @param turnId Unique turn ID.
 * @param options Turn execution options.
 */
export async function runStepLoop(
	ctx: HarnessContext,
	session: Session,
	turnId: string,
	options: TurnOptions,
): Promise<TurnResult> {
	const maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS
	const steps: TurnStep[] = []

	for (let stepIndex = 0; stepIndex < maxSteps; stepIndex++) {
		if (options.signal?.aborted) {
			return { turnId, sessionId: session.id, text: "", steps, aborted: true }
		}

		const messages = session.deriveMessages()
		const wireTools = resolveWireTools(ctx, options.tools)

		const prePayload: PreStepPayload = {
			stepIndex,
			messages,
			systemPrompt: options.systemPrompt,
			tools: wireTools,
		}
		const preContext: PreStepContext = { sessionId: session.id, turnId, stepIndex }
		const effective = await ctx.events.runWaterfall("pre-step", prePayload, preContext)

		const streamRes = await streamModelStep({
			ctx,
			sessionId: session.id,
			turnId,
			stepIndex,
			model: options.model,
			systemPrompt: effective.systemPrompt,
			messages: effective.messages,
			tools: effective.tools,
			signal: options.signal,
		})

		const stepRecord = await recordStepAssistantMessage(session, stepIndex, streamRes)
		steps.push(stepRecord)

		if (streamRes.toolCalls.length === 0) {
			const term = await handleTurnTermination(ctx, session, turnId, steps, streamRes.assistantText)
			if (term.continueLoop) {
				continue
			}
			return term.result as TurnResult
		}

		await executeStepToolCalls(ctx, session, streamRes.toolCalls, options.signal)
	}

	const lastStep = steps[steps.length - 1]
	return {
		turnId,
		sessionId: session.id,
		text: lastStep?.assistantText ?? "",
		reasoning: lastStep?.reasoning,
		steps,
		maxStepsExceeded: true,
	}
}

/**
 * Executes a full turn: notifies turn/start, appends user message, and drives the step loop.
 * @param ctx Harness context.
 * @param session Active session.
 * @param input User prompt or input blocks.
 * @param options Turn execution options.
 */
export async function executeTurn(
	ctx: HarnessContext,
	session: Session,
	input: TurnInput,
	options: TurnOptions = {},
): Promise<TurnResult> {
	const turnId = options.turnId ?? crypto.randomUUID()

	const startPayload: TurnStartPayload = {
		sessionId: session.id,
		turnId,
		input,
	}
	await ctx.events.runSerial("turn/start", startPayload)

	await session.append([
		{
			id: crypto.randomUUID(),
			sessionId: session.id,
			timestamp: Date.now(),
			type: "user_message",
			content: input,
		},
	])

	return await runStepLoop(ctx, session, turnId, options)
}
