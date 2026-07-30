/** @file One-shot LLM utility — `BHZAI.complete()` (TASK_0032, ARCHITECTURE.md § 6, § 11.7) */

import type { BHZAIDriver, ChatRequest, DriverEvent, GenerationParams } from "../types/driver.js"
import type { BHZAIMessage } from "../types/message.js"
import type { Usage } from "../types/model.js"
import type { BHZAI } from "./bhzai.js"
import { parseModelRef, resolveConversationModel } from "./models.js"
import { DEFAULT_RETRY_POLICY, type RequestDispatch, callDriverWithRetry } from "./retry.js"

/**
 * Request options for {@link complete}.
 *
 * @see ARCHITECTURE.md § 6 line 193: the `complete()` signature.
 */
export interface CompleteRequest {
	/** Qualified `'<driver>/<model>'` ref, or bare model id. Resolved via four-tier § 10.5 order. */
	model?: string
	/** System prompt prepended to messages. */
	systemPrompt?: string
	/** User message content — bare string or array of `BHZAIMessage`. */
	messages: string | BHZAIMessage[]
	/** Generation parameter overrides. */
	params?: GenerationParams
	/** Abort signal for early cancellation. */
	signal?: AbortSignal
}

/**
 * Result of a one-shot LLM call.
 *
 * @see ARCHITECTURE.md § 6 line 194: return type.
 */
export interface CompleteResult {
	/** Concatenated delta text from the driver. */
	text: string
	/** Token usage. Defaults to `{ inputTokens: 0, outputTokens: 0 }` if no usage event. */
	usage: Usage
}

/**
 * One-shot LLM utility — detached from any conversation (ARCHITECTURE.md § 6, § 11.7).
 *
 * Executes a single non-agentic LLM request: resolve a model, send messages,
 * drain the response stream, return the text and token usage. Fires zero
 * conversation-bus events (`message`, `tool`, `context`, `loop`, `turn`); only
 * the `request` lifecycle events (`before`/`retry`/`after`) from the retry wrapper
 * are permitted (ARCHITECTURE.md § 10.1).
 *
 * The substrate for plugins that need autonomous LLM calls without conversation
 * overhead: auto-title (on each new message), summarization (for context
 * pruning), and memory extraction (ARCHITECTURE.md § 11.7 agent-memory example).
 *
 * Behavior:
 * 1. **Abort guard**: if `req.signal?.aborted` is already true, reject immediately
 *    without touching model resolution or the driver registry.
 * 2. **Model resolution**: apply the same four-tier resolution order (§ 10.5) used
 *    by conversations, reusing the shared {@link resolveConversationModel} function
 *    verbatim — never reimplement.
 * 3. **Message normalization**: string → single user message; `BHZAIMessage[]` → pass through.
 * 4. **ChatRequest construction**: build a request with the resolved model, normalized
 *    messages, system prompt, params, and a signal (defaulting to a fresh
 *    `AbortController.signal` if omitted).
 * 5. **Driver call**: use {@link callDriverWithRetry} (never direct `driver.chat()`)
 *    to get retry semantics and `request` lifecycle events.
 * 6. **Stream draining**: iterate events, concatenating `delta` text, capturing
 *    `usage`, stopping at `done`. Defensively ignore `reasoning-delta`,
 *    `tool-call-delta`, `tool-call` (a well-behaved driver shouldn't emit them
 *    for a toolless request, but safeguard rather than throw).
 * 7. **Return**: `{ text, usage }` with a fallback to `{ inputTokens: 0, outputTokens: 0 }`
 *    if no usage event arrived.
 *
 * @param bh The BHZAI instance (passed explicitly for testability; wired onto the class as a method).
 * @param req The request options.
 * @param defaultModel Optional host-level default model (from `new BHZAI({ defaultModel })`, passed by the class method wrapper).
 * @returns Promise resolving to `{ text, usage }`.
 * @throws `AbortError` if the request was aborted before starting.
 * @throws `NoModelError` if model resolution failed (§ 10.5 tier 4).
 * @throws Any error from the driver call (retried by the wrapper).
 *
 * @internal
 */
export async function complete(
	bh: BHZAI,
	req: CompleteRequest,
	defaultModel?: string,
): Promise<CompleteResult> {
	// Step 1: Abort-before-start guard — check FIRST, before any other side effects.
	if (req.signal?.aborted) {
		const err = new DOMException("Aborted", "AbortError")
		throw err
	}

	// Step 2: Resolve the model via the shared § 10.5 resolver.
	// Build the catalogue and the emitModelResolveEvent callback for tier 3.
	const catalogue = await bh.listModels()
	const emitModelResolveEvent = async (): Promise<{ model?: string } | undefined> => {
		// Fire model.resolve on the framework bus (conversation-less context).
		const result = await bh._dispatch("model.resolve", {
			catalogue,
			conversation: undefined,
		})
		// Return the patch if any handler provided a model.
		return (result.patch as { model?: string } | undefined) ?? undefined
	}

	const resolvedModelRef = await resolveConversationModel({
		explicitModel: req.model,
		defaultModel,
		emitModelResolveEvent,
		catalogue,
	})

	// Parse the qualified ref to extract driver id and model id.
	const { driver: driverId, id: modelId } = parseModelRef(resolvedModelRef) ?? {
		driver: "",
		id: "",
	}

	// Look up the actual driver instance.
	const driver = bh._getDriver(driverId)
	if (!driver) {
		throw new Error(
			`Driver "${driverId}" not found (resolved from model ref "${resolvedModelRef}")`,
		)
	}

	// Step 3: Normalize messages.
	const normalizedMessages = normalizeCoreMessages(req.messages)

	// Step 4: Build ChatRequest.
	const chatRequest: ChatRequest = {
		model: modelId,
		messages: normalizedMessages,
		systemPrompt: req.systemPrompt,
		params: req.params,
		signal: req.signal ?? new AbortController().signal,
	}

	// Step 5: Call the driver via the retry wrapper.
	// Use _dispatch.bind(bh) to pass a RequestDispatch callback.
	const dispatch: RequestDispatch = bh._dispatch.bind(bh) as unknown as RequestDispatch
	const driverIter = callDriverWithRetry(driver, chatRequest, DEFAULT_RETRY_POLICY, dispatch)

	// Step 6: Drain the async iterable.
	let text = ""
	let usage: Usage = { inputTokens: 0, outputTokens: 0 }

	for await (const event of driverIter) {
		if (event.type === "delta") {
			text += event.text
		} else if (event.type === "usage") {
			usage = { inputTokens: event.inputTokens, outputTokens: event.outputTokens }
		} else if (event.type === "done") {
			// Terminal event — check for error.
			if (event.stopReason === "error" && event.error) {
				throw event.error
			}
			// Normal stop — iteration is over.
			break
		}
		// Ignore reasoning-delta, tool-call-delta, tool-call defensively.
	}

	// Step 7: Return the result.
	return { text, usage }
}

/**
 * Normalize message input: string → single user message, array → passthrough.
 *
 * This helper synthesizes ephemeral user messages for string input. Their
 * `append()` and `setContent()` methods throw — these messages are created,
 * sent to the driver once, and discarded, so mutating them would indicate a
 * bug in the caller or a plugin that misunderstood `complete()`'s contract
 * (mutation should only happen on conversation messages, which have a
 * lifecycle state machine).
 *
 * @param messages String or `BHZAIMessage` array.
 * @returns Normalized `BHZAIMessage` array ready for the `ChatRequest`.
 */
function normalizeCoreMessages(messages: string | BHZAIMessage[]): BHZAIMessage[] {
	if (typeof messages === "string") {
		// Synthesize a single user message for the string input.
		const syntheticMessage: BHZAIMessage = {
			id: crypto.randomUUID(),
			role: "user",
			content: messages,
			blocks: [{ type: "text", text: messages }],
			time: Date.now(),
			meta: {},
			// These synthetic messages are ephemeral and never mutated; throw if called.
			append() {
				throw new Error("append() is not supported on complete()'s synthetic messages")
			},
			setContent() {
				throw new Error("setContent() is not supported on complete()'s synthetic messages")
			},
		}
		return [syntheticMessage]
	}
	// Array passthrough — assumed to be BHZAIMessage[].
	return messages
}
