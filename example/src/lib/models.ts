/**
 * @file Pure helpers for shaping the kernel's merged model catalogue before it
 * reaches the picker.
 *
 * DOM-free by convention (see `example/AGENTS.md`) so every branch is
 * unit-testable in Node.
 */

import type { ModelInfo } from "@bhzai/core"

/**
 * The `meta.state` value LM Studio reports for a downloaded-but-idle model.
 * Loaded models report `'loaded'`; every other driver reports no `state` at all.
 */
const NOT_LOADED = "not-loaded"

/**
 * The `meta.type` values that name a model the chat UI can actually talk to.
 *
 * `'chat'` is what the OpenAI driver reports; `'llm'` and `'vlm'` are LM
 * Studio's. Every other value — `'embeddings'`, `'audio'`, `'image'`,
 * `'moderation'`, `'completion'` — names a model that cannot hold a
 * conversation.
 */
const CONVERSATIONAL_TYPES = new Set(["chat", "llm", "vlm"])

/**
 * Drop catalogue entries the picker should not offer.
 *
 * Two narrow rules, each keyed on an **explicit** `meta` field so that entries
 * carrying no metadata at all — every WebLLM and Ollama model — always pass
 * through:
 *
 * 1. **`meta.state === 'not-loaded'`.** LM Studio lists every model it has
 *    downloaded, loaded or not. An idle model is technically usable — LM Studio
 *    JIT-loads it on first use — but selecting one stalls the first message
 *    behind a multi-gigabyte load with no progress feedback, and a picker
 *    holding a dozen idle models buries the one that is actually warm.
 * 2. **A `meta.type` that is not conversational.** OpenAI's `/v1/models`
 *    returns its whole multi-modal catalogue in one response — speech, image,
 *    moderation and embedding models sit alongside the chat ones — so without
 *    this the picker fills with entries (`dall-e-3`, `whisper-1`) that error on
 *    first use. It also drops embedding models from the LM Studio catalogue,
 *    which are unusable here for the same reason.
 *
 * The explicit-value requirement is load-bearing: the WebLLM driver reports
 * `availability: 'downloadable'` for its whole catalogue, so filtering on
 * `availability` instead would empty the picker the demo is built around, and
 * filtering on the *absence* of `meta.type` would empty it just as thoroughly.
 *
 * Consequence worth knowing: if no LM Studio model is loaded, that provider
 * contributes nothing to the picker even though its row shows connected. Load a
 * model in LM Studio and the next `models.changed` refresh picks it up.
 *
 * @param models - The merged catalogue from `bh.listModels()`
 * @returns The entries worth showing, in their original order
 */
export function selectableModels(models: ModelInfo[]): ModelInfo[] {
	return models.filter((model) => {
		if (model.meta?.state === NOT_LOADED) return false
		const type = model.meta?.type
		return typeof type !== "string" || CONVERSATIONAL_TYPES.has(type)
	})
}
