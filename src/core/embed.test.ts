/** @file Tests for TASK_0033: `embed()` embedding side channel */

import { beforeEach, describe, expect, it, vi } from "vitest"
import type { BHZAIDriver, ChatRequest, DriverEvent } from "../types/driver.js"
import type { DriverCapabilities, ModelInfo } from "../types/model.js"
import { BHZAI } from "./bhzai.js"
import { type EmbedRequest, embed } from "./embed.js"
import { AmbiguousModelError, NoModelError } from "./models.js"

/**
 * Helper: create a minimal mock BHZAIDriver with customizable `capabilities()`,
 * `embed()`, and `chat()` methods for testing the embedding side channel.
 */
function makeMockDriver(
	driverId: string,
	modelId: string,
	overrides?: {
		capabilities?: DriverCapabilities
		embed?: (req: {
			model: string
			input: string[]
			signal?: AbortSignal
		}) => Promise<{ embeddings: number[][]; usage?: { inputTokens: number; outputTokens: number } }>
	},
): BHZAIDriver {
	return {
		id: driverId,
		listModels: async () => [
			{
				ref: `${driverId}/${modelId}`,
				driver: driverId,
				id: modelId,
				label: `${driverId} ${modelId}`,
				capabilities: {
					streaming: true,
					toolCalls: false,
					reasoning: false,
					...overrides?.capabilities,
				},
				availability: "ready",
			},
		],
		capabilities: () => ({
			streaming: true,
			toolCalls: false,
			reasoning: false,
			...overrides?.capabilities,
		}),
		chat: vi.fn(async function* (): AsyncIterable<DriverEvent> {
			yield { type: "delta", text: "hello" }
			yield { type: "done", stopReason: "stop" }
		}),
		embed: overrides?.embed,
	}
}

/**
 * Helper: create a BHZAI instance with registered drivers, ready for testing.
 */
function setupbhzai(...drivers: BHZAIDriver[]): BHZAI {
	const bh = new BHZAI()
	for (const driver of drivers) {
		bh.addDriver(driver)
	}
	return bh
}

describe("embed() — embedding side channel", () => {
	describe("Capability guard — negative case", () => {
		it("throws when embeddings capability is false", async () => {
			const driver = makeMockDriver("test-driver", "test-model", {
				capabilities: {
					streaming: true,
					toolCalls: false,
					reasoning: false,
					embeddings: false,
				},
			})
			const bh = setupbhzai(driver)
			await bh.init()

			await expect(
				bh.embed({
					model: "test-model",
					input: "hello",
				}),
			).rejects.toThrow(/does not support embeddings/)

			// Verify chat was never called (no silent fallback).
			expect(driver.chat).not.toHaveBeenCalled()
		})

		it("throws when embeddings capability is omitted", async () => {
			const driver = makeMockDriver("test-driver", "test-model", {
				capabilities: {
					streaming: true,
					toolCalls: false,
					reasoning: false,
					// embeddings intentionally omitted
				},
			})
			const bh = setupbhzai(driver)
			await bh.init()

			await expect(
				bh.embed({
					model: "test-model",
					input: "hello",
				}),
			).rejects.toThrow(/does not support embeddings/)

			// Verify chat was never called.
			expect(driver.chat).not.toHaveBeenCalled()
		})

		it("includes both model ref and driver id in the error message", async () => {
			const driver = makeMockDriver("my-driver", "my-model", {
				capabilities: {
					streaming: true,
					toolCalls: false,
					reasoning: false,
					embeddings: false,
				},
			})
			const bh = setupbhzai(driver)
			await bh.init()

			try {
				await bh.embed({
					model: "my-model",
					input: "test",
				})
				// Should not reach here.
				expect.fail("Expected error to be thrown")
			} catch (err) {
				const message = String((err as Error).message)
				// Error message should mention both the qualified ref and the driver id.
				expect(message).toContain("my-driver/my-model")
				expect(message).toContain("my-driver")
			}
		})
	})

	describe("Capability guard — positive case", () => {
		it("delegates to embed when embeddings capability is true", async () => {
			const driver = makeMockDriver("test-driver", "test-model", {
				capabilities: {
					streaming: true,
					toolCalls: false,
					reasoning: false,
					embeddings: true,
				},
				embed: vi.fn(async () => ({
					embeddings: [[0.1, 0.2]],
					usage: { inputTokens: 3, outputTokens: 0 },
				})),
			})
			const bh = setupbhzai(driver)
			await bh.init()

			const result = await bh.embed({
				model: "test-model",
				input: "hello",
			})

			expect(result.embeddings).toEqual([[0.1, 0.2]])
			expect(result.usage).toEqual({ inputTokens: 3, outputTokens: 0 })
		})

		it("calls embed exactly once with correct arguments", async () => {
			const embedFn = vi.fn(async () => ({
				embeddings: [[1, 2, 3]],
			}))

			const driver = makeMockDriver("test-driver", "test-model", {
				capabilities: {
					streaming: true,
					toolCalls: false,
					reasoning: false,
					embeddings: true,
				},
				embed: embedFn,
			})
			const bh = setupbhzai(driver)
			await bh.init()

			await bh.embed({
				model: "test-model",
				input: "hello",
			})

			expect(embedFn).toHaveBeenCalledTimes(1)
			// Verify it was called with the normalized input (string → array).
			expect(embedFn).toHaveBeenCalledWith({
				model: "test-model",
				input: ["hello"],
				signal: undefined,
			})
		})
	})

	describe("Single-string input arity", () => {
		it("returns array with one vector for single-string input", async () => {
			const driver = makeMockDriver("d", "m", {
				capabilities: {
					streaming: true,
					toolCalls: false,
					reasoning: false,
					embeddings: true,
				},
				embed: async () => ({
					embeddings: [[1, 2, 3]],
				}),
			})
			const bh = setupbhzai(driver)
			await bh.init()

			const result = await bh.embed({
				model: "m",
				input: "just one string",
			})

			expect(result.embeddings).toHaveLength(1)
			expect(result.embeddings[0]).toEqual([1, 2, 3])
		})

		it("consistently returns number[][] even for single input (not flattened)", async () => {
			const driver = makeMockDriver("d", "m", {
				capabilities: {
					streaming: true,
					toolCalls: false,
					reasoning: false,
					embeddings: true,
				},
				embed: async () => ({
					embeddings: [[5]],
				}),
			})
			const bh = setupbhzai(driver)
			await bh.init()

			const result = await bh.embed({
				model: "m",
				input: "single",
			})

			// Should always be an array of arrays, never a flat array.
			expect(Array.isArray(result.embeddings)).toBe(true)
			expect(Array.isArray(result.embeddings[0])).toBe(true)
			expect(result.embeddings[0]).toEqual([5])
		})
	})

	describe("String-array input arity + order preservation", () => {
		it("preserves order of input strings in embeddings output", async () => {
			const embedFn = vi.fn(
				async (req: {
					model: string
					input: string[]
					signal?: AbortSignal
				}) => ({
					embeddings: [[1], [2], [3]],
				}),
			)

			const driver = makeMockDriver("d", "m", {
				capabilities: {
					streaming: true,
					toolCalls: false,
					reasoning: false,
					embeddings: true,
				},
				embed: embedFn,
			})
			const bh = setupbhzai(driver)
			await bh.init()

			const result = await bh.embed({
				model: "m",
				input: ["a", "b", "c"],
			})

			// Verify order preservation.
			expect(result.embeddings).toHaveLength(3)
			expect(result.embeddings[0]).toEqual([1]) // corresponds to "a"
			expect(result.embeddings[1]).toEqual([2]) // corresponds to "b"
			expect(result.embeddings[2]).toEqual([3]) // corresponds to "c"

			// Verify embed was called with input in the same order.
			expect(embedFn).toHaveBeenCalledWith({
				model: "m",
				input: ["a", "b", "c"],
				signal: undefined,
			})
		})

		it("handles multiple inputs correctly", async () => {
			const driver = makeMockDriver("d", "m", {
				capabilities: {
					streaming: true,
					toolCalls: false,
					reasoning: false,
					embeddings: true,
				},
				embed: async () => ({
					embeddings: [
						[0.1, 0.2],
						[0.3, 0.4],
						[0.5, 0.6],
					],
				}),
			})
			const bh = setupbhzai(driver)
			await bh.init()

			const result = await bh.embed({
				model: "m",
				input: ["text1", "text2", "text3"],
			})

			expect(result.embeddings).toHaveLength(3)
			expect(result.embeddings[1]).toEqual([0.3, 0.4])
		})
	})

	describe("Driver-declares-but-doesn't-implement guard", () => {
		it("throws distinct error when embed is undefined but embeddings capability is true", async () => {
			const driver = makeMockDriver("test-driver", "test-model", {
				capabilities: {
					streaming: true,
					toolCalls: false,
					reasoning: false,
					embeddings: true,
				},
				// Intentionally omit embed implementation
				embed: undefined,
			})
			const bh = setupbhzai(driver)
			await bh.init()

			// Verify it's the distinct internal-consistency error, not a generic TypeError.
			await expect(
				bh.embed({
					model: "test-model",
					input: "hello",
				}),
			).rejects.toThrow(/declares embeddings capability but does not implement embed\(\)/)

			// Also explicitly check the error message contains driver id.
			try {
				await bh.embed({
					model: "test-model",
					input: "hello",
				})
				expect.fail("Should have thrown")
			} catch (err) {
				const message = String((err as Error).message)
				expect(message).toContain("test-driver")
			}
		})

		it("error message differs from generic TypeError", async () => {
			const driver = makeMockDriver("test-driver", "test-model", {
				capabilities: {
					streaming: true,
					toolCalls: false,
					reasoning: false,
					embeddings: true,
				},
				embed: undefined,
			})
			const bh = setupbhzai(driver)
			await bh.init()

			try {
				await bh.embed({
					model: "test-model",
					input: "hello",
				})
				// Should not reach here.
				expect.fail("Expected error to be thrown")
			} catch (err) {
				const message = String((err as Error).message)
				// Should be an actionable error, not "is not a function".
				expect(message).not.toContain("is not a function")
				expect(message).toContain("declares embeddings capability but does not implement embed()")
			}
		})
	})

	describe("Pre-aborted signal", () => {
		it("rejects immediately if signal is already aborted (no resolver or driver call)", async () => {
			const embedFn = vi.fn()
			const capabilitiesFn = vi.fn(() => ({
				streaming: true,
				toolCalls: false,
				reasoning: false,
				embeddings: true,
			}))

			const driver = makeMockDriver("d", "m", {
				capabilities: {
					streaming: true,
					toolCalls: false,
					reasoning: false,
					embeddings: true,
				},
				embed: embedFn,
			})
			// Replace capabilities with a spy.
			driver.capabilities = capabilitiesFn

			const bh = setupbhzai(driver)
			await bh.init()

			const controller = new AbortController()
			controller.abort()

			await expect(
				bh.embed({
					model: "m",
					input: "test",
					signal: controller.signal,
				}),
			).rejects.toMatchObject({ name: "AbortError" })

			// Verify neither capabilities nor embed were called.
			expect(capabilitiesFn).not.toHaveBeenCalled()
			expect(embedFn).not.toHaveBeenCalled()
		})

		it("does not resolve model if signal is already aborted", async () => {
			const bh = new BHZAI()
			await bh.init()

			const controller = new AbortController()
			controller.abort()

			// No drivers registered; if model resolution were attempted, it would fail.
			// But abort guard should prevent that.
			await expect(
				bh.embed({
					input: "test",
					signal: controller.signal,
				}),
			).rejects.toMatchObject({ name: "AbortError" })
		})
	})

	describe("Model resolution — reuse of four-tier resolver", () => {
		it("resolves ambiguous bare model id to AmbiguousModelError", async () => {
			// Two drivers with the same bare model id.
			const driver1 = makeMockDriver("driver1", "gpt4", {
				capabilities: {
					streaming: true,
					toolCalls: false,
					reasoning: false,
					embeddings: true,
				},
			})
			const driver2 = makeMockDriver("driver2", "gpt4", {
				capabilities: {
					streaming: true,
					toolCalls: false,
					reasoning: false,
					embeddings: true,
				},
			})

			const bh = setupbhzai(driver1, driver2)
			await bh.init()

			// Trying to use the bare model id should fail with AmbiguousModelError,
			// proving embed() is using the real resolver.
			await expect(
				bh.embed({
					model: "gpt4", // bare id — ambiguous across two drivers
					input: "test",
				}),
			).rejects.toThrow(AmbiguousModelError)
		})

		it("uses qualified model ref to disambiguate", async () => {
			const driver1 = makeMockDriver("driver1", "gpt4", {
				capabilities: {
					streaming: true,
					toolCalls: false,
					reasoning: false,
					embeddings: true,
				},
				embed: async () => ({
					embeddings: [[1]],
				}),
			})
			const driver2 = makeMockDriver("driver2", "gpt4", {
				capabilities: {
					streaming: true,
					toolCalls: false,
					reasoning: false,
					embeddings: true,
				},
				embed: async () => ({
					embeddings: [[2]],
				}),
			})

			const bh = setupbhzai(driver1, driver2)
			await bh.init()

			// Qualified ref should succeed with driver1's embedding.
			const result = await bh.embed({
				model: "driver1/gpt4", // fully qualified
				input: "test",
			})

			expect(result.embeddings).toEqual([[1]])
		})

		it("throws NoModelError when no model can be resolved", async () => {
			const bh = new BHZAI()
			await bh.init()

			// No drivers registered, no default model.
			await expect(
				bh.embed({
					input: "test",
				}),
			).rejects.toThrow(NoModelError)
		})
	})

	describe("Default model resolution", () => {
		it("uses host defaultModel when no explicit model provided", async () => {
			const driver = makeMockDriver("d", "default-model", {
				capabilities: {
					streaming: true,
					toolCalls: false,
					reasoning: false,
					embeddings: true,
				},
				embed: async () => ({
					embeddings: [[1, 2, 3]],
				}),
			})
			const bh = new BHZAI({ defaultModel: "d/default-model" })
			bh.addDriver(driver)
			await bh.init()

			const result = await bh.embed({
				// No model specified — should use default
				input: "test",
			})

			expect(result.embeddings).toEqual([[1, 2, 3]])
		})
	})

	describe("Usage passthrough", () => {
		it("includes usage when driver provides it", async () => {
			const driver = makeMockDriver("d", "m", {
				capabilities: {
					streaming: true,
					toolCalls: false,
					reasoning: false,
					embeddings: true,
				},
				embed: async () => ({
					embeddings: [[1, 2]],
					usage: { inputTokens: 5, outputTokens: 1 },
				}),
			})
			const bh = setupbhzai(driver)
			await bh.init()

			const result = await bh.embed({
				model: "m",
				input: "test",
			})

			expect(result.usage).toEqual({ inputTokens: 5, outputTokens: 1 })
		})

		it("omits usage when driver doesn't provide it", async () => {
			const driver = makeMockDriver("d", "m", {
				capabilities: {
					streaming: true,
					toolCalls: false,
					reasoning: false,
					embeddings: true,
				},
				embed: async () => ({
					embeddings: [[1, 2]],
					// No usage provided
				}),
			})
			const bh = setupbhzai(driver)
			await bh.init()

			const result = await bh.embed({
				model: "m",
				input: "test",
			})

			expect(result.usage).toBeUndefined()
			expect(result.embeddings).toEqual([[1, 2]])
		})

		it("never synthesizes fallback usage", async () => {
			const driver = makeMockDriver("d", "m", {
				capabilities: {
					streaming: true,
					toolCalls: false,
					reasoning: false,
					embeddings: true,
				},
				embed: async () => ({
					embeddings: [[1]],
				}),
			})
			const bh = setupbhzai(driver)
			await bh.init()

			const result = await bh.embed({
				model: "m",
				input: "test",
			})

			// Should NOT have synthesized a default usage like complete() does.
			expect(result.usage).toBeUndefined()
		})
	})

	describe("Abort signal passed to driver", () => {
		it("passes provided signal to driver embed call", async () => {
			const embedFn = vi.fn(async () => ({
				embeddings: [[1]],
			}))

			const driver = makeMockDriver("d", "m", {
				capabilities: {
					streaming: true,
					toolCalls: false,
					reasoning: false,
					embeddings: true,
				},
				embed: embedFn,
			})
			const bh = setupbhzai(driver)
			await bh.init()

			const signal = new AbortController().signal
			await bh.embed({
				model: "m",
				input: "test",
				signal,
			})

			expect(embedFn).toHaveBeenCalledWith({
				model: "m",
				input: ["test"],
				signal,
			})
		})

		it("passes undefined signal if none provided", async () => {
			const embedFn = vi.fn(async () => ({
				embeddings: [[1]],
			}))

			const driver = makeMockDriver("d", "m", {
				capabilities: {
					streaming: true,
					toolCalls: false,
					reasoning: false,
					embeddings: true,
				},
				embed: embedFn,
			})
			const bh = setupbhzai(driver)
			await bh.init()

			await bh.embed({
				model: "m",
				input: "test",
				// No signal provided
			})

			expect(embedFn).toHaveBeenCalledWith({
				model: "m",
				input: ["test"],
				signal: undefined,
			})
		})
	})

	describe("Standalone function vs class method", () => {
		it("can call embed() directly from bh instance", async () => {
			const driver = makeMockDriver("d", "m", {
				capabilities: {
					streaming: true,
					toolCalls: false,
					reasoning: false,
					embeddings: true,
				},
				embed: async () => ({
					embeddings: [[1, 2, 3]],
				}),
			})
			const bh = setupbhzai(driver)
			await bh.init()

			// Call as instance method
			const result = await bh.embed({
				model: "m",
				input: "test",
			})

			expect(result.embeddings).toEqual([[1, 2, 3]])
		})

		it("exported embed() function works when passed BHZAI instance explicitly", async () => {
			const driver = makeMockDriver("d", "m", {
				capabilities: {
					streaming: true,
					toolCalls: false,
					reasoning: false,
					embeddings: true,
				},
				embed: async () => ({
					embeddings: [[5, 6]],
				}),
			})
			const bh = setupbhzai(driver)
			await bh.init()

			// Call the exported function directly with defaultModel undefined
			const result = await embed(bh, {
				model: "m",
				input: "test",
			})

			expect(result.embeddings).toEqual([[5, 6]])
		})
	})

	describe("Driver error handling", () => {
		it("propagates errors from driver.embed()", async () => {
			const testError = new Error("Driver embed failed")
			const driver = makeMockDriver("d", "m", {
				capabilities: {
					streaming: true,
					toolCalls: false,
					reasoning: false,
					embeddings: true,
				},
				embed: async () => {
					throw testError
				},
			})
			const bh = setupbhzai(driver)
			await bh.init()

			await expect(
				bh.embed({
					model: "m",
					input: "test",
				}),
			).rejects.toBe(testError)
		})
	})
})
