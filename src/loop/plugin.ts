import type { PluginContext, PluginDefinition } from "../kernel/types"
import type { SessionService } from "../sessions/types"
import { executeTurn } from "./turn"
import {
	type AgentLoopService,
	TurnBusyError,
	type TurnInput,
	type TurnOptions,
	type TurnResult,
} from "./types"

/**
 * Concrete implementation of AgentLoopService claimed on ctx.agentLoop.
 */
class AgentLoopServiceImpl implements AgentLoopService {
	private readonly ctx: PluginContext
	private readonly busySessions = new Set<string>()

	constructor(ctx: PluginContext) {
		this.ctx = ctx
	}

	isBusy(sessionId?: string): boolean {
		if (sessionId) {
			return this.busySessions.has(sessionId)
		}
		return this.busySessions.size > 0
	}

	async runTurn(
		sessionId: string,
		input: TurnInput,
		options: TurnOptions = {},
	): Promise<TurnResult> {
		if (this.busySessions.has(sessionId)) {
			throw new TurnBusyError(sessionId)
		}

		const sessions = this.ctx.sessions as SessionService | undefined
		if (!sessions) {
			throw new Error("Sessions service is not claimed or available on context.")
		}

		this.busySessions.add(sessionId)

		try {
			const session = await sessions.open(sessionId)
			return await executeTurn(this.ctx, session, input, options)
		} finally {
			this.busySessions.delete(sessionId)
		}
	}
}

/**
 * Plugin providing the v0.2 agent loop by claiming ctx.agentLoop.
 */
export const agentLoopPlugin: PluginDefinition = {
	name: "agentLoop",
	dependencies: ["llm", "sessions"],
	setup(ctx: PluginContext) {
		const service = new AgentLoopServiceImpl(ctx)
		ctx.claim("agentLoop", service)
	},
}
