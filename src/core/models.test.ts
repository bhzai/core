// TASK_0022 — Model selection & switching tests (§ 10.5).
//
// These tests cover `parseModelRef`, `resolveModelRef`, the catalogue merge
// (`listModels`), the four-tier resolution order (`resolveConversationModel`),
// and `setModel`'s switching semantics. They use mock drivers and mock
// `modelSource` contributions — no real driver or plugin registry is
// consulted.

import { describe, expect, it, vi } from "vitest"

import type { BHZAIDriver, ModelInfo } from "../types/index.js"
import {
	AmbiguousModelError,
	type ConversationModelState,
	ModelNotFoundError,
	type ModelSelectedPayload,
	ModelUnavailableError,
	NoModelError,
	listModels,
	parseModelRef,
	resolveConversationModel,
	resolveModelRef,
	setModel,
} from "./models.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a mock ModelInfo entry. */
function mockModel(
	ref: string,
	availability: ModelInfo["availability"] = "ready",
	overrides: Partial<ModelInfo> = {},
): ModelInfo {
	const [driver, id] = ref.split("/")
	return {
		ref,
		driver,
		id,
		capabilities: {
			streaming: true,
			toolCalls: false,
			reasoning: false,
		},
		availability,
		...overrides,
	}
}

/** Build a mock BHZAIDriver that reports a fixed list of models. */
function mockDriver(id: string, models: ModelInfo[]): BHZAIDriver {
	return {
		id,
		listModels: vi.fn(async () => models),
		capabilities: vi.fn(() => ({
			streaming: true,
			toolCalls: false,
			reasoning: false,
		})),
		chat: vi.fn(async function* () {}),
	} as unknown as BHZAIDriver
}

// ---------------------------------------------------------------------------
// parseModelRef
// ---------------------------------------------------------------------------

describe("parseModelRef", () => {
	it("splits on the first slash", () => {
		expect(parseModelRef("ollama/llama3.3:70b")).toEqual({
			driver: "ollama",
			id: "llama3.3:70b",
		})
	})

	it("handles ids containing slashes (split on first only)", () => {
		expect(parseModelRef("webllm/meta/Llama-3.2-3B")).toEqual({
			driver: "webllm",
			id: "meta/Llama-3.2-3B",
		})
	})

	it("returns null for bare ids (no slash)", () => {
		expect(parseModelRef("llama3.3:70b")).toBeNull()
	})
})

// ---------------------------------------------------------------------------
// resolveModelRef
// ---------------------------------------------------------------------------

describe("resolveModelRef", () => {
	it("resolves a bare id unique across drivers", () => {
		const catalogue: ModelInfo[] = [
			mockModel("ollama/llama3.3:70b"),
			mockModel("webllm/Llama-3.2-3B"),
		]
		expect(resolveModelRef("llama3.3:70b", catalogue)).toBe("ollama/llama3.3:70b")
	})

	it("returns a qualified ref unchanged when it exists", () => {
		const catalogue: ModelInfo[] = [mockModel("ollama/llama3.3:70b")]
		expect(resolveModelRef("ollama/llama3.3:70b", catalogue)).toBe("ollama/llama3.3:70b")
	})

	it("throws AmbiguousModelError for a bare id in multiple drivers", () => {
		const catalogue: ModelInfo[] = [
			mockModel("webllm/shared-model"),
			mockModel("ollama/shared-model"),
		]
		try {
			resolveModelRef("shared-model", catalogue)
			expect.fail("should have thrown")
		} catch (err) {
			expect(err).toBeInstanceOf(AmbiguousModelError)
			const e = err as AmbiguousModelError
			expect(e.alternatives).toContain("webllm/shared-model")
			expect(e.alternatives).toContain("ollama/shared-model")
			expect(e.alternatives).toHaveLength(2)
		}
	})

	it("throws ModelNotFoundError for a non-existent bare id", () => {
		const catalogue: ModelInfo[] = [mockModel("ollama/llama3.3:70b")]
		expect(() => resolveModelRef("nonexistent", catalogue)).toThrow(ModelNotFoundError)
	})

	it("throws ModelNotFoundError for a non-existent qualified ref", () => {
		const catalogue: ModelInfo[] = [mockModel("ollama/llama3.3:70b")]
		expect(() => resolveModelRef("ollama/nonexistent", catalogue)).toThrow(ModelNotFoundError)
	})
})

// ---------------------------------------------------------------------------
// listModels (catalogue merge)
// ---------------------------------------------------------------------------

describe("listModels (catalogue merge)", () => {
	it("merges driver models and modelSource contributions", async () => {
		const ollama = mockDriver("ollama", [mockModel("ollama/llama3.3:70b", "ready")])
		const webllm = mockDriver("webllm", [mockModel("webllm/Llama-3.2-3B", "downloadable")])
		const contributions: ModelInfo[] = [
			mockModel("huggingface/some-model", "ready", {
				driver: "huggingface",
			}),
		]

		const merged = await listModels([ollama, webllm], contributions)

		expect(merged).toHaveLength(3)
		expect(merged.find((m) => m.ref === "ollama/llama3.3:70b")?.availability).toBe("ready")
		expect(merged.find((m) => m.ref === "webllm/Llama-3.2-3B")?.availability).toBe("downloadable")
		// Unmatched driver → forced to 'unavailable'
		expect(merged.find((m) => m.ref === "huggingface/some-model")?.availability).toBe("unavailable")
	})

	it("leaves modelSource entries with matching driver as-is", async () => {
		const ollama = mockDriver("ollama", [mockModel("ollama/llama3.3:70b", "ready")])
		// A modelSource contribution for a known-but-unpulled Ollama model.
		const contributions: ModelInfo[] = [
			mockModel("ollama/qwen2:7b", "downloadable", { driver: "ollama" }),
		]

		const merged = await listModels([ollama], contributions)

		const qwen = merged.find((m) => m.ref === "ollama/qwen2:7b")
		expect(qwen).toBeDefined()
		expect(qwen?.availability).toBe("downloadable")
	})

	it("driver entry wins over modelSource duplicate", async () => {
		const ollama = mockDriver("ollama", [mockModel("ollama/llama3.3:70b", "ready")])
		// modelSource also reports the same ref with a different availability.
		const contributions: ModelInfo[] = [
			mockModel("ollama/llama3.3:70b", "downloadable", { driver: "ollama" }),
		]

		const merged = await listModels([ollama], contributions)

		// Only one entry, and it's the driver's ('ready'), not the
		// contribution's ('downloadable').
		const matches = merged.filter((m) => m.ref === "ollama/llama3.3:70b")
		expect(matches).toHaveLength(1)
		expect(matches[0]?.availability).toBe("ready")
	})
})

// ---------------------------------------------------------------------------
// resolveConversationModel (four-tier resolution)
// ---------------------------------------------------------------------------

describe("resolveConversationModel", () => {
	const catalogue: ModelInfo[] = [
		mockModel("ollama/llama3.3:70b", "ready"),
		mockModel("webllm/Llama-3.2-3B", "downloadable"),
	]
	const noResolve = async () => undefined

	it("tier 1: explicit model wins over default and model.resolve", async () => {
		const result = await resolveConversationModel({
			explicitModel: "ollama/llama3.3:70b",
			defaultModel: "webllm/Llama-3.2-3B",
			emitModelResolveEvent: async () => ({ model: "webllm/Llama-3.2-3B" }),
			catalogue,
		})
		expect(result).toBe("ollama/llama3.3:70b")
	})

	it("tier 2: default model wins when no explicit model", async () => {
		const result = await resolveConversationModel({
			defaultModel: "ollama/llama3.3:70b",
			emitModelResolveEvent: async () => ({ model: "webllm/Llama-3.2-3B" }),
			catalogue,
		})
		expect(result).toBe("ollama/llama3.3:70b")
	})

	it("tier 3: model.resolve event used when no explicit or default", async () => {
		const result = await resolveConversationModel({
			emitModelResolveEvent: async () => ({ model: "ollama/llama3.3:70b" }),
			catalogue,
		})
		expect(result).toBe("ollama/llama3.3:70b")
	})

	it("tier 4: first ready catalogue entry used when nothing else", async () => {
		const result = await resolveConversationModel({
			emitModelResolveEvent: noResolve,
			catalogue,
		})
		expect(result).toBe("ollama/llama3.3:70b")
	})

	it("throws NoModelError when catalogue is empty and nothing configured", async () => {
		await expect(
			resolveConversationModel({
				emitModelResolveEvent: noResolve,
				catalogue: [],
			}),
		).rejects.toThrow(NoModelError)
	})

	it("tier 4 does NOT fall back to 'downloadable'", async () => {
		const downloadableOnly: ModelInfo[] = [mockModel("webllm/Llama-3.2-3B", "downloadable")]
		await expect(
			resolveConversationModel({
				emitModelResolveEvent: noResolve,
				catalogue: downloadableOnly,
			}),
		).rejects.toThrow(NoModelError)
	})
})

// ---------------------------------------------------------------------------
// setModel
// ---------------------------------------------------------------------------

describe("setModel", () => {
	function makeState(
		activeModelRef = "ollama/llama3.3:70b",
		streaming = false,
	): { state: ConversationModelState; events: ModelSelectedPayload[] } {
		const events: ModelSelectedPayload[] = []
		const state: ConversationModelState = {
			activeModelRef,
			isStreaming: () => streaming,
			catalogue: [
				mockModel("ollama/llama3.3:70b", "ready"),
				mockModel("webllm/Llama-3.2-3B", "downloadable"),
				mockModel("closedai/gpt-x", "unavailable"),
			],
		}
		return { state, events }
	}

	it("applies immediately when not streaming", () => {
		const { state, events } = makeState()
		const emit = vi.fn((p: ModelSelectedPayload) => events.push(p))

		const result = setModel(state, "webllm/Llama-3.2-3B", "set", emit)

		expect(result.applied).toBe(true)
		expect(result.applyQueued).toBeUndefined()
		expect(state.activeModelRef).toBe("webllm/Llama-3.2-3B")
		expect(events).toHaveLength(1)
		expect(events[0]).toEqual({
			model: "webllm/Llama-3.2-3B",
			previousModel: "ollama/llama3.3:70b",
			source: "set",
		})
	})

	it("throws ModelUnavailableError for unavailable model", () => {
		const { state } = makeState()
		const emit = vi.fn()
		expect(() => setModel(state, "closedai/gpt-x", "set", emit)).toThrow(ModelUnavailableError)
	})

	it("accepts 'downloadable' model without throwing", () => {
		const { state } = makeState()
		const emit = vi.fn()
		const result = setModel(state, "webllm/Llama-3.2-3B", "set", emit)
		expect(result.applied).toBe(true)
		expect(state.activeModelRef).toBe("webllm/Llama-3.2-3B")
	})

	it("queues the switch when streaming, applies after settle", () => {
		const { state, events } = makeState()
		state.isStreaming = () => true
		const emit = vi.fn((p: ModelSelectedPayload) => events.push(p))

		const result = setModel(state, "webllm/Llama-3.2-3B", "set", emit)

		// Not applied immediately.
		expect(result.applied).toBe(false)
		expect(result.applyQueued).toBeDefined()
		expect(state.activeModelRef).toBe("ollama/llama3.3:70b")
		expect(events).toHaveLength(0)

		// Simulate the turn settling.
		state.isStreaming = () => false
		result.applyQueued?.()

		// Now applied.
		expect(state.activeModelRef).toBe("webllm/Llama-3.2-3B")
		expect(events).toHaveLength(1)
		expect(events[0]).toEqual({
			model: "webllm/Llama-3.2-3B",
			previousModel: "ollama/llama3.3:70b",
			source: "set",
		})
	})

	it("fires model.selected with source: 'set'", () => {
		const { state, events } = makeState()
		const emit = vi.fn((p: ModelSelectedPayload) => events.push(p))
		setModel(state, "webllm/Llama-3.2-3B", "set", emit)
		expect(events[0]?.source).toBe("set")
	})

	it("fires model.selected with source: 'load'", () => {
		const { state, events } = makeState()
		const emit = vi.fn((p: ModelSelectedPayload) => events.push(p))
		setModel(state, "webllm/Llama-3.2-3B", "load", emit)
		expect(events[0]?.source).toBe("load")
	})

	it("fires model.selected with source: 'resolve'", () => {
		const { state, events } = makeState()
		const emit = vi.fn((p: ModelSelectedPayload) => events.push(p))
		setModel(state, "webllm/Llama-3.2-3B", "resolve", emit)
		expect(events[0]?.source).toBe("resolve")
	})
})
