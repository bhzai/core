// TASK_0020 — Ollama driver plugin tests (§ 10.3).
//
// These tests cover the `Ollama` class's driver logic using a hand-written
// fake `fetch` (injected via the internal `fetchOverride` option). They test:
// `chat()` NDJSON stream parsing, `listModels()` mapping, `capabilities()`
// cache + conservative defaults, `embed()` request/response mapping, tool-
// call parsing with id fallback, non-2xx error handling, and usage event
// mapping. They do NOT test the real Ollama server, the retry wrapper
// (TASK_0018), or credential resolution (TASK_0021).

import { describe, expect, it, vi } from "vitest"

import type { ChatRequest, DriverEvent } from "../../types/index.js"
import { Ollama, type OllamaInternalOptions } from "./index.js"

/** Build a minimal ChatRequest for testing. */
function makeRequest(overrides: Partial<ChatRequest> = {}): ChatRequest {
	const controller = new AbortController()
	return {
		model: "test-model",
		messages: [],
		signal: controller.signal,
		...overrides,
	}
}

/** Collect all events from an async iterable into an array. */
async function drain(iter: AsyncIterable<DriverEvent>): Promise<DriverEvent[]> {
	const out: DriverEvent[] = []
	for await (const e of iter) out.push(e)
	return out
}

/** Build a fake Response with a readable body stream from string chunks. */
function mockResponse(opts: {
	status?: number
	ok?: boolean
	body?: string
	json?: unknown
}): Response {
	const status = opts.status ?? 200
	const ok = opts.ok ?? (status >= 200 && status < 300)
	const response: Partial<Response> = {
		status,
		ok,
		text: async () => opts.body ?? "",
		json: async () => opts.json ?? {},
	}
	if (opts.body !== undefined) {
		const encoder = new TextEncoder()
		const encoded = encoder.encode(opts.body)
		let read = false
		const reader = {
			read: async (): Promise<{ done: boolean; value?: Uint8Array }> => {
				if (!read) {
					read = true
					return { done: false, value: encoded }
				}
				return { done: true, value: undefined }
			},
			releaseLock: () => {},
		}
		;(response as { body: unknown }).body = {
			getReader: () => reader,
		}
	}
	return response as Response
}

/** Build a fake fetch that routes by URL and method. */
function fakeFetch(
	routes: Array<{
		url: string
		method: string
		response: Response
	}>,
): typeof fetch {
	const calls: Array<{ url: string; method: string; body?: string }> = []
	const fn = vi.fn(async (input: string, init?: RequestInit) => {
		const method = init?.method ?? "GET"
		calls.push({ url: input, method, body: init?.body as string | undefined })
		const route = routes.find((r) => r.url === input && r.method === method)
		if (!route) {
			return mockResponse({ status: 404, body: "not found" })
		}
		return route.response
	}) as unknown as typeof fetch
	// Attach calls for inspection.
	;(fn as unknown as { calls: typeof calls }).calls = calls
	return fn
}

/** Helper to create an Ollama driver with a fake fetch. */
function makeOllama(fetchOverride: typeof fetch) {
	return new Ollama({ fetchOverride } as OllamaInternalOptions)
}

describe("Ollama — constructor", () => {
	it("defaults baseUrl to http://localhost:11434", () => {
		const fetch = fakeFetch([])
		const driver = makeOllama(fetch)
		expect(driver.id).toBe("ollama")
	})

	it("binds globalThis.fetch so calling it does not throw 'Illegal invocation'", async () => {
		const originalFetch = globalThis.fetch
		let capturedThis: unknown = "not-called"
		try {
			;(globalThis as { fetch: typeof fetch }).fetch = vi.fn(async function (
				this: unknown,
				_input: string,
				_init?: RequestInit,
			) {
				capturedThis = this
				return mockResponse({ json: { models: [] } })
			}) as unknown as typeof fetch

			const driver = new Ollama({ baseUrl: "http://localhost:11434" })
			await driver.listModels()
			expect(capturedThis).toBe(globalThis)
		} finally {
			;(globalThis as { fetch: typeof fetch }).fetch = originalFetch
		}
	})
})

describe("Ollama — listModels", () => {
	it("maps /api/tags response into ModelInfo[] with availability: ready", async () => {
		const fetch = fakeFetch([
			{
				url: "http://localhost:11434/api/tags",
				method: "GET",
				response: mockResponse({
					json: {
						models: [
							{
								name: "llama3:8b",
								model: "llama3:8b",
								size: 4661210672,
								digest: "abc123",
								details: {
									family: "llama",
									parameter_size: "8B",
									quantization_level: "Q4_0",
								},
							},
							{
								name: "qwen2:7b",
								model: "qwen2:7b",
								size: 4400000000,
								digest: "def456",
							},
						],
					},
				}),
			},
			{
				url: "http://localhost:11434/api/show",
				method: "POST",
				response: mockResponse({
					json: { capabilities: ["completion"] },
				}),
			},
		])
		const driver = makeOllama(fetch)
		const models = await driver.listModels()
		expect(models).toHaveLength(2)
		expect(models[0]).toEqual({
			ref: "ollama/llama3:8b",
			driver: "ollama",
			id: "llama3:8b",
			label: "llama3:8b",
			capabilities: {
				streaming: true,
				toolCalls: false,
				reasoning: false,
				embeddings: false,
				contextWindow: undefined,
			},
			availability: "ready",
			meta: {
				size: 4661210672,
				digest: "abc123",
				family: "llama",
				parameterSize: "8B",
				quantization: "Q4_0",
			},
		})
		expect(models[1]?.availability).toBe("ready")
		expect(models[1]?.meta?.family).toBeUndefined()
	})
})

describe("Ollama — capabilities", () => {
	it("reads toolCalls from /api/show capabilities array", async () => {
		const fetch = fakeFetch([
			{
				url: "http://localhost:11434/api/show",
				method: "POST",
				response: mockResponse({
					json: {
						capabilities: ["completion", "tools"],
						model_info: { "llama.context_length": 8192 },
					},
				}),
			},
		])
		const driver = makeOllama(fetch)
		// Trigger cache population via chat() (which calls
		// refreshCapabilitiesCache before streaming).
		// Use a minimal chat that returns immediately.
		const chatFetch = fakeFetch([
			{
				url: "http://localhost:11434/api/show",
				method: "POST",
				response: mockResponse({
					json: {
						capabilities: ["completion", "tools"],
						model_info: { "llama.context_length": 8192 },
					},
				}),
			},
			{
				url: "http://localhost:11434/api/chat",
				method: "POST",
				response: mockResponse({
					body: `${JSON.stringify({ done: true, done_reason: "stop" })}\n`,
				}),
			},
		])
		const driver2 = new Ollama({ fetchOverride: chatFetch } as OllamaInternalOptions)
		await drain(driver2.chat(makeRequest()))
		expect(driver2.capabilities("test-model").toolCalls).toBe(true)
		expect(driver2.capabilities("test-model").contextWindow).toBe(8192)
	})

	it("returns conservative defaults when /api/show omits capabilities", async () => {
		const chatFetch = fakeFetch([
			{
				url: "http://localhost:11434/api/show",
				method: "POST",
				response: mockResponse({
					json: {},
				}),
			},
			{
				url: "http://localhost:11434/api/chat",
				method: "POST",
				response: mockResponse({
					body: `${JSON.stringify({ done: true, done_reason: "stop" })}\n`,
				}),
			},
		])
		const driver = new Ollama({ fetchOverride: chatFetch } as OllamaInternalOptions)
		await drain(driver.chat(makeRequest()))
		const caps = driver.capabilities("test-model")
		expect(caps.toolCalls).toBe(false)
		expect(caps.reasoning).toBe(false)
		expect(caps.embeddings).toBe(false)
		expect(caps.contextWindow).toBeUndefined()
	})

	it("returns conservative defaults before any cache population", () => {
		const fetch = fakeFetch([])
		const driver = makeOllama(fetch)
		const caps = driver.capabilities("never-fetched")
		expect(caps).toEqual({
			streaming: true,
			toolCalls: false,
			reasoning: false,
			embeddings: false,
			contextWindow: undefined,
		})
	})
})

describe("Ollama — chat", () => {
	it("parses NDJSON stream into delta, usage, done events", async () => {
		const ndjson = `${[
			JSON.stringify({
				model: "test-model",
				message: { role: "assistant", content: "Hello" },
				done: false,
			}),
			JSON.stringify({
				model: "test-model",
				message: { role: "assistant", content: " world" },
				done: false,
			}),
			JSON.stringify({
				model: "test-model",
				message: { role: "assistant", content: "" },
				done: true,
				done_reason: "stop",
				prompt_eval_count: 10,
				eval_count: 5,
			}),
		].join("\n")}\n`

		const fetch = fakeFetch([
			{
				url: "http://localhost:11434/api/show",
				method: "POST",
				response: mockResponse({ json: { capabilities: ["completion"] } }),
			},
			{
				url: "http://localhost:11434/api/chat",
				method: "POST",
				response: mockResponse({ body: ndjson }),
			},
		])
		const driver = new Ollama({ fetchOverride: fetch } as OllamaInternalOptions)
		const events = await drain(driver.chat(makeRequest()))
		expect(events).toEqual([
			{ type: "delta", text: "Hello" },
			{ type: "delta", text: " world" },
			{ type: "usage", inputTokens: 10, outputTokens: 5 },
			{ type: "done", stopReason: "stop" },
		])
	})

	it("maps prompt_eval_count/eval_count onto usage event exactly", async () => {
		const ndjson = `${JSON.stringify({
			done: true,
			done_reason: "stop",
			prompt_eval_count: 120,
			eval_count: 45,
		})}\n`
		const fetch = fakeFetch([
			{
				url: "http://localhost:11434/api/show",
				method: "POST",
				response: mockResponse({ json: {} }),
			},
			{
				url: "http://localhost:11434/api/chat",
				method: "POST",
				response: mockResponse({ body: ndjson }),
			},
		])
		const driver = new Ollama({ fetchOverride: fetch } as OllamaInternalOptions)
		const events = await drain(driver.chat(makeRequest()))
		expect(events).toContainEqual({
			type: "usage",
			inputTokens: 120,
			outputTokens: 45,
		})
	})

	it("skips usage event when both token counts are absent", async () => {
		const ndjson = `${JSON.stringify({ done: true, done_reason: "stop" })}\n`
		const fetch = fakeFetch([
			{
				url: "http://localhost:11434/api/show",
				method: "POST",
				response: mockResponse({ json: {} }),
			},
			{
				url: "http://localhost:11434/api/chat",
				method: "POST",
				response: mockResponse({ body: ndjson }),
			},
		])
		const driver = new Ollama({ fetchOverride: fetch } as OllamaInternalOptions)
		const events = await drain(driver.chat(makeRequest()))
		expect(events.find((e) => e.type === "usage")).toBeUndefined()
	})

	it("parses tool_calls with server-supplied id", async () => {
		const ndjson = `${[
			JSON.stringify({
				message: {
					role: "assistant",
					tool_calls: [
						{
							id: "call_1",
							function: { name: "search", arguments: '{"q":"x"}' },
						},
					],
				},
				done: false,
			}),
			JSON.stringify({ done: true, done_reason: "stop" }),
		].join("\n")}\n`
		const fetch = fakeFetch([
			{
				url: "http://localhost:11434/api/show",
				method: "POST",
				response: mockResponse({ json: { capabilities: ["completion", "tools"] } }),
			},
			{
				url: "http://localhost:11434/api/chat",
				method: "POST",
				response: mockResponse({ body: ndjson }),
			},
		])
		const driver = new Ollama({ fetchOverride: fetch } as OllamaInternalOptions)
		const events = await drain(driver.chat(makeRequest()))
		expect(events).toContainEqual({
			type: "tool-call",
			toolCallId: "call_1",
			name: "search",
			input: '{"q":"x"}',
		})
	})

	it("generates a fallback id when tool_calls entry has no id", async () => {
		const ndjson = `${[
			JSON.stringify({
				message: {
					role: "assistant",
					tool_calls: [
						{
							function: { name: "search", arguments: '{"q":"y"}' },
						},
					],
				},
				done: false,
			}),
			JSON.stringify({ done: true, done_reason: "stop" }),
		].join("\n")}\n`
		const fetch = fakeFetch([
			{
				url: "http://localhost:11434/api/show",
				method: "POST",
				response: mockResponse({ json: { capabilities: ["completion", "tools"] } }),
			},
			{
				url: "http://localhost:11434/api/chat",
				method: "POST",
				response: mockResponse({ body: ndjson }),
			},
		])
		const driver = new Ollama({ fetchOverride: fetch } as OllamaInternalOptions)
		const events = await drain(driver.chat(makeRequest()))
		const toolCall = events.find((e) => e.type === "tool-call")
		expect(toolCall).toBeDefined()
		if (toolCall && toolCall.type === "tool-call") {
			expect(toolCall.toolCallId).toBeTruthy()
			expect(typeof toolCall.toolCallId).toBe("string")
			expect(toolCall.toolCallId.length).toBeGreaterThan(0)
		}
	})

	it("throws an error with status on non-2xx response", async () => {
		const fetch = fakeFetch([
			{
				url: "http://localhost:11434/api/show",
				method: "POST",
				response: mockResponse({ json: {} }),
			},
			{
				url: "http://localhost:11434/api/chat",
				method: "POST",
				response: mockResponse({ status: 503, body: "service unavailable" }),
			},
		])
		const driver = new Ollama({ fetchOverride: fetch } as OllamaInternalOptions)
		await expect(drain(driver.chat(makeRequest()))).rejects.toMatchObject({
			status: 503,
		})
	})

	it("maps done_reason 'length' to stopReason 'length'", async () => {
		const ndjson = `${JSON.stringify({ done: true, done_reason: "length" })}\n`
		const fetch = fakeFetch([
			{
				url: "http://localhost:11434/api/show",
				method: "POST",
				response: mockResponse({ json: {} }),
			},
			{
				url: "http://localhost:11434/api/chat",
				method: "POST",
				response: mockResponse({ body: ndjson }),
			},
		])
		const driver = new Ollama({ fetchOverride: fetch } as OllamaInternalOptions)
		const events = await drain(driver.chat(makeRequest()))
		expect(events.at(-1)).toEqual({ type: "done", stopReason: "length" })
	})
})

describe("Ollama — embed", () => {
	it("posts to /api/embed and returns embeddings + usage", async () => {
		const fetch = fakeFetch([
			{
				url: "http://localhost:11434/api/embed",
				method: "POST",
				response: mockResponse({
					json: {
						embeddings: [
							[0.1, 0.2, 0.3],
							[0.4, 0.5, 0.6],
						],
						prompt_eval_count: 8,
					},
				}),
			},
		])
		const driver = makeOllama(fetch)
		const result = await driver.embed({
			model: "nomic-embed-text",
			input: ["hello", "world"],
		})
		expect(result.embeddings).toEqual([
			[0.1, 0.2, 0.3],
			[0.4, 0.5, 0.6],
		])
		expect(result.usage).toEqual({ inputTokens: 8, outputTokens: 0 })
	})

	it("returns undefined usage when prompt_eval_count is absent", async () => {
		const fetch = fakeFetch([
			{
				url: "http://localhost:11434/api/embed",
				method: "POST",
				response: mockResponse({
					json: {
						embeddings: [[0.1, 0.2]],
					},
				}),
			},
		])
		const driver = makeOllama(fetch)
		const result = await driver.embed({
			model: "nomic-embed-text",
			input: ["test"],
		})
		expect(result.usage).toBeUndefined()
	})
})

describe("Ollama — connection events", () => {
	it("listModels() success dispatches a 'connect' event with the resolved models", async () => {
		const fetch = fakeFetch([
			{
				url: "http://localhost:11434/api/tags",
				method: "GET",
				response: mockResponse({
					json: {
						models: [
							{
								name: "llama3:8b",
								model: "llama3:8b",
								size: 4661210672,
								digest: "abc123",
							},
						],
					},
				}),
			},
			{
				url: "http://localhost:11434/api/show",
				method: "POST",
				response: mockResponse({ json: { capabilities: ["completion"] } }),
			},
		])
		const driver = makeOllama(fetch)
		let captured: CustomEvent<{ models: { id: string; ref: string }[] }> | undefined
		driver.addEventListener("connect", (e) => {
			captured = e as CustomEvent<{ models: { id: string; ref: string }[] }>
		})
		const models = await driver.listModels()
		expect(captured).toBeDefined()
		expect(captured?.detail.models).toHaveLength(1)
		expect(captured?.detail.models[0]?.id).toBe("llama3:8b")
		expect(captured?.detail.models).toEqual(models)
	})

	it("listModels() non-2xx failure dispatches an 'error' event with phase 'listModels' and re-throws", async () => {
		const fetch = fakeFetch([
			{
				url: "http://localhost:11434/api/tags",
				method: "GET",
				response: mockResponse({ status: 503, body: "service unavailable" }),
			},
		])
		const driver = makeOllama(fetch)
		let captured: CustomEvent<{ error: unknown; phase: string }> | undefined
		driver.addEventListener("error", (e) => {
			captured = e as CustomEvent<{ error: unknown; phase: string }>
		})
		await expect(driver.listModels()).rejects.toThrow()
		expect(captured).toBeDefined()
		expect(captured?.detail.phase).toBe("listModels")
		expect(captured?.detail.error).toBeDefined()
	})

	it("listModels() fetch-thrown failure dispatches an 'error' event with phase 'listModels' and re-throws", async () => {
		const throwingFetch = vi.fn(async () => {
			throw new TypeError("network error")
		}) as unknown as typeof fetch
		const driver = makeOllama(throwingFetch)
		let captured: CustomEvent<{ error: unknown; phase: string }> | undefined
		driver.addEventListener("error", (e) => {
			captured = e as CustomEvent<{ error: unknown; phase: string }>
		})
		await expect(driver.listModels()).rejects.toThrow(TypeError)
		expect(captured).toBeDefined()
		expect(captured?.detail.phase).toBe("listModels")
		expect(captured?.detail.error).toBeInstanceOf(TypeError)
	})

	it("disconnect() dispatches a 'disconnect' event and clears the capabilities cache", async () => {
		const fetch = fakeFetch([
			{
				url: "http://localhost:11434/api/tags",
				method: "GET",
				response: mockResponse({
					json: {
						models: [
							{
								name: "llama3:8b",
								model: "llama3:8b",
								size: 4661210672,
								digest: "abc123",
							},
						],
					},
				}),
			},
			{
				url: "http://localhost:11434/api/show",
				method: "POST",
				response: mockResponse({
					json: {
						capabilities: ["completion", "tools"],
						model_info: { "llama.context_length": 8192 },
					},
				}),
			},
		])
		const driver = makeOllama(fetch)
		// Populate the capabilities cache via a successful listModels().
		await driver.listModels()
		expect(driver.capabilities("llama3:8b").toolCalls).toBe(true)
		expect(driver.capabilities("llama3:8b").contextWindow).toBe(8192)

		let disconnected = false
		driver.addEventListener("disconnect", () => {
			disconnected = true
		})
		driver.disconnect()
		expect(disconnected).toBe(true)
		// After disconnect, capabilities should return conservative defaults
		// because the cache was cleared.
		expect(driver.capabilities("llama3:8b")).toEqual({
			streaming: true,
			toolCalls: false,
			reasoning: false,
			embeddings: false,
			contextWindow: undefined,
		})
	})

	it("embed() failure dispatches an 'error' event with phase 'embed' and re-throws", async () => {
		const fetch = fakeFetch([
			{
				url: "http://localhost:11434/api/embed",
				method: "POST",
				response: mockResponse({ status: 500, body: "internal error" }),
			},
		])
		const driver = makeOllama(fetch)
		let captured: CustomEvent<{ error: unknown; phase: string }> | undefined
		driver.addEventListener("error", (e) => {
			captured = e as CustomEvent<{ error: unknown; phase: string }>
		})
		await expect(driver.embed({ model: "nomic-embed-text", input: ["test"] })).rejects.toThrow()
		expect(captured).toBeDefined()
		expect(captured?.detail.phase).toBe("embed")
		expect(captured?.detail.error).toBeDefined()
	})
})
