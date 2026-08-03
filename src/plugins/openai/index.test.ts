// OpenAI driver plugin tests (§ 10.3).
//
// These tests cover the `OpenAI` class's driver logic using a hand-written fake
// `fetch` (injected via the internal `fetchOverride` option). They test:
// `chat()` SSE stream parsing, streamed tool-call accumulation, the assistant
// `tool_calls` reconstruction that makes multi-iteration tool loops legal on
// this API, `listModels()` mapping, `capabilities()` inference + cache,
// `embed()` request/response mapping, non-2xx error handling, abort handling,
// and connection lifecycle events. They do NOT test the real OpenAI platform,
// the retry wrapper, or credential resolution.

import { describe, expect, it, vi } from "vitest"

import type { BHZAIMessage, ChatRequest, DriverEvent } from "../../types/index.js"
import { OpenAI, type OpenAIInternalOptions } from "./index.js"

/** Base URL every fixture below routes against. */
const BASE = "https://api.openai.com"

/** Build a minimal ChatRequest for testing. */
function makeRequest(overrides: Partial<ChatRequest> = {}): ChatRequest {
	const controller = new AbortController()
	return {
		model: "gpt-4o-mini",
		messages: [],
		signal: controller.signal,
		...overrides,
	}
}

/**
 * Build a conversation message. Only the fields the driver reads are populated;
 * `append`/`setContent` are stubs, since the driver never mutates messages.
 */
function message(
	role: BHZAIMessage["role"],
	content: string,
	meta: Record<string, unknown> = {},
): BHZAIMessage {
	return {
		id: `${role}-${content}`,
		role,
		content,
		blocks: [],
		time: 0,
		meta,
		append: () => {},
		setContent: () => {},
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

/**
 * Build a fake fetch that routes by URL and method. Chat routes are reusable:
 * each POST to the same URL gets a freshly built response, so a test can drive
 * several loop iterations through one fake.
 */
function fakeFetch(
	routes: Array<{
		url: string
		method: string
		response?: Response
		make?: () => Response
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
		return route.make ? route.make() : (route.response as Response)
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

/** Parse the body of the Nth (0-based) chat request the driver sent. */
function chatBody(fetchFn: typeof fetch, index = 0): Record<string, unknown> {
	const chatCalls = callsOf(fetchFn).filter((c) => c.url.endsWith("/chat/completions"))
	return JSON.parse(chatCalls[index]?.body ?? "{}")
}

/** Helper to create an OpenAI driver with a fake fetch. */
function makeOpenAI(fetchOverride: typeof fetch) {
	return new OpenAI({ fetchOverride } as OpenAIInternalOptions)
}

/** Serialize SSE `data:` frames the way OpenAI streams them. */
function sse(chunks: unknown[], { done = true } = {}): string {
	const frames = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`)
	return `${frames.join("")}${done ? "data: [DONE]\n\n" : ""}`
}

/** A `/v1/models` route returning the given entries. */
function modelsRoute(entries: unknown[]) {
	return {
		url: `${BASE}/v1/models`,
		method: "GET",
		response: mockResponse({ json: { object: "list", data: entries } }),
	}
}

/** A `/v1/chat/completions` route streaming the given SSE body, re-readable. */
function chatRoute(body: string) {
	return {
		url: `${BASE}/v1/chat/completions`,
		method: "POST",
		make: () => mockResponse({ body }),
	}
}

/** The default catalogue fixture: one chat model. */
const CHAT_MODEL = {
	id: "gpt-4o-mini",
	object: "model",
	created: 1_721_172_741,
	owned_by: "system",
}

describe("OpenAI — constructor", () => {
	it("uses 'openai' as its driver id", () => {
		expect(makeOpenAI(fakeFetch([])).id).toBe("openai")
	})

	it("defaults baseUrl to https://api.openai.com", async () => {
		const fetch = fakeFetch([modelsRoute([])])
		await makeOpenAI(fetch).listModels()
		expect(callsOf(fetch)[0]?.url).toBe(`${BASE}/v1/models`)
	})

	it("honors an explicit baseUrl, so a proxy or gateway can be used", async () => {
		const fetch = fakeFetch([
			{
				url: "https://gateway.internal/v1/models",
				method: "GET",
				response: mockResponse({ json: { data: [] } }),
			},
		])
		const driver = new OpenAI({
			baseUrl: "https://gateway.internal",
			fetchOverride: fetch,
		} as OpenAIInternalOptions)
		await driver.listModels()
		expect(callsOf(fetch)[0]?.url).toBe("https://gateway.internal/v1/models")
	})

	it("forwards the Authorization header on every request", async () => {
		const seen: Array<Record<string, string> | undefined> = []
		const fn = vi.fn(async (_input: string, init?: RequestInit) => {
			seen.push(init?.headers as Record<string, string> | undefined)
			return mockResponse({ json: { data: [] } })
		}) as unknown as typeof fetch
		const driver = new OpenAI({
			headers: { Authorization: "Bearer sk-test", "OpenAI-Project": "proj_1" },
			fetchOverride: fn,
		} as OpenAIInternalOptions)
		await driver.listModels()
		expect(seen[0]?.Authorization).toBe("Bearer sk-test")
		expect(seen[0]?.["OpenAI-Project"]).toBe("proj_1")
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

			const driver = new OpenAI()
			await driver.listModels()
			expect(capturedThis).toBe(globalThis)
		} finally {
			;(globalThis as { fetch: typeof fetch }).fetch = originalFetch
		}
	})
})

describe("OpenAI — listModels", () => {
	it("maps /v1/models into ModelInfo[] and caches capabilities in one request", async () => {
		const fetch = fakeFetch([modelsRoute([CHAT_MODEL])])
		const models = await makeOpenAI(fetch).listModels()

		expect(models).toEqual([
			{
				ref: "openai/gpt-4o-mini",
				driver: "openai",
				id: "gpt-4o-mini",
				label: "gpt-4o-mini",
				capabilities: {
					streaming: true,
					toolCalls: true,
					reasoning: false,
					embeddings: false,
					contextWindow: 128000,
				},
				availability: "ready",
				meta: { type: "chat", ownedBy: "system", created: 1_721_172_741 },
			},
		])
		// One catalogue request covers every model — no per-model follow-up.
		expect(callsOf(fetch)).toHaveLength(1)
	})

	it("reports every hosted model as 'ready'", async () => {
		const fetch = fakeFetch([modelsRoute([CHAT_MODEL, { id: "dall-e-3" }])])
		const models = await makeOpenAI(fetch).listModels()
		expect(models.map((m) => m.availability)).toEqual(["ready", "ready"])
	})

	it("tags each model's modality under meta.type so hosts can filter the catalogue", async () => {
		const fetch = fakeFetch([
			modelsRoute([
				{ id: "gpt-4o" },
				{ id: "text-embedding-3-small" },
				{ id: "whisper-1" },
				{ id: "gpt-4o-mini-tts" },
				{ id: "dall-e-3" },
				{ id: "omni-moderation-latest" },
				{ id: "davinci-002" },
			]),
		])
		const models = await makeOpenAI(fetch).listModels()
		expect(models.map((m) => m.meta?.type)).toEqual([
			"chat",
			"embeddings",
			"audio",
			"audio",
			"image",
			"moderation",
			"completion",
		])
	})

	it("treats an unrecognized id as a chat model rather than hiding it", async () => {
		const fetch = fakeFetch([modelsRoute([{ id: "gpt-9-turbo-preview" }])])
		const models = await makeOpenAI(fetch).listModels()
		expect(models[0]?.meta?.type).toBe("chat")
		expect(models[0]?.capabilities.toolCalls).toBe(true)
	})

	it("returns an empty list when the key can reach no models", async () => {
		const fetch = fakeFetch([modelsRoute([])])
		expect(await makeOpenAI(fetch).listModels()).toEqual([])
	})
})

describe("OpenAI — capabilities", () => {
	it("returns conservative defaults before any cache population", () => {
		const driver = makeOpenAI(fakeFetch([]))
		expect(driver.capabilities("never-fetched")).toEqual({
			streaming: true,
			toolCalls: false,
			reasoning: false,
			embeddings: false,
			contextWindow: undefined,
		})
	})

	it("infers reasoning for the o-series and GPT-5 families only", async () => {
		const fetch = fakeFetch([
			modelsRoute([
				{ id: "o3-2025-04-16" },
				{ id: "gpt-5-mini" },
				{ id: "gpt-4o" },
				{ id: "gpt-3.5-turbo" },
			]),
		])
		const driver = makeOpenAI(fetch)
		await driver.listModels()
		expect(driver.capabilities("o3-2025-04-16").reasoning).toBe(true)
		expect(driver.capabilities("gpt-5-mini").reasoning).toBe(true)
		expect(driver.capabilities("gpt-4o").reasoning).toBe(false)
		expect(driver.capabilities("gpt-3.5-turbo").reasoning).toBe(false)
	})

	it("marks an embeddings model as embeddings-capable and not tool-capable", async () => {
		const fetch = fakeFetch([modelsRoute([{ id: "text-embedding-3-large" }])])
		const driver = makeOpenAI(fetch)
		await driver.listModels()
		expect(driver.capabilities("text-embedding-3-large")).toEqual({
			streaming: true,
			toolCalls: false,
			reasoning: false,
			embeddings: true,
			contextWindow: 8191,
		})
	})

	it("resolves contextWindow by longest-prefix family match", async () => {
		const fetch = fakeFetch([
			modelsRoute([{ id: "gpt-4" }, { id: "gpt-4o-mini" }, { id: "gpt-4.1-nano" }]),
		])
		const driver = makeOpenAI(fetch)
		await driver.listModels()
		// `gpt-4o` (128k) and `gpt-4.1` (1M) must beat the shorter `gpt-4` (8k).
		expect(driver.capabilities("gpt-4").contextWindow).toBe(8192)
		expect(driver.capabilities("gpt-4o-mini").contextWindow).toBe(128000)
		expect(driver.capabilities("gpt-4.1-nano").contextWindow).toBe(1047576)
	})

	it("resolves a fine-tuned model through its base model", async () => {
		const fetch = fakeFetch([modelsRoute([{ id: "ft:gpt-4o-mini-2024-07-18:acme::AbC123" }])])
		const driver = makeOpenAI(fetch)
		await driver.listModels()
		expect(driver.capabilities("ft:gpt-4o-mini-2024-07-18:acme::AbC123")).toEqual({
			streaming: true,
			toolCalls: true,
			reasoning: false,
			embeddings: false,
			contextWindow: 128000,
		})
	})

	it("leaves contextWindow undefined for a model outside every known family", async () => {
		const fetch = fakeFetch([modelsRoute([{ id: "mystery-model-1" }])])
		const driver = makeOpenAI(fetch)
		await driver.listModels()
		expect(driver.capabilities("mystery-model-1").contextWindow).toBeUndefined()
	})

	it("lets a host-supplied contextWindows override beat the family table", async () => {
		const fetch = fakeFetch([modelsRoute([{ id: "gpt-4o-mini" }, { id: "mystery-model-1" }])])
		const driver = new OpenAI({
			contextWindows: { "gpt-4o-mini": 64000, "mystery-model-1": 32000 },
			fetchOverride: fetch,
		} as OpenAIInternalOptions)
		await driver.listModels()
		expect(driver.capabilities("gpt-4o-mini").contextWindow).toBe(64000)
		expect(driver.capabilities("mystery-model-1").contextWindow).toBe(32000)
	})

	// Verified against a live OpenRouter catalogue: all 337 models report
	// `context_length`, and reporting `undefined` for them disabled auto-compaction
	// for the whole provider.
	it("prefers a gateway-reported context_length over the family table", async () => {
		const fetch = fakeFetch([
			modelsRoute([
				{ id: "deepseek/deepseek-v4", context_length: 1048576 },
				{ id: "some/model", top_provider: { context_length: 65536 } },
			]),
		])
		const driver = makeOpenAI(fetch)
		await driver.listModels()
		expect(driver.capabilities("deepseek/deepseek-v4").contextWindow).toBe(1048576)
		expect(driver.capabilities("some/model").contextWindow).toBe(65536)
	})

	it("still lets a host override beat a gateway-reported context_length", async () => {
		const fetch = fakeFetch([modelsRoute([{ id: "a/b", context_length: 1000 }])])
		const driver = new OpenAI({
			contextWindows: { "a/b": 4096 },
			fetchOverride: fetch,
		} as OpenAIInternalOptions)
		await driver.listModels()
		expect(driver.capabilities("a/b").contextWindow).toBe(4096)
	})

	it("prefers declared supported_parameters over inference", async () => {
		const fetch = fakeFetch([
			modelsRoute([
				{ id: "openai/gpt-5.6", supported_parameters: ["tools", "reasoning_effort"] },
				{ id: "vendor/no-tools", supported_parameters: ["temperature"] },
				{ id: "vendor/declares-nothing", supported_parameters: [] },
			]),
		])
		const driver = makeOpenAI(fetch)
		await driver.listModels()
		expect(driver.capabilities("openai/gpt-5.6").toolCalls).toBe(true)
		expect(driver.capabilities("openai/gpt-5.6").reasoning).toBe(true)
		// A declaration that omits `tools` is a statement, not missing data.
		expect(driver.capabilities("vendor/no-tools").toolCalls).toBe(false)
		expect(driver.capabilities("vendor/declares-nothing").toolCalls).toBe(false)
	})

	// Every OpenRouter id is namespaced; a raw-prefix test matches none of them,
	// so all id-based inference silently failed against gateways.
	it("resolves namespaced gateway ids through their last path segment", async () => {
		const fetch = fakeFetch([
			modelsRoute([
				{ id: "openai/gpt-4o-mini" },
				{ id: "openai/o3-mini" },
				{ id: "openai/text-embedding-3-small" },
				{ id: "openai/dall-e-3" },
			]),
		])
		const driver = makeOpenAI(fetch)
		const models = await driver.listModels()
		expect(driver.capabilities("openai/gpt-4o-mini").contextWindow).toBe(128000)
		expect(driver.capabilities("openai/o3-mini").reasoning).toBe(true)
		expect(driver.capabilities("openai/text-embedding-3-small").embeddings).toBe(true)
		expect(models.map((m) => m.meta?.type)).toEqual(["chat", "chat", "embeddings", "image"])
	})

	it("keeps the namespaced id intact in the ref, since refs split on the first slash", async () => {
		const fetch = fakeFetch([modelsRoute([{ id: "deepseek/deepseek-v4" }])])
		const models = await makeOpenAI(fetch).listModels()
		expect(models[0]?.ref).toBe("openai/deepseek/deepseek-v4")
		expect(models[0]?.id).toBe("deepseek/deepseek-v4")
	})

	it("is populated by chat() for a model listModels() never saw", async () => {
		const fetch = fakeFetch([
			modelsRoute([CHAT_MODEL]),
			chatRoute(sse([{ choices: [{ delta: {}, finish_reason: "stop" }] }])),
		])
		const driver = makeOpenAI(fetch)
		await drain(driver.chat(makeRequest()))
		expect(driver.capabilities("gpt-4o-mini").contextWindow).toBe(128000)
	})

	it("survives a failed catalogue lookup during chat() and still streams", async () => {
		const fetch = fakeFetch([
			{
				url: `${BASE}/v1/models`,
				method: "GET",
				response: mockResponse({ status: 401, body: '{"error":{"message":"bad key"}}' }),
			},
			chatRoute(sse([{ choices: [{ delta: { content: "hi" }, finish_reason: "stop" }] }])),
		])
		const driver = makeOpenAI(fetch)
		const events = await drain(driver.chat(makeRequest()))
		expect(events).toEqual([
			{ type: "delta", text: "hi" },
			{ type: "done", stopReason: "stop" },
		])
		expect(driver.capabilities("gpt-4o-mini").toolCalls).toBe(false)
	})
})

describe("OpenAI — catalogue polling", () => {
	// REGRESSION: an OpenAI-compatible gateway that returns `data: []` never
	// populates the per-model cache, so keying the "do I need the catalogue?"
	// check off a per-model miss re-fetched /v1/models before every chat call.
	it("fetches the catalogue at most once even when it comes back empty", async () => {
		const fetch = fakeFetch([
			modelsRoute([]),
			chatRoute(sse([{ choices: [{ delta: {}, finish_reason: "stop" }] }])),
		])
		const driver = makeOpenAI(fetch)
		await drain(driver.chat(makeRequest()))
		await drain(driver.chat(makeRequest()))
		await drain(driver.chat(makeRequest()))
		expect(callsOf(fetch).filter((c) => c.url.endsWith("/v1/models"))).toHaveLength(1)
	})

	it("retries the catalogue after a failed fetch", async () => {
		const fetch = fakeFetch([
			{
				url: `${BASE}/v1/models`,
				method: "GET",
				make: () => mockResponse({ status: 503, body: "unavailable" }),
			},
			chatRoute(sse([{ choices: [{ delta: {}, finish_reason: "stop" }] }])),
		])
		const driver = makeOpenAI(fetch)
		await drain(driver.chat(makeRequest()))
		await drain(driver.chat(makeRequest()))
		expect(callsOf(fetch).filter((c) => c.url.endsWith("/v1/models"))).toHaveLength(2)
	})

	it("re-fetches on listModels() regardless, so a host refresh sees new models", async () => {
		const fetch = fakeFetch([
			modelsRoute([]),
			chatRoute(sse([{ choices: [{ delta: {}, finish_reason: "stop" }] }])),
		])
		const driver = makeOpenAI(fetch)
		await drain(driver.chat(makeRequest()))
		await driver.listModels()
		await driver.listModels()
		expect(callsOf(fetch).filter((c) => c.url.endsWith("/v1/models"))).toHaveLength(3)
	})

	it("disconnect() re-arms the catalogue fetch", async () => {
		const fetch = fakeFetch([
			modelsRoute([]),
			chatRoute(sse([{ choices: [{ delta: {}, finish_reason: "stop" }] }])),
		])
		const driver = makeOpenAI(fetch)
		await drain(driver.chat(makeRequest()))
		driver.disconnect()
		await drain(driver.chat(makeRequest()))
		expect(callsOf(fetch).filter((c) => c.url.endsWith("/v1/models"))).toHaveLength(2)
	})
})

describe("OpenAI — chat", () => {
	it("parses an SSE stream into delta, usage, done events", async () => {
		const body = sse([
			{ choices: [{ index: 0, delta: { role: "assistant", content: "Hello" } }] },
			{ choices: [{ index: 0, delta: { content: " world" } }] },
			{ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
			{ choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
		])
		const fetch = fakeFetch([modelsRoute([CHAT_MODEL]), chatRoute(body)])
		const events = await drain(makeOpenAI(fetch).chat(makeRequest()))

		expect(events).toEqual([
			{ type: "delta", text: "Hello" },
			{ type: "delta", text: " world" },
			{ type: "usage", inputTokens: 10, outputTokens: 5 },
			{ type: "done", stopReason: "stop" },
		])
	})

	it("skips the usage event when no chunk carries usage", async () => {
		const body = sse([{ choices: [{ delta: { content: "hi" }, finish_reason: "stop" }] }])
		const fetch = fakeFetch([modelsRoute([CHAT_MODEL]), chatRoute(body)])
		const events = await drain(makeOpenAI(fetch).chat(makeRequest()))
		expect(events.find((e) => e.type === "usage")).toBeUndefined()
	})

	it("surfaces a refusal as answer text rather than an empty turn", async () => {
		const body = sse([
			{ choices: [{ delta: { refusal: "I can't help with that." }, finish_reason: "stop" }] },
		])
		const fetch = fakeFetch([modelsRoute([CHAT_MODEL]), chatRoute(body)])
		const events = await drain(makeOpenAI(fetch).chat(makeRequest()))
		expect(events).toEqual([
			{ type: "delta", text: "I can't help with that." },
			{ type: "done", stopReason: "stop" },
		])
	})

	it("routes a gateway's reasoning_content onto the reasoning-delta channel", async () => {
		const body = sse([
			{ choices: [{ delta: { reasoning_content: "thinking…" } }] },
			{ choices: [{ delta: { content: "answer" }, finish_reason: "stop" }] },
		])
		const fetch = fakeFetch([modelsRoute([CHAT_MODEL]), chatRoute(body)])
		const events = await drain(makeOpenAI(fetch).chat(makeRequest()))
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
		const fetch = fakeFetch([modelsRoute([CHAT_MODEL]), chatRoute(body)])
		const events = await drain(makeOpenAI(fetch).chat(makeRequest()))

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
		const fetch = fakeFetch([modelsRoute([CHAT_MODEL]), chatRoute(body)])
		const events = await drain(makeOpenAI(fetch).chat(makeRequest()))
		const toolCalls = events.filter((e) => e.type === "tool-call")
		expect(toolCalls.map((e) => (e as { name: string }).name)).toEqual(["first", "second"])
	})

	it("generates a fallback id when a tool-call fragment has none", async () => {
		const body = sse([
			{ choices: [{ delta: { tool_calls: [{ function: { name: "f", arguments: "{}" } }] } }] },
			{ choices: [{ delta: {}, finish_reason: "tool_calls" }] },
		])
		const fetch = fakeFetch([modelsRoute([CHAT_MODEL]), chatRoute(body)])
		const events = await drain(makeOpenAI(fetch).chat(makeRequest()))
		const toolCall = events.find((e) => e.type === "tool-call")
		expect(toolCall).toBeDefined()
		if (toolCall && toolCall.type === "tool-call") {
			expect(typeof toolCall.toolCallId).toBe("string")
			expect(toolCall.toolCallId.length).toBeGreaterThan(0)
		}
	})

	it("reports 'tool-calls' even when the turn closes with finish_reason 'stop'", async () => {
		const body = sse([
			{ choices: [{ delta: { tool_calls: [{ index: 0, id: "x", function: { name: "f" } }] } }] },
			{ choices: [{ delta: {}, finish_reason: "stop" }] },
		])
		const fetch = fakeFetch([modelsRoute([CHAT_MODEL]), chatRoute(body)])
		const events = await drain(makeOpenAI(fetch).chat(makeRequest()))
		expect(events.at(-1)).toEqual({ type: "done", stopReason: "tool-calls" })
	})

	it("maps finish_reason 'length' to stopReason 'length'", async () => {
		const body = sse([{ choices: [{ delta: { content: "…" }, finish_reason: "length" }] }])
		const fetch = fakeFetch([modelsRoute([CHAT_MODEL]), chatRoute(body)])
		const events = await drain(makeOpenAI(fetch).chat(makeRequest()))
		expect(events.at(-1)).toEqual({ type: "done", stopReason: "length" })
	})

	it("ignores SSE comment and event lines", async () => {
		const body = `: keep-alive\nevent: message\n${sse([
			{ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] },
		])}`
		const fetch = fakeFetch([modelsRoute([CHAT_MODEL]), chatRoute(body)])
		const events = await drain(makeOpenAI(fetch).chat(makeRequest()))
		expect(events).toEqual([
			{ type: "delta", text: "ok" },
			{ type: "done", stopReason: "stop" },
		])
	})

	it("stops at [DONE] and still terminates when the server omits it", async () => {
		const body = sse([{ choices: [{ delta: { content: "x" }, finish_reason: "stop" }] }], {
			done: false,
		})
		const fetch = fakeFetch([modelsRoute([CHAT_MODEL]), chatRoute(body)])
		const events = await drain(makeOpenAI(fetch).chat(makeRequest()))
		expect(events.at(-1)).toEqual({ type: "done", stopReason: "stop" })
	})

	it("sends the system prompt as a leading system message and asks for usage", async () => {
		const fetch = fakeFetch([
			modelsRoute([CHAT_MODEL]),
			chatRoute(sse([{ choices: [{ delta: {}, finish_reason: "stop" }] }])),
		])
		await drain(makeOpenAI(fetch).chat(makeRequest({ systemPrompt: "be terse" })))
		const body = chatBody(fetch)
		expect((body.messages as unknown[])[0]).toEqual({ role: "system", content: "be terse" })
		expect(body.stream).toBe(true)
		expect(body.stream_options).toEqual({ include_usage: true })
	})

	it("omits tools when the model is not tool-capable", async () => {
		const fetch = fakeFetch([
			modelsRoute([{ id: "text-embedding-3-small" }]),
			chatRoute(sse([{ choices: [{ delta: {}, finish_reason: "stop" }] }])),
		])
		await drain(
			makeOpenAI(fetch).chat(
				makeRequest({
					model: "text-embedding-3-small",
					tools: [{ name: "f", description: "d", inputSchema: { type: "object" } }],
				}),
			),
		)
		expect(chatBody(fetch).tools).toBeUndefined()
	})

	it("maps tools onto the OpenAI function shape and params onto the request body", async () => {
		const fetch = fakeFetch([
			modelsRoute([CHAT_MODEL]),
			chatRoute(sse([{ choices: [{ delta: {}, finish_reason: "stop" }] }])),
		])
		await drain(
			makeOpenAI(fetch).chat(
				makeRequest({
					tools: [{ name: "f", description: "d", inputSchema: { type: "object" } }],
					params: { temperature: 0.2, maxTokens: 64, stop: ["END"] },
				}),
			),
		)
		const body = chatBody(fetch)
		expect(body.tools).toEqual([
			{
				type: "function",
				function: { name: "f", description: "d", parameters: { type: "object" } },
			},
		])
		expect(body.temperature).toBe(0.2)
		// `max_tokens` is deprecated and rejected by reasoning models.
		expect(body.max_completion_tokens).toBe(64)
		expect(body.max_tokens).toBeUndefined()
		expect(body.stop).toEqual(["END"])
	})

	it("sends reasoning_effort only for a reasoning-capable model", async () => {
		const fetch = fakeFetch([
			modelsRoute([CHAT_MODEL, { id: "o3-mini" }]),
			chatRoute(sse([{ choices: [{ delta: {}, finish_reason: "stop" }] }])),
		])
		const driver = makeOpenAI(fetch)
		await drain(driver.chat(makeRequest({ model: "o3-mini", params: { reasoning: "high" } })))
		await drain(driver.chat(makeRequest({ model: "gpt-4o-mini", params: { reasoning: "high" } })))
		expect(chatBody(fetch, 0).reasoning_effort).toBe("high")
		expect(chatBody(fetch, 1).reasoning_effort).toBeUndefined()
	})

	it("maps the 'off' reasoning level onto OpenAI's 'none'", async () => {
		const fetch = fakeFetch([
			modelsRoute([{ id: "o3-mini" }]),
			chatRoute(sse([{ choices: [{ delta: {}, finish_reason: "stop" }] }])),
		])
		await drain(
			makeOpenAI(fetch).chat(makeRequest({ model: "o3-mini", params: { reasoning: "off" } })),
		)
		expect(chatBody(fetch).reasoning_effort).toBe("none")
	})

	it("throws an error carrying the status on a non-2xx chat response", async () => {
		const fetch = fakeFetch([
			modelsRoute([CHAT_MODEL]),
			{
				url: `${BASE}/v1/chat/completions`,
				method: "POST",
				response: mockResponse({ status: 429, body: '{"error":{"message":"rate limited"}}' }),
			},
		])
		await expect(drain(makeOpenAI(fetch).chat(makeRequest()))).rejects.toMatchObject({
			status: 429,
			body: { error: { message: "rate limited" } },
		})
	})

	it("yields done(abort) when the request signal is already aborted", async () => {
		const controller = new AbortController()
		controller.abort()
		const fetch = fakeFetch([
			modelsRoute([CHAT_MODEL]),
			chatRoute(sse([{ choices: [{ delta: { content: "never" } }] }])),
		])
		const events = await drain(makeOpenAI(fetch).chat(makeRequest({ signal: controller.signal })))
		expect(events).toEqual([{ type: "done", stopReason: "abort" }])
	})
})

/** A tool-result message as `agent-loop.ts` builds it. */
function toolResult(id: string, name: string, content: string): BHZAIMessage {
	return message("tool", content, { toolCallId: id, toolName: name, isError: false })
}

describe("OpenAI — tool-loop message reconstruction", () => {
	it("pairs a tool message with the assistant message that preceded it", async () => {
		const fetch = fakeFetch([
			modelsRoute([CHAT_MODEL]),
			chatRoute(sse([{ choices: [{ delta: {}, finish_reason: "stop" }] }])),
		])
		await drain(
			makeOpenAI(fetch).chat(
				makeRequest({
					messages: [
						message("user", "weather?"),
						message("assistant", ""),
						toolResult("call_1", "get_weather", "sunny"),
					],
				}),
			),
		)
		expect(chatBody(fetch).messages).toEqual([
			{ role: "user", content: "weather?" },
			{
				role: "assistant",
				tool_calls: [
					{ id: "call_1", type: "function", function: { name: "get_weather", arguments: "{}" } },
				],
			},
			{ role: "tool", tool_call_id: "call_1", content: "sunny" },
		])
	})

	it("groups parallel tool results under one assistant message, in order", async () => {
		const fetch = fakeFetch([
			modelsRoute([CHAT_MODEL]),
			chatRoute(sse([{ choices: [{ delta: {}, finish_reason: "stop" }] }])),
		])
		await drain(
			makeOpenAI(fetch).chat(
				makeRequest({
					messages: [
						message("assistant", "checking"),
						toolResult("a", "first", "1"),
						toolResult("b", "second", "2"),
					],
				}),
			),
		)
		const messages = chatBody(fetch).messages as Array<Record<string, unknown>>
		expect(messages).toHaveLength(3)
		expect(messages[0]?.content).toBe("checking")
		expect(messages[0]?.tool_calls).toEqual([
			{ id: "a", type: "function", function: { name: "first", arguments: "{}" } },
			{ id: "b", type: "function", function: { name: "second", arguments: "{}" } },
		])
		expect(messages[1]).toEqual({ role: "tool", tool_call_id: "a", content: "1" })
		expect(messages[2]).toEqual({ role: "tool", tool_call_id: "b", content: "2" })
	})

	it("inserts a synthetic assistant message when no assistant precedes the tool result", async () => {
		const fetch = fakeFetch([
			modelsRoute([CHAT_MODEL]),
			chatRoute(sse([{ choices: [{ delta: {}, finish_reason: "stop" }] }])),
		])
		await drain(
			makeOpenAI(fetch).chat(
				makeRequest({
					messages: [message("user", "go"), toolResult("call_9", "run", "done")],
				}),
			),
		)
		expect(chatBody(fetch).messages).toEqual([
			{ role: "user", content: "go" },
			{
				role: "assistant",
				tool_calls: [
					{ id: "call_9", type: "function", function: { name: "run", arguments: "{}" } },
				],
			},
			{ role: "tool", tool_call_id: "call_9", content: "done" },
		])
	})

	it("advertises tool calls from the assistant message's meta.toolCalls record", async () => {
		const fetch = fakeFetch([
			modelsRoute([CHAT_MODEL]),
			chatRoute(sse([{ choices: [{ delta: {}, finish_reason: "stop" }] }])),
		])
		// A fresh driver instance — nothing in its tool-call memory. This is the
		// snapshot-restore case: the record on the message is the only source.
		await drain(
			makeOpenAI(fetch).chat(
				makeRequest({
					messages: [
						message("user", "weather?"),
						message("assistant", "", {
							toolCalls: [{ id: "call_1", name: "get_weather", arguments: '{"city":"SF"}' }],
						}),
						toolResult("call_1", "get_weather", "sunny"),
					],
				}),
			),
		)
		const messages = chatBody(fetch).messages as Array<Record<string, unknown>>
		expect(messages).toHaveLength(3)
		expect(messages[1]?.tool_calls).toEqual([
			{
				id: "call_1",
				type: "function",
				function: { name: "get_weather", arguments: '{"city":"SF"}' },
			},
		])
		// No duplicate record added when the tool result is paired up.
		expect((messages[1]?.tool_calls as unknown[]).length).toBe(1)
		expect(messages[1]?.content).toBeUndefined()
	})

	it("keeps assistant text alongside a meta.toolCalls record", async () => {
		const fetch = fakeFetch([
			modelsRoute([CHAT_MODEL]),
			chatRoute(sse([{ choices: [{ delta: {}, finish_reason: "stop" }] }])),
		])
		await drain(
			makeOpenAI(fetch).chat(
				makeRequest({
					messages: [
						message("assistant", "let me check", {
							toolCalls: [{ id: "a", name: "run", arguments: "{}" }],
						}),
						toolResult("a", "run", "ok"),
					],
				}),
			),
		)
		const messages = chatBody(fetch).messages as Array<Record<string, unknown>>
		expect(messages[0]?.content).toBe("let me check")
		expect(messages[0]?.tool_calls).toHaveLength(1)
	})

	it("ignores a malformed meta.toolCalls value and falls back", async () => {
		const fetch = fakeFetch([
			modelsRoute([CHAT_MODEL]),
			chatRoute(sse([{ choices: [{ delta: {}, finish_reason: "stop" }] }])),
		])
		await drain(
			makeOpenAI(fetch).chat(
				makeRequest({
					messages: [
						message("assistant", "", { toolCalls: "not-an-array" }),
						toolResult("call_1", "run", "ok"),
					],
				}),
			),
		)
		const messages = chatBody(fetch).messages as Array<Record<string, unknown>>
		expect(messages[0]?.tool_calls).toEqual([
			{ id: "call_1", type: "function", function: { name: "run", arguments: "{}" } },
		])
	})

	it("replays the real arguments of a tool call this driver streamed", async () => {
		const fetch = fakeFetch([
			modelsRoute([CHAT_MODEL]),
			chatRoute(
				sse([
					{
						choices: [
							{
								delta: {
									tool_calls: [
										{
											index: 0,
											id: "call_1",
											function: { name: "get_weather", arguments: '{"city":"SF"}' },
										},
									],
								},
								finish_reason: "tool_calls",
							},
						],
					},
				]),
			),
		])
		const driver = makeOpenAI(fetch)
		// Iteration 1: the model asks for a tool call.
		await drain(driver.chat(makeRequest()))
		// Iteration 2: the loop feeds the result back in.
		await drain(
			driver.chat(
				makeRequest({
					messages: [
						message("user", "weather?"),
						message("assistant", ""),
						toolResult("call_1", "get_weather", "sunny"),
					],
				}),
			),
		)
		const messages = chatBody(fetch, 1).messages as Array<Record<string, unknown>>
		expect(messages[1]?.tool_calls).toEqual([
			{
				id: "call_1",
				type: "function",
				function: { name: "get_weather", arguments: '{"city":"SF"}' },
			},
		])
	})

	it("mints a tool_call_id when the tool message carries none, and pairs both sides", async () => {
		const fetch = fakeFetch([
			modelsRoute([CHAT_MODEL]),
			chatRoute(sse([{ choices: [{ delta: {}, finish_reason: "stop" }] }])),
		])
		await drain(
			makeOpenAI(fetch).chat(
				makeRequest({ messages: [message("assistant", ""), message("tool", "orphan result")] }),
			),
		)
		const messages = chatBody(fetch).messages as Array<Record<string, unknown>>
		const calls = messages[0]?.tool_calls as Array<{ id: string }>
		expect(calls).toHaveLength(1)
		expect(calls[0]?.id).toBe(messages[1]?.tool_call_id)
		expect(typeof calls[0]?.id).toBe("string")
		expect((calls[0]?.id ?? "").length).toBeGreaterThan(0)
	})

	it("leaves an ordinary conversation untouched", async () => {
		const fetch = fakeFetch([
			modelsRoute([CHAT_MODEL]),
			chatRoute(sse([{ choices: [{ delta: {}, finish_reason: "stop" }] }])),
		])
		await drain(
			makeOpenAI(fetch).chat(
				makeRequest({ messages: [message("user", "hi"), message("assistant", "hello")] }),
			),
		)
		expect(chatBody(fetch).messages).toEqual([
			{ role: "user", content: "hi" },
			{ role: "assistant", content: "hello" },
		])
	})
})

describe("OpenAI — embed", () => {
	it("posts to /v1/embeddings and returns embeddings + usage", async () => {
		const fetch = fakeFetch([
			{
				url: `${BASE}/v1/embeddings`,
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
		const result = await makeOpenAI(fetch).embed({
			model: "text-embedding-3-small",
			input: ["hello", "world"],
		})
		expect(result.embeddings).toEqual([
			[0.1, 0.2],
			[0.3, 0.4],
		])
		expect(result.usage).toEqual({ inputTokens: 8, outputTokens: 0 })
		expect(JSON.parse(callsOf(fetch)[0]?.body ?? "{}")).toEqual({
			model: "text-embedding-3-small",
			input: ["hello", "world"],
		})
	})

	it("orders embeddings by the response index, not arrival order", async () => {
		const fetch = fakeFetch([
			{
				url: `${BASE}/v1/embeddings`,
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
		const result = await makeOpenAI(fetch).embed({ model: "m", input: ["a", "b"] })
		expect(result.embeddings).toEqual([[1], [2]])
	})

	it("returns undefined usage when the response omits prompt_tokens", async () => {
		const fetch = fakeFetch([
			{
				url: `${BASE}/v1/embeddings`,
				method: "POST",
				response: mockResponse({ json: { data: [{ embedding: [0.1], index: 0 }] } }),
			},
		])
		const result = await makeOpenAI(fetch).embed({ model: "m", input: ["test"] })
		expect(result.usage).toBeUndefined()
	})
})

describe("OpenAI — connection events", () => {
	it("listModels() success dispatches a 'connect' event with the resolved models", async () => {
		const fetch = fakeFetch([modelsRoute([CHAT_MODEL])])
		const driver = makeOpenAI(fetch)
		let captured: CustomEvent<{ models: { id: string }[] }> | undefined
		driver.addEventListener("connect", (e) => {
			captured = e as CustomEvent<{ models: { id: string }[] }>
		})
		const models = await driver.listModels()
		expect(captured?.detail.models).toEqual(models)
		expect(captured?.detail.models[0]?.id).toBe("gpt-4o-mini")
	})

	it("listModels() 401 dispatches 'error' with phase 'listModels' and re-throws", async () => {
		const fetch = fakeFetch([
			{
				url: `${BASE}/v1/models`,
				method: "GET",
				response: mockResponse({
					status: 401,
					body: '{"error":{"message":"Incorrect API key provided"}}',
				}),
			},
		])
		const driver = makeOpenAI(fetch)
		let captured: CustomEvent<{ error: unknown; phase: string }> | undefined
		driver.addEventListener("error", (e) => {
			captured = e as CustomEvent<{ error: unknown; phase: string }>
		})
		await expect(driver.listModels()).rejects.toBeDefined()
		expect(captured?.detail.phase).toBe("listModels")
		expect(captured?.detail.error).toMatchObject({ status: 401 })
	})

	it("listModels() fetch-thrown failure dispatches 'error' and re-throws", async () => {
		const throwingFetch = vi.fn(async () => {
			throw new TypeError("network error")
		}) as unknown as typeof fetch
		const driver = makeOpenAI(throwingFetch)
		let captured: CustomEvent<{ error: unknown; phase: string }> | undefined
		driver.addEventListener("error", (e) => {
			captured = e as CustomEvent<{ error: unknown; phase: string }>
		})
		await expect(driver.listModels()).rejects.toThrow(TypeError)
		expect(captured?.detail.phase).toBe("listModels")
		expect(captured?.detail.error).toBeInstanceOf(TypeError)
	})

	it("disconnect() dispatches a 'disconnect' event and clears the capabilities cache", async () => {
		const fetch = fakeFetch([modelsRoute([CHAT_MODEL])])
		const driver = makeOpenAI(fetch)
		await driver.listModels()
		expect(driver.capabilities("gpt-4o-mini").contextWindow).toBe(128000)

		let disconnected = false
		driver.addEventListener("disconnect", () => {
			disconnected = true
		})
		driver.disconnect()
		expect(disconnected).toBe(true)
		expect(driver.capabilities("gpt-4o-mini")).toEqual({
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
				url: `${BASE}/v1/embeddings`,
				method: "POST",
				response: mockResponse({ status: 500, body: "internal error" }),
			},
		])
		const driver = makeOpenAI(fetch)
		let captured: CustomEvent<{ error: unknown; phase: string }> | undefined
		driver.addEventListener("error", (e) => {
			captured = e as CustomEvent<{ error: unknown; phase: string }>
		})
		await expect(driver.embed({ model: "m", input: ["test"] })).rejects.toBeDefined()
		expect(captured?.detail.phase).toBe("embed")
	})
})
