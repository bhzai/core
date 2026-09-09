/** @file Test for the quickstart example — runs real BHZAI/OllamaDriver logic with a mocked HTTP layer */

import { beforeEach, describe, expect, it, vi } from "vitest"
import { runQuickstart } from "./readme-quickstart.js"

describe("readme-quickstart example", () => {
	beforeEach(() => {
		// Mock the global fetch to intercept Ollama HTTP calls
		vi.stubGlobal("fetch", mockOllamaFetch)
	})

	it("runs without throwing and produces a non-empty response", async () => {
		// This should complete without error and demonstrate the full flow:
		// - BHZAI instance creation
		// - Driver registration and initialization
		// - Conversation creation
		// - Message sending through the agent loop
		const result = await runQuickstart()
		// Verify the result has a non-empty content string
		expect(result).toBeDefined()
		expect(result.content).toBeTruthy()
		expect(result.content.length).toBeGreaterThan(0)
	})
})

/**
 * Mock Ollama HTTP layer — returns realistic responses for:
 * - GET /api/tags (list available models)
 * - GET /api/show (model info/capabilities)
 * - POST /api/chat (streaming chat)
 * - POST /api/embed (embeddings, if requested)
 */
async function mockOllamaFetch(input: string | Request, init?: RequestInit): Promise<Response> {
	const url = typeof input === "string" ? input : input.url
	const method = init?.method ?? "GET"
	const body = init?.body

	// GET /api/tags — list available models
	if (url.includes("/api/tags") && method === "GET") {
		return new Response(
			JSON.stringify({
				models: [
					{
						name: "llama3.3",
						model: "llama3.3",
						size: 45e9,
						digest: "abc123...",
						details: {
							family: "llama",
							parameter_size: "70B",
							quantization_level: "Q4",
						},
					},
				],
			}),
			{
				status: 200,
				headers: { "content-type": "application/json" },
			},
		)
	}

	// GET /api/show — model capabilities
	if (url.includes("/api/show") && method === "POST") {
		return new Response(
			JSON.stringify({
				capabilities: ["tools", "embedding"],
				model_info: {
					context_window: 8192,
				},
			}),
			{
				status: 200,
				headers: { "content-type": "application/json" },
			},
		)
	}

	// POST /api/chat — streaming chat with NDJSON response
	if (url.includes("/api/chat") && method === "POST") {
		// Build a mock response stream (NDJSON format)
		// The Ollama driver emits deltas only from chunks where done: false.
		// Chunks with done: true cause the generator to return, so content in them is lost.
		// Therefore, emit content in a done: false chunk, then a done: true chunk with no content.
		const chunks = [
			JSON.stringify({
				model: "llama3.3",
				created_at: new Date().toISOString(),
				message: {
					role: "assistant",
					content: "Hello! I'm Claude, a helpful AI assistant. Nice to meet you.",
				},
				done: false,
			}),
			JSON.stringify({
				model: "llama3.3",
				created_at: new Date().toISOString(),
				message: {
					role: "assistant",
					content: "",
				},
				done: true,
			}),
		]

		const ndjsonBody = `${chunks.join("\n")}\n`

		// Return a response with a readable stream body
		return new Response(ndjsonBody, {
			status: 200,
			headers: { "content-type": "application/x-ndjson" },
		})
	}

	// POST /api/embed — embeddings (if ever called)
	if (url.includes("/api/embed") && method === "POST") {
		return new Response(
			JSON.stringify({
				embeddings: [[0.1, 0.2, 0.3, 0.4]],
			}),
			{
				status: 200,
				headers: { "content-type": "application/json" },
			},
		)
	}

	// Fallback: return a 404 for unmocked endpoints
	return new Response(JSON.stringify({ error: "Not mocked" }), {
		status: 404,
		headers: { "content-type": "application/json" },
	})
}
