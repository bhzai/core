/** @file Embedding side channel — RAG substrate (TASK_0033, ARCHITECTURE.md § 6, § 11.8) */

import type { BHZAIDriver } from "../types/driver.js"
import type { Usage } from "../types/model.js"
import type { BHZAI } from "./bhzai.js"
import { parseModelRef, resolveConversationModel } from "./models.js"

/**
 * Request options for {@link embed}.
 *
 * @see ARCHITECTURE.md § 6 line 202: the `embed()` signature.
 */
export interface EmbedRequest {
	/** Qualified `'<driver>/<model>'` ref, or bare model id. Resolved via four-tier § 10.5 order. */
	model?: string
	/** Input to embed: bare string or array of strings. Always normalized to string[] before driver call. */
	input: string | string[]
	/** Abort signal for early cancellation. */
	signal?: AbortSignal
}

/**
 * Result of an embedding request.
 *
 * @see ARCHITECTURE.md § 6 line 203: return type.
 */
export interface EmbedResult {
	/**
	 * Embedding vectors. Always an array of arrays, even for single-string input.
	 *
	 * CONVENTION (TASK_0033 resolved assumption): the return shape is **always**
	 * `number[][]`, with exactly one entry when `input` was a single string. This
	 * means callers never branch on whether they passed a string or an array —
	 * `embeddings[0]` is always "the vector for the first (or only) input." The
	 * single-string case does NOT flatten to `number[]`; that would violate the
	 * § 6 signature and force every caller to check input arity.
	 */
	embeddings: number[][]
	/** Token usage, if the driver reports it (optional per § 6/§ 10.1). */
	usage?: Usage
}

/**
 * Embedding side channel — RAG substrate (ARCHITECTURE.md § 6, § 10.1, § 11.8).
 *
 * Resolves a model, checks that the driver declares `embeddings: true` capability,
 * and delegates to `driver.embed()` to produce vectors. Fires zero conversation-bus
 * events; intended as a portable, driver-agnostic indexing substrate for RAG plugins
 * (chunking, embedding, upserting into a vector store).
 *
 * Behavior:
 * 1. **Abort guard**: if `req.signal?.aborted` is already true, reject immediately
 *    without touching model resolution or the driver registry.
 * 2. **Model resolution**: apply the same four-tier resolution order (§ 10.5) used
 *    by conversations and `complete()`, reusing the shared {@link resolveConversationModel}
 *    function verbatim — never reimplement.
 * 3. **Capability guard (the core of this task)**: call `driver.capabilities(modelId)`.
 *    If the result's `embeddings` field is not exactly `true`, throw a clear,
 *    descriptive error identifying both the resolved model ref and the driver id.
 *    **This guard must fire BEFORE any attempt to call `driver.embed()`.** Do not
 *    silently fall back to `chat()` or synthesize fake embeddings — either would
 *    corrupt a downstream vector index without visible error.
 * 4. **Defensive internal-consistency check**: if `capabilities().embeddings === true`
 *    but `driver.embed` is `undefined` (a driver author's bug), throw a distinct,
 *    clearly-worded error (e.g. `` `driver "${driver.id}" declares embeddings
 *    capability but does not implement embed()` ``) rather than letting a raw
 *    `TypeError: driver.embed is not a function` leak out.
 * 5. **Normalize `input`**: if `req.input` is a bare `string`, wrap it as a
 *    single-element `string[]` before calling `driver.embed()` (the driver-level
 *    interface always takes `string[]`, per § 10.1). If `req.input` is already a
 *    `string[]`, pass it through unchanged, preserving order.
 * 6. **Delegate**: call `driver.embed({ model: modelId, input: normalizedInput, signal: req.signal })`
 *    and await its result.
 * 7. **Return shape — the single-string-input convention**: the return shape is
 *    **always** `number[][]`, with exactly one entry when `input` was a single string,
 *    so callers never need to branch on whether they passed a string or an array.
 *    `embeddings[0]` is always "the vector for the first (or only) input."
 * 8. **Usage**: pass through whatever `usage` the driver's `embed()` call returned
 *    verbatim (it is optional per § 6/§ 10.1 — do not synthesize a fallback).
 *
 * @param bh The BHZAI instance (passed explicitly for testability; wired onto the class as a method).
 * @param req The request options.
 * @param defaultModel Optional host-level default model (from `new BHZAI({ defaultModel })`, passed by the class method wrapper).
 * @returns Promise resolving to `{ embeddings, usage? }`.
 * @throws `AbortError` if the request was aborted before starting.
 * @throws `NoModelError` if model resolution failed (§ 10.5 tier 4).
 * @throws `Error` with a clear message if the model's driver does not support embeddings.
 * @throws Any error from the driver call.
 *
 * @internal
 */
export async function embed(
	bh: BHZAI,
	req: EmbedRequest,
	defaultModel?: string,
): Promise<EmbedResult> {
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

	// Step 3: Capability guard — the core of this task.
	const capabilities = driver.capabilities(modelId)
	if (capabilities.embeddings !== true) {
		throw new Error(
			`bh.embed(): model "${resolvedModelRef}" (driver "${driver.id}") does not support embeddings — capabilities().embeddings is not true`,
		)
	}

	// Step 4: Defensive internal-consistency check.
	if (!driver.embed) {
		throw new Error(
			`bh.embed(): driver "${driver.id}" declares embeddings capability but does not implement embed()`,
		)
	}

	// Step 5: Normalize input.
	const normalizedInput = typeof req.input === "string" ? [req.input] : req.input

	// Step 6: Delegate to the driver.
	const result = await driver.embed({
		model: modelId,
		input: normalizedInput,
		signal: req.signal,
	})

	// Step 7 & 8: Return the result as-is (return shape and usage passthrough).
	return {
		embeddings: result.embeddings,
		usage: result.usage,
	}
}
