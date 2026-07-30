/** @file Tests for TASK_0032: `complete()` one-shot LLM utility */

import { beforeEach, describe, expect, it, vi } from "vitest"
import type { BHZAIDriver, ChatRequest, DriverEvent } from "../types/driver.js"
import type { BHZAIMessage } from "../types/message.js"
import type { ModelInfo } from "../types/model.js"
import { BHZAI } from "./bhzai.js"
import { type CompleteRequest, complete } from "./complete.js"
import { AmbiguousModelError, NoModelError } from "./models.js"

/**
 * Helper: create a minimal mock BHZAIDriver that yields hardcoded events.
 * The returned driver's `chat()` is a vi.fn() so call counts and arguments are trackable.
 */
function makeMockDriver(
	driverId: string,
	modelId: string,
	yieldFn?: (request: ChatRequest) => AsyncIterable<DriverEvent>,
): BHZAIDriver {
	const defaultYield = async function* (): AsyncIterable<DriverEvent> {
		yield { type: "delta", text: "hello" }
		yield { type: "usage", inputTokens: 10, outputTokens: 2 }
		yield { type: "done", stopReason: "stop" }
	}

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
				},
				availability: "ready",
			},
		],
		capabilities: () => ({
			streaming: true,
			toolCalls: false,
			reasoning: false,
		}),
		chat: vi.fn(yieldFn ? yieldFn : defaultYield),
		embed: undefined,
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

describe("complete() — one-shot LLM utility", () => {
	describe("Basic round trip", () => {
		it("concatenates deltas and captures usage from driver events", async () => {
			const driver = makeMockDriver("test-driver", "test-model", async function* () {
				yield { type: "delta", text: "hello" }
				yield { type: "delta", text: " " }
				yield { type: "delta", text: "world" }
				yield { type: "usage", inputTokens: 42, outputTokens: 5 }
				yield { type: "done", stopReason: "stop" }
			})
			const bh = setupbhzai(driver)
			await bh.init()

			const result = await bh.complete({
				model: "test-model",
				messages: "test message",
			})

			expect(result.text).toBe("hello world")
			expect(result.usage).toEqual({ inputTokens: 42, outputTokens: 5 })
		})

		it("defaults usage to zeros if no usage event is emitted", async () => {
			const driver = makeMockDriver("minimal", "model", async function* () {
				yield { type: "delta", text: "just text" }
				yield { type: "done", stopReason: "stop" }
			})
			const bh = setupbhzai(driver)
			await bh.init()

			const result = await bh.complete({
				model: "model",
				messages: "test",
			})

			expect(result.text).toBe("just text")
			expect(result.usage).toEqual({ inputTokens: 0, outputTokens: 0 })
		})
	})

	describe("Zero conversation event-bus activity", () => {
		it("never fires message/tool/context/loop/turn events", async () => {
			const driver = makeMockDriver("driver", "model")
			const bh = setupbhzai(driver)
			await bh.init()

			// Register spies on framework bus for conversation-scoped events.
			const messageSpy = vi.fn()
			const toolSpy = vi.fn()
			const contextSpy = vi.fn()
			const loopSpy = vi.fn()
			const turnSpy = vi.fn()

			bh.on("message", messageSpy)
			bh.on("tool", toolSpy)
			bh.on("context", contextSpy)
			bh.on("loop", loopSpy)
			bh.on("turn", turnSpy)

			// Also check for conversation-mirrored forms if they somehow exist.
			const convMessageSpy = vi.fn()
			const convToolSpy = vi.fn()
			bh.on("conversation.message", convMessageSpy)
			bh.on("conversation.tool", convToolSpy)

			await bh.complete({
				model: "model",
				messages: "test",
			})

			// None of these should have fired.
			expect(messageSpy).not.toHaveBeenCalled()
			expect(toolSpy).not.toHaveBeenCalled()
			expect(contextSpy).not.toHaveBeenCalled()
			expect(loopSpy).not.toHaveBeenCalled()
			expect(turnSpy).not.toHaveBeenCalled()
			expect(convMessageSpy).not.toHaveBeenCalled()
			expect(convToolSpy).not.toHaveBeenCalled()
		})
	})

	describe("Model resolution — reuse of four-tier resolver", () => {
		it("resolves ambiguous bare model id to AmbiguousModelError (proving it uses real resolver)", async () => {
			// Two drivers with the same bare model id.
			const driver1 = makeMockDriver("driver1", "gpt4")
			const driver2 = makeMockDriver("driver2", "gpt4") // same bare id, different driver

			const bh = setupbhzai(driver1, driver2)
			await bh.init()

			// Trying to use the bare model id should fail with AmbiguousModelError,
			// proving complete() is using the real resolver (not a hand-rolled fallback).
			await expect(
				bh.complete({
					model: "gpt4", // bare id — ambiguous across two drivers
					messages: "test",
				}),
			).rejects.toThrow(AmbiguousModelError)
		})

		it("uses qualified model ref to disambiguate", async () => {
			const driver1 = makeMockDriver("driver1", "gpt4")
			const driver2 = makeMockDriver("driver2", "gpt4")

			const bh = setupbhzai(driver1, driver2)
			await bh.init()

			// Qualified ref should succeed.
			const result = await bh.complete({
				model: "driver1/gpt4", // fully qualified
				messages: "test",
			})

			expect(result.text).toBe("hello")
		})

		it("throws NoModelError when no model can be resolved", async () => {
			const bh = new BHZAI()
			await bh.init()

			// No drivers registered, no default model.
			await expect(
				bh.complete({
					messages: "test",
				}),
			).rejects.toThrow(NoModelError)
		})
	})

	describe("Message normalization", () => {
		it("converts bare string to single user message with correct content", async () => {
			const driver = makeMockDriver("d", "m", async function* (req) {
				yield { type: "delta", text: "ok" }
				yield { type: "done", stopReason: "stop" }
				// Capture the request to verify message structure.
				expect(req.messages).toHaveLength(1)
				expect(req.messages[0].role).toBe("user")
				expect(req.messages[0].content).toBe("hi there")
			})
			const bh = setupbhzai(driver)
			await bh.init()

			await bh.complete({
				model: "m",
				messages: "hi there",
			})
		})

		it("passes BHZAIMessage array through unchanged", async () => {
			const messages: BHZAIMessage[] = [
				{
					id: "msg1",
					role: "user",
					content: "first",
					blocks: [{ type: "text", text: "first" }],
					time: Date.now(),
					meta: {},
					append() {},
					setContent() {},
				},
				{
					id: "msg2",
					role: "assistant",
					content: "second",
					blocks: [{ type: "text", text: "second" }],
					time: Date.now(),
					meta: {},
					append() {},
					setContent() {},
				},
			]

			const capturedRequests: ChatRequest[] = []
			const driver = makeMockDriver("d", "m", async function* (req) {
				capturedRequests.push(req)
				yield { type: "delta", text: "ok" }
				yield { type: "done", stopReason: "stop" }
			})
			const bh = setupbhzai(driver)
			await bh.init()

			await bh.complete({
				model: "m",
				messages,
			})

			expect(capturedRequests).toHaveLength(1)
			expect(capturedRequests[0].messages).toHaveLength(2)
			expect(capturedRequests[0].messages[0].id).toBe("msg1")
			expect(capturedRequests[0].messages[0].role).toBe("user")
			expect(capturedRequests[0].messages[1].id).toBe("msg2")
			expect(capturedRequests[0].messages[1].role).toBe("assistant")
		})
	})

	describe("Abort signal handling", () => {
		it("rejects immediately if signal is already aborted (no driver call)", async () => {
			const driver = makeMockDriver("d", "m")
			const bh = setupbhzai(driver)
			await bh.init()

			const controller = new AbortController()
			controller.abort()

			await expect(
				bh.complete({
					model: "m",
					messages: "test",
					signal: controller.signal,
				}),
			).rejects.toMatchObject({ name: "AbortError" })

			// Verify driver.chat was never called.
			expect(driver.chat).not.toHaveBeenCalled()
		})

		it("does not resolve model or check driver registry if signal is already aborted", async () => {
			const bh = new BHZAI()
			await bh.init()

			const controller = new AbortController()
			controller.abort()

			// No drivers registered; if model resolution were attempted, it would fail.
			// But abort guard should prevent that.
			await expect(
				bh.complete({
					messages: "test",
					signal: controller.signal,
				}),
			).rejects.toMatchObject({ name: "AbortError" })
		})
	})

	describe("System prompt and params", () => {
		it("includes systemPrompt in ChatRequest", async () => {
			const capturedRequests: ChatRequest[] = []
			const driver = makeMockDriver("d", "m", async function* (req) {
				capturedRequests.push(req)
				yield { type: "delta", text: "ok" }
				yield { type: "done", stopReason: "stop" }
			})
			const bh = setupbhzai(driver)
			await bh.init()

			await bh.complete({
				model: "m",
				messages: "test",
				systemPrompt: "You are helpful.",
			})

			expect(capturedRequests[0].systemPrompt).toBe("You are helpful.")
		})

		it("includes params in ChatRequest", async () => {
			const capturedRequests: ChatRequest[] = []
			const driver = makeMockDriver("d", "m", async function* (req) {
				capturedRequests.push(req)
				yield { type: "delta", text: "ok" }
				yield { type: "done", stopReason: "stop" }
			})
			const bh = setupbhzai(driver)
			await bh.init()

			await bh.complete({
				model: "m",
				messages: "test",
				params: { temperature: 0.7, maxTokens: 100 },
			})

			expect(capturedRequests[0].params).toEqual({ temperature: 0.7, maxTokens: 100 })
		})
	})

	describe("Defensive event handling", () => {
		it("ignores reasoning-delta, tool-call-delta, tool-call events", async () => {
			const driver = makeMockDriver("d", "m", async function* () {
				yield { type: "delta", text: "hello" }
				yield { type: "reasoning-delta", text: "thinking..." }
				yield { type: "tool-call-delta", toolCallId: "t1", argsDelta: "{" }
				yield { type: "tool-call", toolCallId: "t1", name: "fake-tool", input: {} }
				yield { type: "usage", inputTokens: 10, outputTokens: 2 }
				yield { type: "done", stopReason: "stop" }
			})
			const bh = setupbhzai(driver)
			await bh.init()

			const result = await bh.complete({
				model: "m",
				messages: "test",
			})

			// Should only contain the delta text, ignoring the fake tool events.
			expect(result.text).toBe("hello")
		})
	})

	describe("Driver error handling", () => {
		it("propagates done event with error", async () => {
			const testError = new Error("Driver exploded")
			const driver = makeMockDriver("d", "m", async function* () {
				yield { type: "delta", text: "partial" }
				yield { type: "done", stopReason: "error", error: testError }
			})
			const bh = setupbhzai(driver)
			await bh.init()

			await expect(
				bh.complete({
					model: "m",
					messages: "test",
				}),
			).rejects.toBe(testError)
		})
	})

	describe("ARCHITECTURE.md § 11.7 real-usage shape", () => {
		it("supports the agent-memory extraction call pattern", async () => {
			// Simulate a real memory extraction: extract facts as JSON array.
			const driver = makeMockDriver("extraction-driver", "extraction-model", async function* (req) {
				// Verify the exact call shape from § 11.7.
				expect(req.systemPrompt).toBe(
					"Extract durable user facts/preferences as a JSON string array. Return [] when none.",
				)
				// Messages should be a folded string like "user: ...\nassistant: ..."
				expect(req.messages).toHaveLength(1)
				expect(req.messages[0].role).toBe("user")
				expect(req.messages[0].content).toContain("user: fact1")
				expect(req.messages[0].content).toContain("assistant: response")

				// Yield a JSON array string as the response.
				yield {
					type: "delta",
					text: '["likes coffee", "prefers morning meetings"]',
				}
				yield { type: "usage", inputTokens: 100, outputTokens: 20 }
				yield { type: "done", stopReason: "stop" }
			})
			const bh = setupbhzai(driver)
			await bh.init()

			// Simulate folded messages (as the plugin would do).
			const foldedMessages: Array<{ role: string; content: string }> = [
				{ role: "user", content: "fact1" },
				{ role: "assistant", content: "response" },
			]

			const result = await bh.complete({
				systemPrompt:
					"Extract durable user facts/preferences as a JSON string array. Return [] when none.",
				messages: foldedMessages.map((m) => `${m.role}: ${m.content}`).join("\n"),
			})

			// Verify round-trip through JSON.parse.
			const parsed = JSON.parse(result.text)
			expect(parsed).toEqual(["likes coffee", "prefers morning meetings"])
			expect(result.usage.inputTokens).toBe(100)
			expect(result.usage.outputTokens).toBe(20)
		})
	})

	describe("Synthetic message mutations throw", () => {
		it("throws when append() is called on synthetic message", async () => {
			const driver = makeMockDriver("d", "m", async function* (req) {
				// Extract the synthetic message and try to mutate it.
				const msg = req.messages[0]
				expect(() => msg.append("more text")).toThrow(
					"append() is not supported on complete()'s synthetic messages",
				)
				yield { type: "delta", text: "ok" }
				yield { type: "done", stopReason: "stop" }
			})
			const bh = setupbhzai(driver)
			await bh.init()

			await bh.complete({
				model: "m",
				messages: "test",
			})
		})

		it("throws when setContent() is called on synthetic message", async () => {
			const driver = makeMockDriver("d", "m", async function* (req) {
				// Extract the synthetic message and try to mutate it.
				const msg = req.messages[0]
				expect(() => msg.setContent("new content")).toThrow(
					"setContent() is not supported on complete()'s synthetic messages",
				)
				yield { type: "delta", text: "ok" }
				yield { type: "done", stopReason: "stop" }
			})
			const bh = setupbhzai(driver)
			await bh.init()

			await bh.complete({
				model: "m",
				messages: "test",
			})
		})
	})

	describe("Default model resolution", () => {
		it("uses host defaultModel when no explicit model provided", async () => {
			const driver = makeMockDriver("d", "default-model")
			const bh = new BHZAI({ defaultModel: "d/default-model" })
			bh.addDriver(driver)
			await bh.init()

			const result = await bh.complete({
				// No model specified
				messages: "test",
			})

			expect(result.text).toBe("hello")
		})
	})

	describe("Abort signal passed to ChatRequest", () => {
		it("uses provided signal in ChatRequest", async () => {
			const capturedRequests: ChatRequest[] = []
			const driver = makeMockDriver("d", "m", async function* (req) {
				capturedRequests.push(req)
				yield { type: "delta", text: "ok" }
				yield { type: "done", stopReason: "stop" }
			})
			const bh = setupbhzai(driver)
			await bh.init()

			const signal = new AbortController().signal
			await bh.complete({
				model: "m",
				messages: "test",
				signal,
			})

			expect(capturedRequests[0].signal).toBe(signal)
		})

		it("creates fresh AbortController signal if none provided", async () => {
			const capturedRequests: ChatRequest[] = []
			const driver = makeMockDriver("d", "m", async function* (req) {
				capturedRequests.push(req)
				expect(req.signal).toBeInstanceOf(AbortSignal)
				expect(req.signal.aborted).toBe(false)
				yield { type: "delta", text: "ok" }
				yield { type: "done", stopReason: "stop" }
			})
			const bh = setupbhzai(driver)
			await bh.init()

			await bh.complete({
				model: "m",
				messages: "test",
				// No signal provided
			})
		})
	})

	describe("Standalone function vs class method", () => {
		it("can call complete() directly from bh instance", async () => {
			const driver = makeMockDriver("d", "m")
			const bh = setupbhzai(driver)
			await bh.init()

			// Call as instance method
			const result = await bh.complete({
				model: "m",
				messages: "test",
			})

			expect(result.text).toBe("hello")
		})

		it("exported complete() function works when passed BHZAI instance explicitly", async () => {
			const driver = makeMockDriver("d", "m")
			const bh = setupbhzai(driver)
			await bh.init()

			// Call the exported function directly with defaultModel undefined
			const result = await complete(bh, {
				model: "m",
				messages: "test",
			})

			expect(result.text).toBe("hello")
		})
	})
})
