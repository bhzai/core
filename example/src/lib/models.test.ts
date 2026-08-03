/** @file Tests for the catalogue-shaping helpers. */

import type { ModelInfo } from "@bhzai/core"
import { describe, expect, it } from "vitest"
import { selectableModels } from "./models.js"

/** Build a catalogue entry, defaulting the fields these tests do not care about. */
function model(overrides: Partial<ModelInfo> & { id: string }): ModelInfo {
	return {
		ref: `test/${overrides.id}`,
		driver: "test",
		capabilities: { streaming: true, toolCalls: false, reasoning: false },
		availability: "ready",
		...overrides,
	}
}

describe("selectableModels", () => {
	it("drops LM Studio models that are downloaded but not loaded", () => {
		const catalogue = [
			model({ id: "warm", driver: "lmstudio", meta: { state: "loaded" } }),
			model({ id: "idle", driver: "lmstudio", meta: { state: "not-loaded" } }),
		]
		expect(selectableModels(catalogue).map((m) => m.id)).toEqual(["warm"])
	})

	it("keeps entries that carry no state at all", () => {
		// WebLLM and Ollama models never report `meta.state`.
		const catalogue = [
			model({ id: "webllm-model", driver: "webllm", availability: "downloadable" }),
			model({ id: "ollama-model", driver: "ollama", meta: { size: 42 } }),
			model({ id: "no-meta", driver: "ollama" }),
		]
		expect(selectableModels(catalogue)).toHaveLength(3)
	})

	it("does not filter on availability — WebLLM reports its whole catalogue as downloadable", () => {
		const catalogue = [
			model({ id: "a", driver: "webllm", availability: "downloadable" }),
			model({ id: "b", driver: "webllm", availability: "downloadable" }),
		]
		expect(selectableModels(catalogue)).toHaveLength(2)
	})

	it("preserves the original order of the entries it keeps", () => {
		const catalogue = [
			model({ id: "first", meta: { state: "loaded" } }),
			model({ id: "dropped", meta: { state: "not-loaded" } }),
			model({ id: "second" }),
			model({ id: "third", meta: { state: "loaded" } }),
		]
		expect(selectableModels(catalogue).map((m) => m.id)).toEqual(["first", "second", "third"])
	})

	it("returns an empty list when every entry is idle, rather than falling back to all", () => {
		const catalogue = [
			model({ id: "a", driver: "lmstudio", meta: { state: "not-loaded" } }),
			model({ id: "b", driver: "lmstudio", meta: { state: "not-loaded" } }),
		]
		expect(selectableModels(catalogue)).toEqual([])
	})

	it("handles an empty catalogue", () => {
		expect(selectableModels([])).toEqual([])
	})

	it("drops the non-conversational half of OpenAI's multi-modal catalogue", () => {
		const catalogue = [
			model({ id: "gpt-4o-mini", driver: "openai", meta: { type: "chat" } }),
			model({ id: "text-embedding-3-small", driver: "openai", meta: { type: "embeddings" } }),
			model({ id: "whisper-1", driver: "openai", meta: { type: "audio" } }),
			model({ id: "dall-e-3", driver: "openai", meta: { type: "image" } }),
			model({ id: "omni-moderation-latest", driver: "openai", meta: { type: "moderation" } }),
			model({ id: "davinci-002", driver: "openai", meta: { type: "completion" } }),
		]
		expect(selectableModels(catalogue).map((m) => m.id)).toEqual(["gpt-4o-mini"])
	})

	it("keeps LM Studio's conversational types and drops its embedding models", () => {
		const catalogue = [
			model({ id: "llama", driver: "lmstudio", meta: { type: "llm", state: "loaded" } }),
			model({ id: "vision", driver: "lmstudio", meta: { type: "vlm", state: "loaded" } }),
			model({ id: "nomic", driver: "lmstudio", meta: { type: "embeddings", state: "loaded" } }),
		]
		expect(selectableModels(catalogue).map((m) => m.id)).toEqual(["llama", "vision"])
	})

	it("keeps entries whose meta carries no type at all", () => {
		// Ollama reports meta without a `type`; WebLLM reports none.
		const catalogue = [
			model({ id: "ollama-model", driver: "ollama", meta: { size: 42 } }),
			model({ id: "webllm-model", driver: "webllm", availability: "downloadable" }),
		]
		expect(selectableModels(catalogue)).toHaveLength(2)
	})
})
