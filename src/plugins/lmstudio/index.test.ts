// LM Studio driver plugin tests (§ 10.3).
//
// These tests cover the `LMStudio` class's driver logic using a hand-written
// fake `fetch` (injected via the internal `fetchOverride` option). They test:
// `chat()` SSE stream parsing, streamed tool-call accumulation, `listModels()`
// mapping, `capabilities()` cache + defaults, `embed()` request/response
// mapping, non-2xx error handling, usage event mapping, and connection
// lifecycle events. They do NOT test a real LM Studio server, the retry
// wrapper, or credential resolution.

import { describe, expect, it, vi } from "vitest"

import type { ChatRequest, DriverEvent } from "../../types/index.js"
import { LMStudio, type LMStudioInternalOptions } from "./index.js"

/** Base URL every fixture below routes against. */
const BASE = "http://localhost:1234"

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

/** Read back the recorded calls from a {@link fakeFetch}. */
function callsOf(fetchFn: typeof fetch): Array<{ url: string; method: string; body?: string }> {
	return (fetchFn as unknown as { calls: Array<{ url: string; method: string; body?: string }> })
		.calls
}

/** Helper to create an LMStudio driver with a fake fetch. */
function makeLMStudio(fetchOverride: typeof fetch) {
	return new LMStudio({ fetchOverride } as LMStudioInternalOptions)
}

/** Serialize SSE `data:` frames the way LM Studio streams them. */
function sse(chunks: unknown[], { done = true } = {}): string {
	const frames = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`)
	return `${frames.join("")}${done ? "data: [DONE]\n\n" : ""}`
}

/** A `/api/v0/models` route returning the given entries. */
function modelsRoute(entries: unknown[]) {
	return {
		url: `${BASE}/api/v0/models`,
		method: "GET",
		response: mockResponse({ json: { object: "list", data: entries } }),
	}
}

/** A `/api/v0/chat/completions` route streaming the given SSE body. */
function chatRoute(body: string) {
	return {
		url: `${BASE}/api/v0/chat/completions`,
		method: "POST",
		response: mockResponse({ body }),
	}
}

describe("LMStudio — constructor", () => {
	it("uses 'lmstudio' as its driver id", () => {
		expect(makeLMStudio(fakeFetch([])).id).toBe("lmstudio")
	})

	it("defaults baseUrl to http://localhost:1234", async () => {
		const fetch = fakeFetch([modelsRoute([])])
		const driver = makeLMStudio(fetch)
		await driver.listModels()
		expect(callsOf(fetch)[0]?.url).toBe(`${BASE}/api/v0/models`)
	})

	it("honors an explicit baseUrl", async () => {
		const fetch = fakeFetch([
			{
				url: "http://gpu.box:1234/api/v0/models",
				method: "GET",
				response: mockResponse({ json: { data: [] } }),
			},
		])
		const driver = new LMStudio({
			baseUrl: "http://gpu.box:1234",
			fetchOverride: fetch,
		} as LMStudioInternalOptions)
		await driver.listModels()
		expect(callsOf(fetch)[0]?.url).toBe("http://gpu.box:1234/api/v0/models")
	})

	it("forwards custom headers on every request", async () => {
		const seen: Array<Record<string, string> | undefined> = []
		const fn = vi.fn(async (_input: string, init?: RequestInit) => {
			seen.push(init?.headers as Record<string, string> | undefined)
			return mockResponse({ json: { data: [] } })
		}) as unknown as typeof fetch
		const driver = new LMStudio({
			headers: { Authorization: "Bearer secret" },
			fetchOverride: fn,
		} as LMStudioInternalOptions)
		await driver.listModels()
		expect(seen[0]?.Authorization).toBe("Bearer secret")
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
				return mockResponse({ json: { data: [] } })
			}) as unknown as typeof fetch

			const driver = new LMStudio()
			await driver.listModels()
			expect(capturedThis).toBe(globalThis)
		} finally {
			;(globalThis as { fetch: typeof fetch }).fetch = originalFetch
		}
	})
})

describe("LMStudio — listModels", () => {
	it("maps /api/v0/models into ModelInfo[] and caches capabilities in one request", async () => {
		const fetch = fakeFetch([
			modelsRoute([
				{
					id: "meta-llama-3.1-8b-instruct",
					object: "model",
					type: "llm",
					publisher: "lmstudio-community",
					arch: "llama",
					compatibility_type: "gguf",
					quantization: "Q4_K_M",
					state: "not-loaded",
					max_context_length: 131072,
				},
			]),
		])
		const driver = makeLMStudio(fetch)
		const models = await driver.listModels()

		expect(models).toEqual([
			{
				ref: "lmstudio/meta-llama-3.1-8b-instruct",
				driver: "lmstudio",
				id: "meta-llama-3.1-8b-instruct",
				label: "meta-llama-3.1-8b-instruct",
				capabilities: {
					streaming: true,
					toolCalls: true,
					reasoning: false,
					embeddings: false,
					contextWindow: 131072,
				},
				availability: "ready",
				meta: {
					type: "llm",
					publisher: "lmstudio-community",
					arch: "llama",
					quantization: "Q4_K_M",
					compatibilityType: "gguf",
					state: "not-loaded",
					maxContextLength: 131072,
				},
			},
		])
		// One catalogue request covers every model — no per-model follow-up.
		expect(callsOf(fetch)).toHaveLength(1)
	})

	it("reports 'ready' for not-loaded models and surfaces the raw state in meta", async () => {
		const fetch = fakeFetch([
			modelsRoute([
				{ id: "loaded-model", type: "llm", state: "loaded" },
				{ id: "idle-model", type: "llm", state: "not-loaded" },
			]),
		])
		const models = await makeLMStudio(fetch).listModels()
		expect(models.map((m) => m.availability)).toEqual(["ready", "ready"])
		expect(models.map((m) => m.meta?.state)).toEqual(["loaded", "not-loaded"])
	})

	it("marks an embeddings model as embeddings-capable and not tool-capable", async () => {
		const fetch = fakeFetch([
			modelsRoute([
				{
					id: "text-embedding-nomic-embed-text-v1.5",
					type: "embeddings",
					max_context_length: 2048,
				},
			]),
		])
		const models = await makeLMStudio(fetch).listModels()
		expect(models[0]?.capabilities).toEqual({
			streaming: true,
			toolCalls: false,
			reasoning: false,
			embeddings: true,
			contextWindow: 2048,
		})
	})

	it("returns an empty list when the server reports no models", async () => {
		const fetch = fakeFetch([modelsRoute([])])
		expect(await makeLMStudio(fetch).listModels()).toEqual([])
	})
})

describe("LMStudio — capabilities", () => {
	it("prefers a declared capabilities array over the type-based fallback", async () => {
		const fetch = fakeFetch([
			modelsRoute([
				{ id: "declares-tools", type: "llm", capabilities: ["tool_use", "reasoning"] },
				{ id: "declares-nothing", type: "llm", capabilities: [] },
			]),
		])
		const driver = makeLMStudio(fetch)
		await driver.listModels()

		expect(driver.capabilities("declares-tools").toolCalls).toBe(true)
		expect(driver.capabilities("declares-tools").reasoning).toBe(true)
		// An explicit empty array is a statement, not missing data.
		expect(driver.capabilities("declares-nothing").toolCalls).toBe(false)
	})

	it("returns conservative defaults before any cache population", () => {
		const driver = makeLMStudio(fakeFetch([]))
		expect(driver.capabilities("never-fetched")).toEqual({
			streaming: true,
			toolCalls: false,
			reasoning: false,
			embeddings: false,
			contextWindow: undefined,
		})
	})

	it("is populated by chat() for a model listModels() never saw", async () => {
		const fetch = fakeFetch([
			modelsRoute([{ id: "test-model", type: "llm", max_context_length: 8192 }]),
			chatRoute(sse([{ choices: [{ delta: {}, finish_reason: "stop" }] }])),
		])
		const driver = makeLMStudio(fetch)
		await drain(driver.chat(makeRequest()))
		expect(driver.capabilities("test-model").contextWindow).toBe(8192)
	})

	it("survives a failed catalogue lookup during chat() and still streams", async () => {
		const fetch = fakeFetch([
			{
				url: `${BASE}/api/v0/models`,
				method: "GET",
				response: mockResponse({ status: 500, body: "boom" }),
			},
			chatRoute(sse([{ choices: [{ delta: { content: "hi" }, finish_reason: "stop" }] }])),
		])
		const driver = makeLMStudio(fetch)
		const events = await drain(driver.chat(makeRequest()))
		expect(events).toEqual([
			{ type: "delta", text: "hi" },
			{ type: "done", stopReason: "stop" },
		])
		expect(driver.capabilities("test-model").toolCalls).toBe(false)
	})
})

describe("LMStudio — chat", () => {
	it("parses an SSE stream into delta, usage, done events", async () => {
		const body = sse([
			{ choices: [{ index: 0, delta: { role: "assistant", content: "Hello" } }] },
			{ choices: [{ index: 0, delta: { content: " world" } }] },
			{ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
			{ choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
		])
		const fetch = fakeFetch([modelsRoute([{ id: "test-model", type: "llm" }]), chatRoute(body)])
		const events = await drain(makeLMStudio(fetch).chat(makeRequest()))

		expect(events).toEqual([
			{ type: "delta", text: "Hello" },
			{ type: "delta", text: " world" },
			{ type: "usage", inputTokens: 10, outputTokens: 5, totalTokens: 15 },
			{ type: "done", stopReason: "stop" },
		])
	})

	it("skips the usage event when no chunk carries usage", async () => {
		const body = sse([{ choices: [{ delta: { content: "hi" }, finish_reason: "stop" }] }])
		const fetch = fakeFetch([modelsRoute([{ id: "test-model", type: "llm" }]), chatRoute(body)])
		const events = await drain(makeLMStudio(fetch).chat(makeRequest()))
		expect(events.find((e) => e.type === "usage")).toBeUndefined()
	})

	it("routes reasoning_content onto the reasoning-delta channel", async () => {
		const body = sse([
			{ choices: [{ delta: { reasoning_content: "thinking…" } }] },
			{ choices: [{ delta: { content: "answer" }, finish_reason: "stop" }] },
		])
		const fetch = fakeFetch([modelsRoute([{ id: "test-model", type: "llm" }]), chatRoute(body)])
		const events = await drain(makeLMStudio(fetch).chat(makeRequest()))
		expect(events).toEqual([
			{ type: "reasoning-delta", text: "thinking…" },
			{ type: "delta", text: "answer" },
			{ type: "done", stopReason: "stop" },
		])
	})

	it("accumulates streamed tool-call fragments into one tool-call event", async () => {
		const body = sse([
			{
				choices: [
					{
						delta: {
							tool_calls: [
								{
									index: 0,
									id: "call_1",
									type: "function",
									function: { name: "get_weather", arguments: "" },
								},
							],
						},
					},
				],
			},
			{ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"loc' } }] } }] },
			{
				choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '":"SF"}' } }] } }],
			},
			{ choices: [{ delta: {}, finish_reason: "tool_calls" }] },
		])
		const fetch = fakeFetch([modelsRoute([{ id: "test-model", type: "llm" }]), chatRoute(body)])
		const events = await drain(makeLMStudio(fetch).chat(makeRequest()))

		expect(events).toEqual([
			{
				type: "tool-call",
				toolCallId: "call_1",
				name: "get_weather",
				input: '{"loc":"SF"}',
			},
			{ type: "done", stopReason: "tool-calls" },
		])
	})

	it("keeps parallel tool calls separate and emits them in index order", async () => {
		const body = sse([
			{
				choices: [
					{
						delta: {
							tool_calls: [
								{ index: 1, id: "b", function: { name: "second", arguments: "{}" } },
								{ index: 0, id: "a", function: { name: "first", arguments: "{}" } },
							],
						},
					},
				],
			},
			{ choices: [{ delta: {}, finish_reason: "tool_calls" }] },
		])
		const fetch = fakeFetch([modelsRoute([{ id: "test-model", type: "llm" }]), chatRoute(body)])
		const events = await drain(makeLMStudio(fetch).chat(makeRequest()))
		const toolCalls = events.filter((e) => e.type === "tool-call")
		expect(toolCalls.map((e) => (e as { name: string }).name)).toEqual(["first", "second"])
	})

	it("generates a fallback id when a tool-call fragment has none", async () => {
		const body = sse([
			{ choices: [{ delta: { tool_calls: [{ function: { name: "f", arguments: "{}" } }] } }] },
			{ choices: [{ delta: {}, finish_reason: "tool_calls" }] },
		])
		const fetch = fakeFetch([modelsRoute([{ id: "test-model", type: "llm" }]), chatRoute(body)])
		const events = await drain(makeLMStudio(fetch).chat(makeRequest()))
		const toolCall = events.find((e) => e.type === "tool-call")
		expect(toolCall).toBeDefined()
		if (toolCall && toolCall.type === "tool-call") {
			expect(typeof toolCall.toolCallId).toBe("string")
			expect(toolCall.toolCallId.length).toBeGreaterThan(0)
		}
	})

	it("reports 'tool-calls' even when the server closes the turn with finish_reason 'stop'", async () => {
		const body = sse([
			{ choices: [{ delta: { tool_calls: [{ index: 0, id: "x", function: { name: "f" } }] } }] },
			{ choices: [{ delta: {}, finish_reason: "stop" }] },
		])
		const fetch = fakeFetch([modelsRoute([{ id: "test-model", type: "llm" }]), chatRoute(body)])
		const events = await drain(makeLMStudio(fetch).chat(makeRequest()))
		expect(events.at(-1)).toEqual({ type: "done", stopReason: "tool-calls" })
	})

	it("maps finish_reason 'length' to stopReason 'length'", async () => {
		const body = sse([{ choices: [{ delta: { content: "…" }, finish_reason: "length" }] }])
		const fetch = fakeFetch([modelsRoute([{ id: "test-model", type: "llm" }]), chatRoute(body)])
		const events = await drain(makeLMStudio(fetch).chat(makeRequest()))
		expect(events.at(-1)).toEqual({ type: "done", stopReason: "length" })
	})

	it("ignores SSE comment and event lines", async () => {
		const body = `: keep-alive\nevent: message\n${sse([
			{ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] },
		])}`
		const fetch = fakeFetch([modelsRoute([{ id: "test-model", type: "llm" }]), chatRoute(body)])
		const events = await drain(makeLMStudio(fetch).chat(makeRequest()))
		expect(events).toEqual([
			{ type: "delta", text: "ok" },
			{ type: "done", stopReason: "stop" },
		])
	})

	it("stops at [DONE] and still terminates when the server omits it", async () => {
		const body = sse([{ choices: [{ delta: { content: "x" }, finish_reason: "stop" }] }], {
			done: false,
		})
		const fetch = fakeFetch([modelsRoute([{ id: "test-model", type: "llm" }]), chatRoute(body)])
		const events = await drain(makeLMStudio(fetch).chat(makeRequest()))
		expect(events.at(-1)).toEqual({ type: "done", stopReason: "stop" })
	})

	it("sends the system prompt as a leading system message", async () => {
		const fetch = fakeFetch([
			modelsRoute([{ id: "test-model", type: "llm" }]),
			chatRoute(sse([{ choices: [{ delta: {}, finish_reason: "stop" }] }])),
		])
		await drain(makeLMStudio(fetch).chat(makeRequest({ systemPrompt: "be terse" })))
		const chatCall = callsOf(fetch).find((c) => c.url.endsWith("/chat/completions"))
		const body = JSON.parse(chatCall?.body ?? "{}")
		expect(body.messages[0]).toEqual({ role: "system", content: "be terse" })
		expect(body.stream).toBe(true)
		expect(body.stream_options).toEqual({ include_usage: true })
	})

	it("omits tools when the model is not tool-capable", async () => {
		const fetch = fakeFetch([
			modelsRoute([{ id: "test-model", type: "llm", capabilities: [] }]),
			chatRoute(sse([{ choices: [{ delta: {}, finish_reason: "stop" }] }])),
		])
		await drain(
			makeLMStudio(fetch).chat(
				makeRequest({
					tools: [{ name: "f", description: "d", inputSchema: { type: "object" } }],
				}),
			),
		)
		const chatCall = callsOf(fetch).find((c) => c.url.endsWith("/chat/completions"))
		expect(JSON.parse(chatCall?.body ?? "{}").tools).toBeUndefined()
	})

	it("maps tools onto the OpenAI function shape when the model is tool-capable", async () => {
		const fetch = fakeFetch([
			modelsRoute([{ id: "test-model", type: "llm", capabilities: ["tool_use"] }]),
			chatRoute(sse([{ choices: [{ delta: {}, finish_reason: "stop" }] }])),
		])
		await drain(
			makeLMStudio(fetch).chat(
				makeRequest({
					tools: [{ name: "f", description: "d", inputSchema: { type: "object" } }],
					params: { temperature: 0.2, maxTokens: 64, stop: ["END"] },
				}),
			),
		)
		const chatCall = callsOf(fetch).find((c) => c.url.endsWith("/chat/completions"))
		const body = JSON.parse(chatCall?.body ?? "{}")
		expect(body.tools).toEqual([
			{
				type: "function",
				function: { name: "f", description: "d", parameters: { type: "object" } },
			},
		])
		expect(body.temperature).toBe(0.2)
		expect(body.max_tokens).toBe(64)
		expect(body.stop).toEqual(["END"])
	})

	it("throws an error carrying the status on a non-2xx chat response", async () => {
		const fetch = fakeFetch([
			modelsRoute([{ id: "test-model", type: "llm" }]),
			{
				url: `${BASE}/api/v0/chat/completions`,
				method: "POST",
				response: mockResponse({ status: 503, body: "service unavailable" }),
			},
		])
		await expect(drain(makeLMStudio(fetch).chat(makeRequest()))).rejects.toMatchObject({
			status: 503,
		})
	})

	it("yields done(abort) when the request signal is already aborted", async () => {
		const controller = new AbortController()
		controller.abort()
		const fetch = fakeFetch([
			modelsRoute([{ id: "test-model", type: "llm" }]),
			chatRoute(sse([{ choices: [{ delta: { content: "never" } }] }])),
		])
		const events = await drain(makeLMStudio(fetch).chat(makeRequest({ signal: controller.signal })))
		expect(events).toEqual([{ type: "done", stopReason: "abort" }])
	})
})

describe("LMStudio — embed", () => {
	it("posts to /api/v0/embeddings and returns embeddings + usage", async () => {
		const fetch = fakeFetch([
			{
				url: `${BASE}/api/v0/embeddings`,
				method: "POST",
				response: mockResponse({
					json: {
						object: "list",
						data: [
							{ object: "embedding", embedding: [0.1, 0.2], index: 0 },
							{ object: "embedding", embedding: [0.3, 0.4], index: 1 },
						],
						usage: { prompt_tokens: 8, total_tokens: 8 },
					},
				}),
			},
		])
		const result = await makeLMStudio(fetch).embed({
			model: "text-embedding-nomic-embed-text-v1.5",
			input: ["hello", "world"],
		})
		expect(result.embeddings).toEqual([
			[0.1, 0.2],
			[0.3, 0.4],
		])
		expect(result.usage).toEqual({ inputTokens: 8, outputTokens: 0 })
	})

	it("orders embeddings by the response index, not arrival order", async () => {
		const fetch = fakeFetch([
			{
				url: `${BASE}/api/v0/embeddings`,
				method: "POST",
				response: mockResponse({
					json: {
						data: [
							{ embedding: [2], index: 1 },
							{ embedding: [1], index: 0 },
						],
					},
				}),
			},
		])
		const result = await makeLMStudio(fetch).embed({ model: "m", input: ["a", "b"] })
		expect(result.embeddings).toEqual([[1], [2]])
	})

	it("returns undefined usage when the response omits prompt_tokens", async () => {
		const fetch = fakeFetch([
			{
				url: `${BASE}/api/v0/embeddings`,
				method: "POST",
				response: mockResponse({ json: { data: [{ embedding: [0.1], index: 0 }] } }),
			},
		])
		const result = await makeLMStudio(fetch).embed({ model: "m", input: ["test"] })
		expect(result.usage).toBeUndefined()
	})
})

describe("LMStudio — connection events", () => {
	it("listModels() success dispatches a 'connect' event with the resolved models", async () => {
		const fetch = fakeFetch([modelsRoute([{ id: "m1", type: "llm" }])])
		const driver = makeLMStudio(fetch)
		let captured: CustomEvent<{ models: { id: string }[] }> | undefined
		driver.addEventListener("connect", (e) => {
			captured = e as CustomEvent<{ models: { id: string }[] }>
		})
		const models = await driver.listModels()
		expect(captured?.detail.models).toEqual(models)
		expect(captured?.detail.models[0]?.id).toBe("m1")
	})

	it("listModels() non-2xx failure dispatches 'error' with phase 'listModels' and re-throws", async () => {
		const fetch = fakeFetch([
			{
				url: `${BASE}/api/v0/models`,
				method: "GET",
				response: mockResponse({ status: 503, body: "service unavailable" }),
			},
		])
		const driver = makeLMStudio(fetch)
		let captured: CustomEvent<{ error: unknown; phase: string }> | undefined
		driver.addEventListener("error", (e) => {
			captured = e as CustomEvent<{ error: unknown; phase: string }>
		})
		await expect(driver.listModels()).rejects.toBeDefined()
		expect(captured?.detail.phase).toBe("listModels")
		expect(captured?.detail.error).toMatchObject({ status: 503 })
	})

	it("listModels() fetch-thrown failure dispatches 'error' and re-throws", async () => {
		const throwingFetch = vi.fn(async () => {
			throw new TypeError("network error")
		}) as unknown as typeof fetch
		const driver = makeLMStudio(throwingFetch)
		let captured: CustomEvent<{ error: unknown; phase: string }> | undefined
		driver.addEventListener("error", (e) => {
			captured = e as CustomEvent<{ error: unknown; phase: string }>
		})
		await expect(driver.listModels()).rejects.toThrow(TypeError)
		expect(captured?.detail.phase).toBe("listModels")
		expect(captured?.detail.error).toBeInstanceOf(TypeError)
	})

	it("disconnect() dispatches a 'disconnect' event and clears the capabilities cache", async () => {
		const fetch = fakeFetch([modelsRoute([{ id: "m1", type: "llm", max_context_length: 4096 }])])
		const driver = makeLMStudio(fetch)
		await driver.listModels()
		expect(driver.capabilities("m1").contextWindow).toBe(4096)

		let disconnected = false
		driver.addEventListener("disconnect", () => {
			disconnected = true
		})
		driver.disconnect()
		expect(disconnected).toBe(true)
		expect(driver.capabilities("m1")).toEqual({
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
				url: `${BASE}/api/v0/embeddings`,
				method: "POST",
				response: mockResponse({ status: 500, body: "internal error" }),
			},
		])
		const driver = makeLMStudio(fetch)
		let captured: CustomEvent<{ error: unknown; phase: string }> | undefined
		driver.addEventListener("error", (e) => {
			captured = e as CustomEvent<{ error: unknown; phase: string }>
		})
		await expect(driver.embed({ model: "m", input: ["test"] })).rejects.toBeDefined()
		expect(captured?.detail.phase).toBe("embed")
	})
})
