import type { BHZAIMessage } from "../../types/message"
import "../context/types"
import type { TurnInput, TurnOptions, TurnResult } from "../loop/types"
import { deriveMessages } from "../sessions/projection"
import type { Session, SessionEvent, SessionExport } from "../sessions/types"
import type { Disposable, HarnessContext, HarnessSession } from "./types"

/**
 * Concrete implementation of the HarnessSession facade for embedding hosts.
 */
export class HarnessSessionImpl implements HarnessSession {
	readonly id: string
	private _model: string
	private readonly session: Session
	private readonly ctx: HarnessContext
	private activeAbortController?: AbortController
	private readonly tokenUsage = {
		inputTokens: 0,
		outputTokens: 0,
		totalTokens: 0,
	}

	constructor(session: Session, ctx: HarnessContext, initialModel?: string) {
		this.id = session.id
		this.session = session
		this.ctx = ctx
		this._model = initialModel || (session.metadata?.model as string | undefined) || "default"
	}

	get model(): string {
		return this._model
	}

	get status(): "idle" | "running" {
		return this.ctx.agentLoop?.isBusy(this.id) ? "running" : "idle"
	}

	get usage() {
		return { ...this.tokenUsage }
	}

	get contextUsage() {
		const state = this.ctx.contextTracking?.getSessionState(this.id)
		const lastInput = state?.lastGroundTruthPromptTokens
		return {
			totalTokens: this.tokenUsage.totalTokens,
			contextWindow: 0,
			utilization: 0,
			lastInputTokens: lastInput,
			lastOutputTokens: undefined,
		}
	}

	async setModel(modelRef: string): Promise<void> {
		this._model = modelRef
		if (typeof this.session.append === "function") {
			await this.session.append({
				id: crypto.randomUUID(),
				sessionId: this.id,
				type: "model_change",
				timestamp: Date.now(),
				modelRef,
			})
		}
	}

	async send(input: TurnInput, options: TurnOptions = {}): Promise<TurnResult> {
		const agentLoop = this.ctx.agentLoop
		if (!agentLoop) {
			throw new Error("Cannot send message: agentLoop service is not registered.")
		}

		this.activeAbortController = new AbortController()
		const signal = options.signal ?? this.activeAbortController.signal

		try {
			const result = await agentLoop.runTurn(this.id, input, {
				...options,
				model: options.model ?? this._model,
				signal,
			})

			for (const step of result.steps) {
				if (step.usage) {
					const inTokens = step.usage.inputTokens ?? 0
					const outTokens = step.usage.outputTokens ?? 0
					this.tokenUsage.inputTokens += inTokens
					this.tokenUsage.outputTokens += outTokens
					this.tokenUsage.totalTokens += inTokens + outTokens
				}
			}

			return result
		} finally {
			this.activeAbortController = undefined
		}
	}

	async sendMessage(text: string, options?: TurnOptions): Promise<TurnResult> {
		return await this.send(text, options)
	}

	abort(reason?: string): void {
		if (this.activeAbortController) {
			this.activeAbortController.abort(reason)
		}
	}

	on(event: string, handler: (payload: unknown) => void): Disposable {
		if (event === "message.delta") {
			const d1 = this.ctx.events.on("stream/delta", (p: unknown) => {
				const payload = p as { sessionId?: string; text?: string }
				if (payload.sessionId === this.id) {
					handler({ delta: payload.text, kind: "text" })
				}
			})
			const d2 = this.ctx.events.on("stream/reasoning", (p: unknown) => {
				const payload = p as { sessionId?: string; text?: string }
				if (payload.sessionId === this.id) {
					handler({ delta: payload.text, kind: "reasoning" })
				}
			})
			return () => {
				d1()
				d2()
			}
		}

		return this.ctx.events.on(event, (p: unknown) => {
			const payload = p as { sessionId?: string }
			if (!payload || !payload.sessionId || payload.sessionId === this.id) {
				handler(p)
			}
		})
	}

	async export(): Promise<SessionExport> {
		return this.session.export()
	}

	getEvents(): readonly SessionEvent[] {
		return this.session.getEvents()
	}

	toJSON(): {
		id: string
		model: string
		messages: BHZAIMessage[]
		metadata: Record<string, unknown>
	} {
		return {
			id: this.id,
			model: this._model,
			messages: deriveMessages([...this.session.getEvents()]),
			metadata: this.session.metadata,
		}
	}
}
