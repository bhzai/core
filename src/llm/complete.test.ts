import { describe, expect, it } from "vitest"
import type { DriverEvent } from "../types/driver"
import type { BHZAIMessage } from "../types/message"
import { executeComplete } from "./complete"
import type { LlmStreamRequest } from "./types"

describe("executeComplete", () => {
	it("executes completion with string prompt and aggregates delta events", async () => {
		let capturedMessages: BHZAIMessage[] = []

		const mockStream = async function* (req: LlmStreamRequest): AsyncIterable<DriverEvent> {
			capturedMessages = req.messages
			yield { type: "delta", text: "Answer: " }
			yield { type: "delta", text: "42" }
			yield { type: "usage", inputTokens: 5, outputTokens: 2 }
			yield { type: "done", stopReason: "stop" }
		}

		const result = await executeComplete(mockStream, {
			model: "mock-model",
			messages: "What is 6 * 7?",
		})

		expect(capturedMessages).toHaveLength(1)
		expect(capturedMessages[0].role).toBe("user")
		expect(capturedMessages[0].content).toBe("What is 6 * 7?")
		expect(result.text).toBe("Answer: 42")
		expect(result.reasoning).toBeUndefined()
		expect(result.usage).toEqual({ inputTokens: 5, outputTokens: 2 })
	})

	it("passes through existing BHZAIMessage array and aggregates reasoning", async () => {
		const mockStream = async function* (): AsyncIterable<DriverEvent> {
			yield { type: "reasoning-delta", text: "Thinking deeply..." }
			yield { type: "delta", text: "Done." }
			yield { type: "done", stopReason: "stop" }
		}

		const customMessages: BHZAIMessage[] = [
			{
				id: "m1",
				role: "user",
				content: "custom prompt",
				blocks: [{ type: "text", text: "custom prompt" }],
				time: 1000,
				meta: {},
				append(t: string) {
					this.content += t
				},
				setContent(c: string) {
					this.content = c
				},
			},
		]

		const result = await executeComplete(mockStream, {
			messages: customMessages,
		})

		expect(result.text).toBe("Done.")
		expect(result.reasoning).toBe("Thinking deeply...")
	})

	it("rejects immediately if signal is already aborted", async () => {
		const mockStream = async function* (): AsyncIterable<DriverEvent> {
			yield { type: "delta", text: "Unreachable" }
		}

		const controller = new AbortController()
		controller.abort()

		await expect(
			executeComplete(mockStream, {
				messages: "Hello",
				signal: controller.signal,
			}),
		).rejects.toThrow("Aborted")
	})

	it("supports message setters on normalized messages", async () => {
		let capturedMsg: BHZAIMessage | undefined
		const mockStream = async function* (req: LlmStreamRequest): AsyncIterable<DriverEvent> {
			capturedMsg = req.messages[0]
			yield { type: "done", stopReason: "stop" }
		}

		await executeComplete(mockStream, { messages: "Initial" })

		expect(capturedMsg).toBeDefined()
		if (!capturedMsg) throw new Error("Expected captured message")

		capturedMsg.append(" appended")
		expect(capturedMsg.content).toBe("Initial appended")

		capturedMsg.setContent("Reset")
		expect(capturedMsg.content).toBe("Reset")

		capturedMsg.setContent("")
		expect(capturedMsg.content).toBe("")

		capturedMsg.content = "Direct"
		expect(capturedMsg.content).toBe("Direct")
	})
})
