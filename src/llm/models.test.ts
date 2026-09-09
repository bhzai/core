import { describe, expect, it } from "vitest"
import type { BHZAIDriver } from "../types/driver"
import type { ModelInfo } from "../types/model"
import { AmbiguousModelError, DriverNotFoundError, ModelNotFoundError } from "./errors"
import { mergeDriverCatalogues, parseModelRef, resolveModel } from "./models"

function createMockDriver(id: string, models: string[] = []): BHZAIDriver {
	return {
		id,
		async listModels(): Promise<ModelInfo[]> {
			return models.map((m) => ({
				id: m,
				driver: id,
				ref: `${id}/${m}`,
				capabilities: { streaming: true, toolCalls: true, reasoning: false },
				availability: "ready",
			}))
		},
		capabilities() {
			return { streaming: true, toolCalls: true, reasoning: false }
		},
		async *chat() {
			yield { type: "done", stopReason: "stop" }
		},
	}
}

describe("parseModelRef", () => {
	it("parses qualified model references splitting on the first slash", () => {
		expect(parseModelRef("openai/gpt-4o")).toEqual({ driver: "openai", id: "gpt-4o" })
		expect(parseModelRef("ollama/llama3:8b")).toEqual({ driver: "ollama", id: "llama3:8b" })
		expect(parseModelRef("hf/org/model-name")).toEqual({ driver: "hf", id: "org/model-name" })
	})

	it("returns null for bare model identifiers without a slash", () => {
		expect(parseModelRef("gpt-4o")).toBeNull()
		expect(parseModelRef("claude-3-5-sonnet")).toBeNull()
	})
})

describe("mergeDriverCatalogues", () => {
	it("merges catalogues across multiple drivers and deduplicates refs", async () => {
		const driver1 = createMockDriver("openai", ["gpt-4o", "gpt-4o-mini"])
		const driver2 = createMockDriver("ollama", ["llama3"])

		const merged = await mergeDriverCatalogues([driver1, driver2])
		expect(merged).toHaveLength(3)
		expect(merged[0].ref).toBe("openai/gpt-4o")
		expect(merged[1].ref).toBe("openai/gpt-4o-mini")
		expect(merged[2].ref).toBe("ollama/llama3")
	})

	it("gracefully tolerates drivers that throw during listModels", async () => {
		const working = createMockDriver("openai", ["gpt-4o"])
		const failing: BHZAIDriver = {
			id: "broken",
			async listModels() {
				throw new Error("Connection failed")
			},
			capabilities() {
				return { streaming: false, toolCalls: false, reasoning: false }
			},
			async *chat() {
				yield { type: "done", stopReason: "stop" }
			},
		}

		const merged = await mergeDriverCatalogues([working, failing])
		expect(merged).toHaveLength(1)
		expect(merged[0].id).toBe("gpt-4o")
	})
})

describe("resolveModel", () => {
	it("resolves qualified ref with registered driver", () => {
		const openai = createMockDriver("openai", ["gpt-4o"])
		const drivers = new Map([["openai", openai]])
		const catalogue: ModelInfo[] = [
			{
				id: "gpt-4o",
				driver: "openai",
				ref: "openai/gpt-4o",
				capabilities: { streaming: true, toolCalls: true, reasoning: false },
				availability: "ready",
			},
		]

		const resolved = resolveModel("openai/gpt-4o", drivers, catalogue)
		expect(resolved.driver).toBe(openai)
		expect(resolved.model).toBe("gpt-4o")
		expect(resolved.qualifiedRef).toBe("openai/gpt-4o")
	})

	it("throws DriverNotFoundError when qualified ref references unregistered driver", () => {
		const drivers = new Map<string, BHZAIDriver>()
		expect(() => resolveModel("missing/model", drivers, [])).toThrow(DriverNotFoundError)
	})

	it("throws ModelNotFoundError when model does not exist in driver catalogue", () => {
		const openai = createMockDriver("openai", ["gpt-4o"])
		const drivers = new Map([["openai", openai]])
		const catalogue: ModelInfo[] = [
			{
				id: "gpt-4o",
				driver: "openai",
				ref: "openai/gpt-4o",
				capabilities: { streaming: true, toolCalls: true, reasoning: false },
				availability: "ready",
			},
		]

		expect(() => resolveModel("openai/gpt-3", drivers, catalogue)).toThrow(ModelNotFoundError)
	})

	it("resolves bare model ID unambiguously when exactly one match exists", () => {
		const openai = createMockDriver("openai", ["gpt-4o"])
		const ollama = createMockDriver("ollama", ["llama3"])
		const drivers = new Map([
			["openai", openai],
			["ollama", ollama],
		])
		const catalogue: ModelInfo[] = [
			{
				id: "gpt-4o",
				driver: "openai",
				ref: "openai/gpt-4o",
				capabilities: { streaming: true, toolCalls: true, reasoning: false },
				availability: "ready",
			},
			{
				id: "llama3",
				driver: "ollama",
				ref: "ollama/llama3",
				capabilities: { streaming: true, toolCalls: true, reasoning: false },
				availability: "ready",
			},
		]

		const resolved = resolveModel("llama3", drivers, catalogue)
		expect(resolved.driver).toBe(ollama)
		expect(resolved.model).toBe("llama3")
		expect(resolved.qualifiedRef).toBe("ollama/llama3")
	})

	it("throws AmbiguousModelError when bare ID matches across multiple drivers", () => {
		const openai = createMockDriver("openai", ["common-model"])
		const vllm = createMockDriver("vllm", ["common-model"])
		const drivers = new Map([
			["openai", openai],
			["vllm", vllm],
		])
		const catalogue: ModelInfo[] = [
			{
				id: "common-model",
				driver: "openai",
				ref: "openai/common-model",
				capabilities: { streaming: true, toolCalls: true, reasoning: false },
				availability: "ready",
			},
			{
				id: "common-model",
				driver: "vllm",
				ref: "vllm/common-model",
				capabilities: { streaming: true, toolCalls: true, reasoning: false },
				availability: "ready",
			},
		]

		expect(() => resolveModel("common-model", drivers, catalogue)).toThrow(AmbiguousModelError)
	})

	it("resolves bare ID to single active driver when catalogue has no match", () => {
		const openai = createMockDriver("openai", [])
		const drivers = new Map([["openai", openai]])

		const resolved = resolveModel("custom-ft-model", drivers, [])
		expect(resolved.driver).toBe(openai)
		expect(resolved.model).toBe("custom-ft-model")
		expect(resolved.qualifiedRef).toBe("openai/custom-ft-model")
	})

	it("throws ModelNotFoundError when bare ID matches nothing and multiple drivers exist", () => {
		const d1 = createMockDriver("d1")
		const d2 = createMockDriver("d2")
		const drivers = new Map([
			["d1", d1],
			["d2", d2],
		])

		expect(() => resolveModel("unknown-model", drivers, [])).toThrow(ModelNotFoundError)
	})
})
