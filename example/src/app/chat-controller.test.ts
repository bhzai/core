/**
 * @file Tests for the example app chat controller.
 */

import {
	agentLoopPlugin,
	commandsPlugin,
	compactionPlugin,
	contextPlugin,
	createHarness,
	llmPlugin,
	sessionPlugin,
	tokenizerPlugin,
	toolsPlugin,
} from "@bhzai/core"
import type { BHZAIDriver, DriverCapabilities, DriverEvent } from "@bhzai/core"
import type { WebLLM } from "@bhzai/core/plugins/webllm"
import type * as webllm from "@mlc-ai/web-llm"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { type ChatControllerDeps, createChatController } from "./chat-controller.js"

class MockDriver implements BHZAIDriver {
	readonly id = "webllm"

	capabilities(): DriverCapabilities {
		return { streaming: true, toolCalls: false, reasoning: false, contextWindow: 4096 }
	}

	async listModels() {
		return [
			{
				id: "mock-model",
				driver: "webllm",
				ref: "webllm/mock-model",
				availability: "ready" as const,
				capabilities: {
					streaming: true,
					toolCalls: false,
					reasoning: false,
					contextWindow: 4096,
				},
			},
		]
	}

	async *chat(): AsyncIterable<DriverEvent> {
		yield {
			type: "delta",
			text: "Hello! ",
		}
		yield {
			type: "delta",
			text: "How can I help you?",
		}
		yield {
			type: "usage",
			inputTokens: 10,
			outputTokens: 8,
			totalTokens: 18,
		}
		yield {
			type: "done",
			stopReason: "stop",
		}
	}
}

describe("chat controller", () => {
	let harness: Awaited<ReturnType<typeof createHarness>>
	let driver: MockDriver
	let fakeEngine: webllm.MLCEngine
	let fakeUi: ChatControllerDeps["ui"]
	let currentTurn: {
		appendThought: ReturnType<typeof vi.fn>
		appendAnswer: ReturnType<typeof vi.fn>
	}

	beforeEach(async () => {
		driver = new MockDriver()
		fakeEngine = {
			runtimeStatsText: vi.fn().mockResolvedValue("prefill: 100 tok/s, decode: 25 tok/s"),
		} as unknown as webllm.MLCEngine

		currentTurn = {
			appendThought: vi.fn(),
			appendAnswer: vi.fn(),
		}

		fakeUi = {
			status: { set: vi.fn() },
			composer: {
				setState: vi.fn(),
				clear: vi.fn(),
			},
			conversation: {
				clear: vi.fn(),
				clearEmptyState: vi.fn(),
				appendUserMessage: vi.fn(),
				beginAssistantTurn: vi.fn().mockReturnValue(currentTurn),
				showTurnError: vi.fn(),
				appendCompactedMarker: vi.fn(),
				loadMessages: vi.fn(),
			},
			telemetry: {
				updateStats: vi.fn(),
			},
			coldStart: {
				hide: vi.fn(),
				show: vi.fn(),
			},
			modelSelect: {
				selectedModel: {
					id: "mock-model",
					capabilities: { contextWindow: 4096 },
				},
			},
		} as unknown as ChatControllerDeps["ui"]

		harness = await createHarness({
			plugins: [
				sessionPlugin,
				llmPlugin,
				toolsPlugin,
				commandsPlugin,
				tokenizerPlugin,
				contextPlugin,
				compactionPlugin,
				agentLoopPlugin,
			],
		})
		harness.addDriver(driver)
	})

	it("creates a conversation when selecting a model", async () => {
		const controller = createChatController({
			bh: harness,
			engine: fakeEngine,
			driver: driver as unknown as WebLLM,
			ui: fakeUi,
		})

		await controller.selectModel("webllm/mock-model")

		expect(controller.currentModelRef).toBe("webllm/mock-model")
		expect(controller.activeConversationId).toBeDefined()
		expect(fakeUi.conversation.clear).toHaveBeenCalled()
	})

	it("sends a message, streams response, and updates telemetry", async () => {
		const controller = createChatController({
			bh: harness,
			engine: fakeEngine,
			driver: driver as unknown as WebLLM,
			ui: fakeUi,
		})

		await controller.selectModel("webllm/mock-model")
		await controller.send("Hi there")

		expect(fakeUi.conversation.appendUserMessage).toHaveBeenCalledWith("Hi there")
		expect(fakeUi.conversation.beginAssistantTurn).toHaveBeenCalled()
		expect(currentTurn.appendAnswer).toHaveBeenCalledWith("Hello! ")
		expect(currentTurn.appendAnswer).toHaveBeenCalledWith("How can I help you?")
		expect(fakeUi.telemetry.updateStats).toHaveBeenCalled()
		expect(fakeUi.status.set).toHaveBeenCalledWith("ready", "ready")
	})

	it("handles stop/abort cleanly", async () => {
		const controller = createChatController({
			bh: harness,
			engine: fakeEngine,
			driver: driver as unknown as WebLLM,
			ui: fakeUi,
		})

		await controller.selectModel("webllm/mock-model")
		controller.stop()
		expect(fakeUi.composer.setState).not.toHaveBeenCalledWith("generating")
	})

	it("streams reasoning deltas to appendThought", async () => {
		const reasoningDriver: BHZAIDriver = {
			id: "webllm",
			capabilities: () => ({
				streaming: true,
				toolCalls: false,
				reasoning: true,
				contextWindow: 4096,
			}),
			async listModels() {
				return [
					{
						id: "mock-reasoning-model",
						driver: "webllm",
						ref: "webllm/mock-reasoning-model",
						availability: "ready" as const,
						capabilities: {
							streaming: true,
							toolCalls: false,
							reasoning: true,
							contextWindow: 4096,
						},
					},
				]
			},
			async *chat(): AsyncIterable<DriverEvent> {
				yield {
					type: "reasoning-delta",
					text: "Thinking carefully...",
				}
				yield {
					type: "delta",
					text: "The answer is 42.",
				}
				yield {
					type: "done",
					stopReason: "stop",
				}
			},
		}

		const customHarness = await createHarness({
			plugins: [
				sessionPlugin,
				llmPlugin,
				toolsPlugin,
				commandsPlugin,
				tokenizerPlugin,
				contextPlugin,
				compactionPlugin,
				agentLoopPlugin,
			],
		})
		customHarness.addDriver(reasoningDriver)

		const controller = createChatController({
			bh: customHarness,
			engine: fakeEngine,
			driver: reasoningDriver as unknown as WebLLM,
			ui: fakeUi,
		})

		await controller.selectModel("webllm/mock-reasoning-model")
		await controller.send("What is the meaning of life?")

		expect(currentTurn.appendThought).toHaveBeenCalledWith("Thinking carefully...")
		expect(currentTurn.appendAnswer).toHaveBeenCalledWith("The answer is 42.")
	})
})
