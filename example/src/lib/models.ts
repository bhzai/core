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
 * Drop catalogue entries the picker should not offer.
 *
 * Today that is exactly one case: LM Studio lists every model it has
 * downloaded, loaded or not, and surfaces the distinction as `meta.state`. An
 * idle model is technically usable — LM Studio JIT-loads it on first use — but
 * selecting one stalls the first message behind a multi-gigabyte load with no
 * progress feedback, and a picker holding a dozen idle models buries the one
 * that is actually warm.
 *
 * The test is deliberately narrow: only an **explicit** `state` of
 * `'not-loaded'` is filtered. Entries carrying no `state` — every WebLLM and
 * Ollama model — pass through untouched. That distinction is load-bearing: the
 * WebLLM driver reports `availability: 'downloadable'` for its whole
 * catalogue, so filtering on `availability` instead would empty the picker the
 * demo is built around.
 *
 * Consequence worth knowing: if no LM Studio model is loaded, that provider
 * contributes nothing to the picker even though its row shows connected. Load a
 * model in LM Studio and the next `models.changed` refresh picks it up.
 *
 * @param models - The merged catalogue from `bh.listModels()`
 * @returns The entries worth showing, in their original order
 */
export function selectableModels(models: ModelInfo[]): ModelInfo[] {
	return models.filter((model) => model.meta?.state !== NOT_LOADED)
}
