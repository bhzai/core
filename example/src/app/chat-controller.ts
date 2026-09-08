/**
 * @file Chat orchestration: conversation lifecycle, streaming, and telemetry.
 *
 * Owns no DOM. Everything visible happens through the component controllers
 * passed in, and everything model-related through the kernel and the engine.
 */

import type { BHZAI, BHZAIConversation } from "@bhzai/core"
import type { WebLLM } from "@bhzai/core/plugins/webllm"
import type { Harness, HarnessSession } from "@bhzai/core/v2"
import type * as webllm from "@mlc-ai/web-llm"

import type { BhzaiColdStart } from "../components/cold-start-panel.js"
import type { BhzaiComposer } from "../components/composer.js"
import type { BhzaiConversation } from "../components/conversation-view.js"
import type { BhzaiModelSelect } from "../components/model-select.js"
import type { BhzaiStatusIndicator } from "../components/status-indicator.js"
import type { BhzaiTelemetry } from "../components/telemetry-panel.js"
import { formatSeconds, formatTokens, formatTps } from "../lib/format.js"
import { parseRuntimeStats } from "../lib/stats.js"
import { thermalColor, thermalRatio } from "../lib/thermal.js"

/** One streamed chunk, as carried by the conversation's `message.delta` event. */
interface MessageDelta {
	/** The text of this chunk. */
	delta: string
	/** Which channel it belongs to — `"reasoning"` or `"text"` under `parseThink`. */
	kind: string
}

/**
 * Narrow a `message.delta` payload.
 *
 * `ConversationEvents` carries an index signature (`[key: string]: unknown`) so
 * plugins can define their own events, which means every payload arrives here
 * as `unknown`. Narrowing at this one boundary keeps the rest of the controller
 * honestly typed instead of casting at each use.
 *
 * @param payload - The raw event payload
 * @returns The delta, or null when the payload is not one
 */
function asMessageDelta(payload: unknown): MessageDelta | null {
	if (typeof payload !== "object" || payload === null) return null
	const { delta, kind } = payload as Partial<MessageDelta>
	if (typeof delta !== "string" || typeof kind !== "string") return null
	return { delta, kind }
}

/** Everything the chat controller drives. */
export interface ChatControllerDeps {
	/** The kernel, already initialized. */
	bh: Harness | BHZAI
	/** The host-owned MLC engine, for `runtimeStatsText()`. */
	engine: webllm.MLCEngine
	/** The registered WebLLM driver, for `capabilities()`. */
	driver: WebLLM
	/** UI custom elements. */
	ui: {
		status: BhzaiStatusIndicator
		composer: BhzaiComposer
		conversation: BhzaiConversation
		telemetry: BhzaiTelemetry
		coldStart: BhzaiColdStart
		modelSelect: BhzaiModelSelect
	}
}

/** Controller returned by {@link createChatController}. */
export interface ChatController {
	/** Create a fresh conversation for the given qualified model ref. */
	selectModel(modelRef: string): Promise<void>
	/** Send a user message and stream the reply. */
	send(text: string): Promise<void>
	/** Abort the in-flight turn, if any. */
	stop(): void
	/** Adopt an externally-loaded conversation (e.g., from the sidebar). */
	setConversation(conv: HarnessSession | BHZAIConversation): void
	/** Start a fresh conversation with the current model (sidebar "New"). */
	newConversation(): Promise<void>
	/** The active conversation's id, or null if none. */
	readonly activeConversationId: string | null
	/** The currently selected qualified model ref, or null if none. */
	readonly currentModelRef: string | null
}

/**
 * Wire the kernel, the engine, and the chat UI together.
 *
 * @param deps - Kernel, engine, driver, and the component controllers
 */
export function createChatController(deps: ChatControllerDeps): ChatController {
	const { bh, engine, driver, ui } = deps

	let conversation: HarnessSession | BHZAIConversation | null = null
	/** The qualified model ref of the current/last-created conversation. */
	let currentModelRef: string | null = null
	/** Whether the selected model's weights have been downloaded this session. */
	let modelLoaded = false
	/** The turn currently streaming, or null between turns. */
	let turn: ReturnType<BhzaiConversation["beginAssistantTurn"]> | null = null
	/** `performance.now()` at send time, for TTFT. */
	let sendStartTime = 0
	/** `performance.now()` at the first delta of the current turn. */
	let firstTokenTime: number | null = null
	/**
	 * Set only by {@link ChatController.stop}, so the catch block can tell a
	 * deliberate stop from a real failure — instead of the fragile, over-broad
	 * approach of matching "aborted" in an error message, which silently
	 * swallows genuine engine errors.
	 */
	let userAborted = false

	/** Route streamed deltas into the active turn's two regions. */
	function wireConversationEvents(): void {
		conversation?.on("message.delta", (payload) => {
			const event = asMessageDelta(payload)
			if (!turn || !event) return
			const { delta, kind } = event

			// Measured outside the `kind` branch on purpose: a turn that opens with
			// reasoning would otherwise not be timed until its first answer token.
			if (firstTokenTime === null) {
				firstTokenTime = performance.now()
			}

			// The conversation is created with `parseThink: true`, so the framework
			// has already split the stream — each channel goes to its own region.
			if (kind === "reasoning") turn.appendThought(delta)
			else if (kind === "text") turn.appendAnswer(delta)
		})

		// Show a "compacted" marker when the conversation history is folded
		// (auto-compaction). The `compact` event fires with `state: "complete"`
		// after the summary message has been inserted and older messages marked
		// `contextIncluded: false`.
		conversation?.on("compact", (payload) => {
			const state = (payload as { state?: string })?.state
			if (state === "complete") {
				ui.conversation.appendCompactedMarker("conversation compacted")
			}
		})

		// Show a "compacted" marker when a single user message is prompt-compacted
		// before sending (the message was too large for the context window and was
		// summarized into a shorter form).
		conversation?.on("prompt_compactation", () => {
			ui.conversation.appendCompactedMarker("prompt compacted")
		})

		// Show a "compacted" marker when older messages are trimmed from the
		// request to fit the context window, even when auto-compaction is not
		// enabled. The `context.trimmed` event fires from `applyContextBudget`
		// after `fitContextToWindow` drops oldest messages from the request.
		conversation?.on("context.trimmed", () => {
			ui.conversation.appendCompactedMarker("context trimmed")
		})
	}

	/**
	 * Rebuild the conversation from its own snapshot, yielding a fresh, idle
	 * instance that preserves the full message history.
	 *
	 * A conversation owns a single-use `AbortController`: once `abort()` is
	 * called its status sticks at `"aborted"` and its signal stays tripped, so
	 * every later `sendMessage` silently yields nothing. `loadConversation()`
	 * builds a NEW instance with a fresh controller and `idle` status, which
	 * un-poisons it while keeping the history intact.
	 */
	async function refreshConversation(): Promise<void> {
		if (!conversation) return
		try {
			// Preserve `parseThink: true` across reloads — without this, the
			// agent loop would stop splitting ` IMDONE` tags and reasoning
			// would bleed into the answer text.
			conversation = await bh.loadConversation(conversation.toJSON(), { parseThink: true })
			wireConversationEvents()
		} catch (error) {
			console.error("Failed to refresh conversation:", error)
		}
	}

	/** Read the engine's stats for the turn just finished and render them. */
	async function updateTelemetry(): Promise<void> {
		if (!conversation) return

		// The WebLLM engine's `runtimeStatsText()` is only meaningful for
		// in-browser inference. Remote providers (vLLM, Ollama, LM Studio,
		// OpenAI) don't run on the MLCEngine, so the call throws or returns
		// empty stats. Make it best-effort so the rest of the telemetry —
		// token counts, TTFT, context usage — still renders for those
		// providers; only prefill/decode tok/s are WebLLM-specific.
		let prefillTps: number | null = null
		let decodeTps: number | null = null
		try {
			const stats = parseRuntimeStats(await engine.runtimeStatsText())
			prefillTps = stats.prefillTps
			decodeTps = stats.decodeTps
		} catch {
			// Not a WebLLM-backed turn — leave tok/s as em dashes.
		}
		const decodeRatio = thermalRatio(decodeTps ?? 0)

		const { inputTokens = 0, outputTokens = 0 } = conversation.usage
		const contextWindow = ui.modelSelect.selectedModel?.capabilities?.contextWindow
		// Use the last turn's real input tokens (the actual context size the
		// provider processed) for the context usage percentage — not the
		// cumulative output tokens, which don't represent context fill.
		const lastInputTokens = conversation.contextUsage?.lastInputTokens
		const lastOutputTokens = conversation.contextUsage?.lastOutputTokens
		const ttftMs = firstTokenTime === null ? null : firstTokenTime - sendStartTime

		ui.telemetry.updateStats({
			prefillTps: formatTps(prefillTps),
			decodeTps: formatTps(decodeTps),
			ttft: ttftMs === null ? "—" : formatSeconds(ttftMs / 1000),
			inputTokens: formatTokens(inputTokens),
			outputTokens: formatTokens(outputTokens),
			totalTokens: formatTokens(inputTokens + outputTokens),
			lastTurnInput: lastInputTokens !== undefined ? formatTokens(lastInputTokens) : "—",
			lastTurnOutput: lastOutputTokens !== undefined ? formatTokens(lastOutputTokens) : "—",
			contextWindow,
			contextUsagePercent:
				contextWindow && lastInputTokens !== undefined
					? Math.round((lastInputTokens / contextWindow) * 100)
					: null,
			decodeColor: thermalColor(decodeRatio),
			decodeRatio,
		})
	}

	return {
		get activeConversationId(): string | null {
			return conversation?.id ?? null
		},
		get currentModelRef(): string | null {
			return currentModelRef
		},

		async selectModel(modelRef) {
			if (!modelRef) return

			try {
				ui.composer.setState("idle")
				modelLoaded = false
				ui.status.set("cold", "cold")
				ui.coldStart.hide()

				currentModelRef = modelRef

				// Clear the conversation view: a new conversation means a
				// blank slate. Without this, old messages from the previous
				// conversation linger in the DOM.
				ui.conversation.clear()

				// A fresh conversation per model selection, rather than swapping the
				// model mid-conversation: the simplest correct behavior.
				//
				// `parseThink: true` makes the framework split `<think>...</think>` out
				// of the model's text stream — reasoning arrives as `message.delta`
				// with `kind: "reasoning"`, the answer as `kind: "text"`. WebLLM has no
				// native reasoning channel, so without this the example would have to
				// parse the tags itself.
				conversation = await bh.createConversation({
					model: modelRef,
					parseThink: true,
				})
				wireConversationEvents()
			} catch (error) {
				console.error("Failed to create conversation:", error)
				ui.conversation.showTurnError("Failed to load model — try again.")
			}
		},

		async send(text) {
			if (!conversation) return

			// Recover if a previous turn left the conversation non-idle. Without
			// this, every later send would silently produce nothing.
			if (conversation.status !== "idle") {
				await refreshConversation()
			}

			userAborted = false
			ui.conversation.clearEmptyState()
			ui.conversation.appendUserMessage(text)

			// Clear and disable the input, but leave the button enabled as "Stop" so
			// the user can actually cancel.
			ui.composer.clear()
			ui.composer.setState("generating")

			turn = ui.conversation.beginAssistantTurn()
			sendStartTime = performance.now()
			firstTokenTime = null

			try {
				if (!modelLoaded) {
					ui.status.set("warming", "warming")
				}

				// If the model is not yet loaded, the driver's lazy `ensureModelLoaded`
				// triggers `engine.reload(...)`, which fires the `initProgressCallback`
				// registered at engine creation — that is where cold-start progress
				// comes from.
				await conversation.sendMessage(text)

				if (!modelLoaded) {
					modelLoaded = true
					ui.coldStart.hide()
					ui.status.set("ready", "ready")
				}

				try {
					await updateTelemetry()
				} catch (statsError) {
					console.warn("Failed to extract runtime stats:", statsError)
				}
			} catch (error) {
				if (userAborted) {
					console.log("Generation stopped by user.")
				} else {
					// Surface the real error instead of swallowing it. A non-fatal
					// inline message keeps the composer usable so the user can retry.
					console.error("Message send failed:", error)
					const detail = error instanceof Error ? error.message : String(error)
					ui.conversation.showTurnError(`Failed to generate a response: ${detail}`)
				}
			} finally {
				turn = null
				ui.composer.setState("idle")

				// A stopped or otherwise non-idle conversation is poisoned; reload it
				// from its snapshot so the next send works.
				if (userAborted || conversation.status !== "idle") {
					await refreshConversation()
				}

				if (modelLoaded) {
					ui.status.set("ready", "ready")
				}
			}
		},

		stop() {
			userAborted = true
			try {
				conversation?.abort("user stopped")
			} catch (error) {
				console.error("Abort failed:", error)
			}
		},

		setConversation(conv) {
			conversation = conv
			turn = null
			firstTokenTime = null
			wireConversationEvents()

			// Replay the loaded conversation's message history into the view.
			// The view is purely imperative — it only shows what was streamed
			// into it — so without this, loading a past conversation would
			// leave the old (or empty) view in place.
			ui.conversation.loadMessages(conv.toJSON().messages)
		},

		async newConversation() {
			if (currentModelRef) {
				await this.selectModel(currentModelRef)
			}
		},
	}
}
