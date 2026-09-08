import { describe, expect, it } from "vitest"
import { createHarness } from "../kernel"
import type { BHZAIDriver, ChatRequest, DriverEvent } from "../types/driver"
import type { ModelInfo } from "../types/model"
import { ContextOverflowError, NoModelError } from "./errors"
import { llmPlugin } from "./plugin"
import type { LlmService } from "./types"

function createStubDriver(id: string, models: string[] = []): BHZAIDriver {
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
		async *chat(req: ChatRequest): AsyncIterable<DriverEvent> {
			yield { type: "delta", text: `Response from ${id} for ${req.model}` }
			yield { type: "usage", inputTokens: 10, outputTokens: 5 }
			yield { type: "done", stopReason: "stop" }
		},
	}
}

describe("llmPlugin & LlmService", () => {
	it("registers llm service on ctx.llm and manages drivers", async () => {
		const harness = await createHarness({ plugins: [llmPlugin] })
		const llm = harness.ctx.llm as LlmService

		expect(llm).toBeDefined()

		const modelsChangedEvents: unknown[] = []
		harness.ctx.events.on("models.changed", () => {
			modelsChangedEvents.push(true)
		})

		const driver1 = createStubDriver("d1", ["m1"])
		const unregister = llm.addDriver(driver1)

		expect(llm.getDriver("d1")).toBe(driver1)
		expect(llm.listDrivers()).toHaveLength(1)
		expect(modelsChangedEvents).toHaveLength(1)

		const catalogue = await llm.listModels()
		expect(catalogue).toHaveLength(1)
		expect(catalogue[0].ref).toBe("d1/m1")

		// Unregister driver
		unregister()
		expect(llm.getDriver("d1")).toBeUndefined()
		expect(llm.listDrivers()).toHaveLength(0)
		expect(modelsChangedEvents).toHaveLength(2)

		await harness.dispose()
	})

	it("manages default model configuration", async () => {
		const harness = await createHarness({ plugins: [llmPlugin] })
		const llm = harness.ctx.llm as LlmService

		expect(llm.getDefaultModel()).toBeUndefined()
		llm.setDefaultModel("openai/gpt-4o")
		expect(llm.getDefaultModel()).toBe("openai/gpt-4o")

		const driver = createStubDriver("openai", ["gpt-4o"])
		llm.addDriver(driver)

		const resolved = await llm.resolveModel()
		expect(resolved.driver).toBe(driver)
		expect(resolved.model).toBe("gpt-4o")

		await harness.dispose()
	})

	it("throws NoModelError when resolving without explicit model or default", async () => {
		const harness = await createHarness({ plugins: [llmPlugin] })
		const llm = harness.ctx.llm as LlmService

		await expect(llm.resolveModel()).rejects.toThrow(NoModelError)
		await harness.dispose()
	})

	it("streams generation through request waterfall pipeline", async () => {
		const harness = await createHarness({ plugins: [llmPlugin] })
		const llm = harness.ctx.llm as LlmService
		const driver = createStubDriver("ollama", ["llama3"])
		llm.addDriver(driver)

		let intercepted = false
		harness.ctx.events.waterfall("request", async (rawReq, ctx, next) => {
			intercepted = true
			expect((ctx as { driverId: string }).driverId).toBe("ollama")
			const req = rawReq as ChatRequest
			const transformed: ChatRequest = {
				...req,
				systemPrompt: "Injected system instruction",
			}
			return await next(transformed)
		})

		const events: DriverEvent[] = []
		for await (const event of llm.stream({
			model: "ollama/llama3",
			messages: [],
		})) {
			events.push(event)
		}

		expect(intercepted).toBe(true)
		expect(events.length).toBeGreaterThan(0)
		expect(events[0]).toEqual({ type: "delta", text: "Response from ollama for llama3" })

		await harness.dispose()
	})

	it("normalizes context length overflow into ContextOverflowError", async () => {
		const harness = await createHarness({ plugins: [llmPlugin] })
		const llm = harness.ctx.llm as LlmService

		const overflowDriver: BHZAIDriver = {
			id: "openai",
			async listModels() {
				return []
			},
			capabilities() {
				return { streaming: true, toolCalls: false, reasoning: false }
			},
			async *chat() {
				yield* []
				throw {
					status: 400,
					body: {
						error: {
							message: "This model's maximum context length is 8192 tokens.",
							code: "context_length_exceeded",
						},
					},
				}
			},
		}

		llm.addDriver(overflowDriver)

		await expect(async () => {
			for await (const _ of llm.stream({
				model: "openai/gpt-4o",
				messages: [],
			})) {
				// empty
			}
		}).rejects.toThrow(ContextOverflowError)

		await harness.dispose()
	})

	it("executes complete() as a one-shot helper", async () => {
		const harness = await createHarness({ plugins: [llmPlugin] })
		const llm = harness.ctx.llm as LlmService
		const driver = createStubDriver("mock", ["m1"])
		llm.addDriver(driver)

		const result = await llm.complete({
			model: "mock/m1",
			messages: "Summarize this text",
		})

		expect(result.text).toBe("Response from mock for m1")
		expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 5 })

		await harness.dispose()
	})

	it("integrates with existing v0.1 drivers without requiring modifications", async () => {
		const harness = await createHarness({ plugins: [llmPlugin] })
		const llm = harness.ctx.llm as LlmService

		const driverIds = ["webllm", "ollama", "lmstudio", "openai", "vllm"]
		for (const id of driverIds) {
			const driver: BHZAIDriver = {
				id,
				async listModels() {
					return [
						{
							id: "test-model",
							driver: id,
							ref: `${id}/test-model`,
							capabilities: { streaming: true, toolCalls: true, reasoning: false },
							availability: "ready",
						},
					]
				},
				capabilities() {
					return { streaming: true, toolCalls: true, reasoning: false }
				},
				async *chat() {
					yield { type: "delta", text: `output-${id}` }
					yield { type: "done", stopReason: "stop" }
				},
			}

			const unregister = llm.addDriver(driver)
			expect(llm.getDriver(id)).toBe(driver)

			const res = await llm.complete({
				model: `${id}/test-model`,
				messages: "Ping",
			})
			expect(res.text).toBe(`output-${id}`)
			unregister()
		}

		await harness.dispose()
	})
})
