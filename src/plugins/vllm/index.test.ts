// vLLM driver plugin tests (§ 10.3).
//
// These cover the `VLLM` class's driver logic using a hand-written fake `fetch`
// injected via the internal `fetchOverride` option. They do NOT test a real
// server, the retry wrapper, or credential resolution.
//
// The harness below (mockResponse / fakeFetch / callsOf) is the shared HTTP
// driver harness; the fixtures and assertions under it are vLLM-specific.

import { describe, expect, it, vi } from "vitest"

import type { BHZAIMessage, ChatRequest, DriverEvent } from "../../types/index.js"
import { VLLM, type VLLMInternalOptions } from "./index.js"

/** Base URL every fixture routes against — vLLM's default bind address. */
const BASE = "http://localhost:8000"

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/** Build a minimal ChatRequest. */
function makeRequest(overrides: Partial<ChatRequest> = {}): ChatRequest {
	const controller = new AbortController()
	return { model: "test-model", messages: [], signal: controller.signal, ...overrides }
}

/** Build a `BHZAIMessage` with the fields the driver reads. */
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

/** Collect every event from an async iterable. */
async function drain(iter: AsyncIterable<DriverEvent>): Promise<DriverEvent[]> {
	const out: DriverEvent[] = []
	for await (const e of iter) out.push(e)
	return out
}

/**
 * Build a fake `Response`. Pass `body` for a streamable response (one chunk),
 * or `json` for a parsed one.
 */
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
		const encoded = new TextEncoder().encode(opts.body)
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
		;(response as { body: unknown }).body = { getReader: () => reader }
	}
	return response as Response
}

/** A fake `fetch` routing by URL + method, recording every call. */
function fakeFetch(
	routes: Array<{ url: string; method: string; response: Response }>,
): typeof fetch {
	const calls: Array<{ url: string; method: string; body?: string }> = []
	const fn = vi.fn(async (input: string, init?: RequestInit) => {
		const method = init?.method ?? "GET"
		calls.push({ url: input, method, body: init?.body as string | undefined })
		const route = routes.find((r) => r.url === input && r.method === method)
		return route ? route.response : mockResponse({ status: 404, body: "not found" })
	}) as unknown as typeof fetch
	;(fn as unknown as { calls: typeof calls }).calls = calls
	return fn
}

/** Read back the calls recorded by {@link fakeFetch} — asserts request mapping. */
function callsOf(fetchFn: typeof fetch): Array<{ url: string; method: string; body?: string }> {
	return (fetchFn as unknown as { calls: Array<{ url: string; method: string; body?: string }> })
		.calls
}

/** Construct the driver with an injected `fetch`. */
function makeDriver(fetchOverride: typeof fetch, options: Partial<VLLMInternalOptions> = {}) {
	return new VLLM({ ...options, fetchOverride } as VLLMInternalOptions)
}

// ---------------------------------------------------------------------------
// vLLM-specific fixtures
// ---------------------------------------------------------------------------

/** Serialize SSE `data:` frames. */
function sse(chunks: unknown[], { done = true } = {}): string {
	const frames = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`)
	return `${frames.join("")}${done ? "data: [DONE]\n\n" : ""}`
}

/** A `GET /v1/models` route returning the given entries. */
function modelsRoute(entries: unknown[]) {
	return {
		url: `${BASE}/v1/models`,
		method: "GET",
		response: mockResponse({ json: { object: "list", data: entries } }),
	}
}

/** A `POST /v1/chat/completions` route streaming the given body. */
function chatRoute(body: string) {
	return {
		url: `${BASE}/v1/chat/completions`,
		method: "POST",
		response: mockResponse({ body }),
	}
}

/** A stock vLLM base-model catalogue entry. */
const LLAMA_ENTRY = {
	id: "meta-llama/Llama-3.1-8B-Instruct",
	object: "model",
	created: 1715644056,
	owned_by: "vllm",
	root: "meta-llama/Llama-3.1-8B-Instruct",
	parent: null,
	max_model_len: 131072,
}

/**
 * Read the parsed JSON body of the MOST RECENT recorded chat request.
 *
 * Last-not-first matters for the multi-turn tests: a driver that streamed a tool
 * call on turn one is asserted on for what it sent on turn two.
 */
function chatBody(fetchFn: typeof fetch): Record<string, unknown> {
	const chatCalls = callsOf(fetchFn).filter((c) => c.url.endsWith("/v1/chat/completions"))
	return JSON.parse(chatCalls.at(-1)?.body ?? "{}")
}

// ---------------------------------------------------------------------------
// Constructor
// ---------------------------------------------------------------------------

describe("VLLM — constructor", () => {
	it("uses the expected driver id", () => {
		expect(makeDriver(fakeFetch([])).id).toBe("vllm")
	})

	it("defaults baseUrl to vLLM's port and hits /v1/models", async () => {
		const fetch = fakeFetch([modelsRoute([])])
		await makeDriver(fetch).listModels()
		expect(callsOf(fetch)[0]?.url).toBe(`${BASE}/v1/models`)
	})

	it("honors a custom baseUrl", async () => {
		const url = "https://vllm.internal:9000"
		const fetch = fakeFetch([
			{ url: `${url}/v1/models`, method: "GET", response: mockResponse({ json: { data: [] } }) },
		])
		await makeDriver(fetch, { baseUrl: url }).listModels()
		expect(callsOf(fetch)[0]?.url).toBe(`${url}/v1/models`)
	})

	it("forwards custom headers on every request", async () => {
		const seen: Array<Record<string, string> | undefined> = []
		const fn = vi.fn(async (_input: string, init?: RequestInit) => {
			seen.push(init?.headers as Record<string, string> | undefined)
			return mockResponse({ json: { data: [] } })
		}) as unknown as typeof fetch
		await new VLLM({
			headers: { Authorization: "Bearer secret" },
			fetchOverride: fn,
		} as VLLMInternalOptions).listModels()
		expect(seen[0]?.Authorization).toBe("Bearer secret")
	})

	// REGRESSION GUARD: an unbound global `fetch` throws "Illegal invocation".
	it("binds globalThis.fetch", async () => {
		const originalFetch = globalThis.fetch
		let capturedThis: unknown = "not-called"
		try {
			;(globalThis as { fetch: typeof fetch }).fetch = vi.fn(async function (this: unknown) {
				capturedThis = this
				return mockResponse({ json: { data: [] } })
			}) as unknown as typeof fetch
			await new VLLM().listModels()
			expect(capturedThis).toBe(globalThis)
		} finally {
			;(globalThis as { fetch: typeof fetch }).fetch = originalFetch
		}
	})
})

// ---------------------------------------------------------------------------
// listModels
// ---------------------------------------------------------------------------

describe("VLLM — listModels", () => {
	it("maps an entry into a whole ModelInfo, with max_model_len as contextWindow", async () => {
		const fetch = fakeFetch([modelsRoute([LLAMA_ENTRY])])
		const models = await makeDriver(fetch).listModels()
		expect(models).toEqual([
			{
				ref: "vllm/meta-llama/Llama-3.1-8B-Instruct",
				driver: "vllm",
				id: "meta-llama/Llama-3.1-8B-Instruct",
				label: "meta-llama/Llama-3.1-8B-Instruct",
				capabilities: {
					streaming: true,
					toolCalls: true,
					reasoning: false,
					embeddings: false,
					contextWindow: 131072,
				},
				availability: "ready",
				meta: {
					type: "chat",
					ownedBy: "vllm",
					created: 1715644056,
					root: "meta-llama/Llama-3.1-8B-Instruct",
					parent: null,
					maxModelLen: 131072,
				},
			},
		])
	})

	it("keeps slashes in the id, so the ref is driver + full repo path", async () => {
		const fetch = fakeFetch([modelsRoute([LLAMA_ENTRY])])
		const models = await makeDriver(fetch).listModels()
		// `parseModelRef` splits on the FIRST slash, so this round-trips.
		expect(models[0]?.ref).toBe("vllm/meta-llama/Llama-3.1-8B-Instruct")
		expect(models[0]?.id).toBe("meta-llama/Llama-3.1-8B-Instruct")
	})

	it("reports every served model as ready — vLLM loads at startup", async () => {
		const fetch = fakeFetch([modelsRoute([LLAMA_ENTRY, { id: "sql-lora", parent: "x" }])])
		const models = await makeDriver(fetch).listModels()
		expect(models.map((m) => m.availability)).toEqual(["ready", "ready"])
	})

	it("surfaces LoRA lineage under meta.parent / meta.root", async () => {
		const fetch = fakeFetch([
			modelsRoute([
				LLAMA_ENTRY,
				{
					id: "sql-lora",
					owned_by: "vllm",
					root: "jeeejeee/llama32-3b-text2sql-spider",
					parent: "meta-llama/Llama-3.1-8B-Instruct",
				},
			]),
		])
		const models = await makeDriver(fetch).listModels()
		expect(models[1]?.meta).toMatchObject({
			parent: "meta-llama/Llama-3.1-8B-Instruct",
			root: "jeeejeee/llama32-3b-text2sql-spider",
		})
	})

	it("lets a LoRA adapter inherit its parent's context window", async () => {
		const fetch = fakeFetch([
			modelsRoute([LLAMA_ENTRY, { id: "sql-lora", parent: "meta-llama/Llama-3.1-8B-Instruct" }]),
		])
		const models = await makeDriver(fetch).listModels()
		expect(models[1]?.capabilities.contextWindow).toBe(131072)
	})

	it("tags an embedding model so a chat host can filter it out", async () => {
		const fetch = fakeFetch([modelsRoute([{ id: "BAAI/bge-large-en-v1.5", max_model_len: 512 }])])
		const models = await makeDriver(fetch).listModels()
		expect(models[0]?.meta?.type).toBe("embeddings")
		expect(models[0]?.capabilities).toMatchObject({ embeddings: true, toolCalls: false })
	})

	it("treats an unrecognized id as a chat model", async () => {
		const fetch = fakeFetch([modelsRoute([{ id: "some-new-model-2027" }])])
		const models = await makeDriver(fetch).listModels()
		expect(models[0]?.meta?.type).toBe("chat")
	})

	it("returns an empty list when the server serves nothing", async () => {
		const fetch = fakeFetch([modelsRoute([])])
		expect(await makeDriver(fetch).listModels()).toEqual([])
	})
})

// ---------------------------------------------------------------------------
// capabilities
// ---------------------------------------------------------------------------

describe("VLLM — capabilities", () => {
	it("returns conservative defaults before any cache population", () => {
		expect(makeDriver(fakeFetch([])).capabilities("never-fetched")).toEqual({
			streaming: true,
			toolCalls: false,
			reasoning: false,
			embeddings: false,
			contextWindow: undefined,
		})
	})

	it("defaults toolCalls to true for a chat model once the catalogue is known", async () => {
		const fetch = fakeFetch([modelsRoute([LLAMA_ENTRY])])
		const driver = makeDriver(fetch)
		await driver.listModels()
		expect(driver.capabilities(LLAMA_ENTRY.id).toolCalls).toBe(true)
	})

	it("honors the toolCalls override for a server without a tool-call parser", async () => {
		const fetch = fakeFetch([modelsRoute([LLAMA_ENTRY])])
		const driver = makeDriver(fetch, { toolCalls: false })
		await driver.listModels()
		expect(driver.capabilities(LLAMA_ENTRY.id).toolCalls).toBe(false)
	})

	it("honors the reasoning override for a server started with a reasoning parser", async () => {
		const fetch = fakeFetch([modelsRoute([LLAMA_ENTRY])])
		const driver = makeDriver(fetch, { reasoning: true })
		await driver.listModels()
		expect(driver.capabilities(LLAMA_ENTRY.id).reasoning).toBe(true)
	})

	it("leaves contextWindow undefined when the server reports no max_model_len", async () => {
		const fetch = fakeFetch([modelsRoute([{ id: "bare-model" }])])
		const driver = makeDriver(fetch)
		await driver.listModels()
		expect(driver.capabilities("bare-model").contextWindow).toBeUndefined()
	})

	it("survives a failed metadata lookup during chat() and still streams", async () => {
		// No models route — the catalogue fetch 404s and is swallowed.
		const fetch = fakeFetch([chatRoute(sse([{ choices: [{ delta: { content: "hi" } }] }]))])
		const events = await drain(makeDriver(fetch).chat(makeRequest()))
		expect(events).toEqual([
			{ type: "delta", text: "hi" },
			{ type: "done", stopReason: "stop" },
		])
	})
})

// ---------------------------------------------------------------------------
// chat — streaming
// ---------------------------------------------------------------------------

describe("VLLM — chat streaming", () => {
	it("parses the stream into delta, usage, done in that order", async () => {
		const fetch = fakeFetch([
			modelsRoute([LLAMA_ENTRY]),
			chatRoute(
				sse([
					{ choices: [{ delta: { content: "Hello" } }] },
					{ choices: [{ delta: { content: " world" } }], usage: undefined },
					{ choices: [{ delta: {}, finish_reason: "stop" }] },
					{ choices: [], usage: { prompt_tokens: 12, completion_tokens: 3 } },
				]),
			),
		])
		const events = await drain(makeDriver(fetch).chat(makeRequest()))
		expect(events).toEqual([
			{ type: "delta", text: "Hello" },
			{ type: "delta", text: " world" },
			{ type: "usage", inputTokens: 12, outputTokens: 3 },
			{ type: "done", stopReason: "stop" },
		])
	})

	// The field vLLM's current stable docs document.
	it("maps delta.reasoning onto reasoning-delta", async () => {
		const fetch = fakeFetch([
			chatRoute(sse([{ choices: [{ delta: { reasoning: "thinking..." } }] }])),
		])
		const events = await drain(makeDriver(fetch).chat(makeRequest()))
		expect(events[0]).toEqual({ type: "reasoning-delta", text: "thinking..." })
	})

	// REGRESSION GUARD: older vLLM builds and forks name the same channel
	// `reasoning_content`. Reading only `reasoning` would drop it silently.
	it("falls back to delta.reasoning_content on older builds", async () => {
		const fetch = fakeFetch([
			chatRoute(sse([{ choices: [{ delta: { reasoning_content: "older channel" } }] }])),
		])
		const events = await drain(makeDriver(fetch).chat(makeRequest()))
		expect(events[0]).toEqual({ type: "reasoning-delta", text: "older channel" })
	})

	it("leaves inline <think> tags in the content stream for the conversation layer", async () => {
		const fetch = fakeFetch([
			chatRoute(sse([{ choices: [{ delta: { content: "<think>hm</think>answer" } }] }])),
		])
		const events = await drain(makeDriver(fetch).chat(makeRequest()))
		expect(events[0]).toEqual({ type: "delta", text: "<think>hm</think>answer" })
	})

	it("maps the length finish reason to stopReason 'length'", async () => {
		const fetch = fakeFetch([
			chatRoute(sse([{ choices: [{ delta: { content: "x" }, finish_reason: "length" }] }])),
		])
		const events = await drain(makeDriver(fetch).chat(makeRequest()))
		expect(events.at(-1)).toEqual({ type: "done", stopReason: "length" })
	})

	it("emits exactly one done event when the stream ends without [DONE]", async () => {
		const fetch = fakeFetch([
			chatRoute(sse([{ choices: [{ delta: { content: "x" } }] }], { done: false })),
		])
		const events = await drain(makeDriver(fetch).chat(makeRequest()))
		expect(events.filter((e) => e.type === "done")).toHaveLength(1)
	})

	it("yields done(abort) when the signal is already aborted", async () => {
		const controller = new AbortController()
		controller.abort()
		const fetch = fakeFetch([chatRoute(sse([{ choices: [{ delta: { content: "x" } }] }]))])
		const events = await drain(makeDriver(fetch).chat(makeRequest({ signal: controller.signal })))
		expect(events).toEqual([{ type: "done", stopReason: "abort" }])
	})

	it("throws an error carrying .status on a non-2xx response", async () => {
		// `src/core/retry.ts` classifies on `.status`.
		const fetch = fakeFetch([
			{
				url: `${BASE}/v1/chat/completions`,
				method: "POST",
				response: mockResponse({ status: 503, body: JSON.stringify({ error: "overloaded" }) }),
			},
		])
		await expect(drain(makeDriver(fetch).chat(makeRequest()))).rejects.toMatchObject({
			status: 503,
			body: { error: "overloaded" },
		})
	})
})

// ---------------------------------------------------------------------------
// chat — tool calls
// ---------------------------------------------------------------------------

describe("VLLM — chat tool calls", () => {
	it("accumulates streamed fragments into one tool-call event", async () => {
		const fetch = fakeFetch([
			modelsRoute([LLAMA_ENTRY]),
			chatRoute(
				sse([
					{
						choices: [
							{
								delta: {
									tool_calls: [
										{ index: 0, id: "call_1", function: { name: "get_weather", arguments: "" } },
									],
								},
							},
						],
					},
					{
						choices: [
							{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"city":' } }] } },
						],
					},
					{
						choices: [
							{
								delta: { tool_calls: [{ index: 0, function: { arguments: '"Rio"}' } }] },
								finish_reason: "tool_calls",
							},
						],
					},
				]),
			),
		])
		const events = await drain(makeDriver(fetch).chat(makeRequest({ model: LLAMA_ENTRY.id })))
		// `input` is the RAW accumulated argument string — the conversation layer
		// parses and repairs it, not the driver.
		expect(events).toEqual([
			{
				type: "tool-call",
				toolCallId: "call_1",
				name: "get_weather",
				input: '{"city":"Rio"}',
			},
			{ type: "done", stopReason: "tool-calls" },
		])
	})

	it("never emits tool-call-delta — the agent loop filters those out", async () => {
		const fetch = fakeFetch([
			chatRoute(
				sse([
					{
						choices: [
							{
								delta: {
									tool_calls: [{ index: 0, id: "c", function: { name: "t", arguments: "{}" } }],
								},
							},
						],
					},
				]),
			),
		])
		const events = await drain(makeDriver(fetch).chat(makeRequest()))
		expect(events.some((e) => e.type === "tool-call-delta")).toBe(false)
	})

	it("keeps parallel tool calls separate and emits them in index order", async () => {
		const fetch = fakeFetch([
			chatRoute(
				sse([
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
				]),
			),
		])
		const events = await drain(makeDriver(fetch).chat(makeRequest()))
		expect(events.filter((e) => e.type === "tool-call")).toEqual([
			{ type: "tool-call", toolCallId: "a", name: "first", input: "{}" },
			{ type: "tool-call", toolCallId: "b", name: "second", input: "{}" },
		])
	})

	it("generates a fallback id when a fragment carries none", async () => {
		const fetch = fakeFetch([
			chatRoute(
				sse([
					{ choices: [{ delta: { tool_calls: [{ function: { name: "t", arguments: "{}" } }] } }] },
				]),
			),
		])
		const events = await drain(makeDriver(fetch).chat(makeRequest()))
		const call = events.find((e) => e.type === "tool-call")
		expect(call).toMatchObject({ name: "t", input: "{}" })
		// A generated UUID, not an empty string.
		expect((call as { toolCallId: string }).toolCallId).toMatch(/[0-9a-f-]{36}/)
	})

	// REGRESSION GUARD: several vLLM tool-call parsers extract the call from text
	// the model ended normally, closing the turn with 'stop'. Trusting that would
	// strand the calls unexecuted.
	it("reports 'tool-calls' even when the server finishes with 'stop'", async () => {
		const fetch = fakeFetch([
			chatRoute(
				sse([
					{
						choices: [
							{
								delta: {
									tool_calls: [{ index: 0, id: "c", function: { name: "t", arguments: "{}" } }],
								},
								finish_reason: "stop",
							},
						],
					},
				]),
			),
		])
		const events = await drain(makeDriver(fetch).chat(makeRequest()))
		expect(events.at(-1)).toEqual({ type: "done", stopReason: "tool-calls" })
	})
})

// ---------------------------------------------------------------------------
// chat — request mapping
// ---------------------------------------------------------------------------

describe("VLLM — chat request mapping", () => {
	it("sends the system prompt as a leading system message", async () => {
		const fetch = fakeFetch([chatRoute(sse([]))])
		await drain(
			makeDriver(fetch).chat(
				makeRequest({ messages: [message("user", "hi")], systemPrompt: "Be terse." }),
			),
		)
		expect(chatBody(fetch).messages).toEqual([
			{ role: "system", content: "Be terse." },
			{ role: "user", content: "hi" },
		])
	})

	it("requests streaming with usage included", async () => {
		const fetch = fakeFetch([chatRoute(sse([]))])
		await drain(makeDriver(fetch).chat(makeRequest()))
		expect(chatBody(fetch)).toMatchObject({
			stream: true,
			stream_options: { include_usage: true },
		})
	})

	it("maps generation params, using max_tokens rather than max_completion_tokens", async () => {
		const fetch = fakeFetch([chatRoute(sse([]))])
		await drain(
			makeDriver(fetch).chat(
				makeRequest({ params: { temperature: 0.2, maxTokens: 256, stop: ["\n\n"] } }),
			),
		)
		const body = chatBody(fetch)
		expect(body).toMatchObject({ temperature: 0.2, max_tokens: 256, stop: ["\n\n"] })
		expect(body.max_completion_tokens).toBeUndefined()
	})

	it("forwards tools when the model is tool-capable", async () => {
		const fetch = fakeFetch([modelsRoute([LLAMA_ENTRY]), chatRoute(sse([]))])
		await drain(
			makeDriver(fetch).chat(
				makeRequest({
					model: LLAMA_ENTRY.id,
					tools: [
						{
							name: "get_weather",
							description: "Look up weather",
							inputSchema: { type: "object", properties: {} },
						},
					],
				}),
			),
		)
		expect(chatBody(fetch).tools).toEqual([
			{
				type: "function",
				function: {
					name: "get_weather",
					description: "Look up weather",
					parameters: { type: "object", properties: {} },
				},
			},
		])
	})

	it("omits tools when the model is not tool-capable", async () => {
		const fetch = fakeFetch([modelsRoute([LLAMA_ENTRY]), chatRoute(sse([]))])
		await drain(
			makeDriver(fetch, { toolCalls: false }).chat(
				makeRequest({
					model: LLAMA_ENTRY.id,
					tools: [{ name: "t", description: "d", inputSchema: { type: "object" } }],
				}),
			),
		)
		expect(chatBody(fetch).tools).toBeUndefined()
	})

	it("collapses the reasoning scale onto chat_template_kwargs booleans", async () => {
		const fetch = fakeFetch([chatRoute(sse([]))])
		await drain(makeDriver(fetch).chat(makeRequest({ params: { reasoning: "high" } })))
		expect(chatBody(fetch).chat_template_kwargs).toEqual({
			enable_thinking: true,
			thinking: true,
		})
	})

	it("maps reasoning 'off' onto disabled thinking", async () => {
		const fetch = fakeFetch([chatRoute(sse([]))])
		await drain(makeDriver(fetch).chat(makeRequest({ params: { reasoning: "off" } })))
		expect(chatBody(fetch).chat_template_kwargs).toEqual({
			enable_thinking: false,
			thinking: false,
		})
	})

	it("omits chat_template_kwargs entirely when no reasoning level was requested", async () => {
		const fetch = fakeFetch([chatRoute(sse([]))])
		await drain(makeDriver(fetch).chat(makeRequest()))
		expect(chatBody(fetch).chat_template_kwargs).toBeUndefined()
	})
})

// ---------------------------------------------------------------------------
// chat — tool-loop message reconstruction
// ---------------------------------------------------------------------------

describe("VLLM — tool-loop message mapping", () => {
	it("advertises an assistant turn's recorded tool calls verbatim", async () => {
		const fetch = fakeFetch([chatRoute(sse([]))])
		await drain(
			makeDriver(fetch).chat(
				makeRequest({
					messages: [
						message("user", "weather?"),
						message("assistant", "", {
							toolCalls: [{ id: "call_1", name: "get_weather", arguments: '{"city":"Rio"}' }],
						}),
						message("tool", "22C", { toolCallId: "call_1", toolName: "get_weather" }),
					],
				}),
			),
		)
		expect(chatBody(fetch).messages).toEqual([
			{ role: "user", content: "weather?" },
			{
				role: "assistant",
				tool_calls: [
					{
						id: "call_1",
						type: "function",
						function: { name: "get_weather", arguments: '{"city":"Rio"}' },
					},
				],
			},
			{ role: "tool", tool_call_id: "call_1", content: "22C" },
		])
	})

	it("splices a synthetic assistant turn when a tool result has no antecedent", async () => {
		const fetch = fakeFetch([chatRoute(sse([]))])
		await drain(
			makeDriver(fetch).chat(
				makeRequest({
					messages: [
						message("user", "go"),
						message("tool", "done", { toolCallId: "orphan", toolName: "runner" }),
					],
				}),
			),
		)
		expect(chatBody(fetch).messages).toEqual([
			{ role: "user", content: "go" },
			{
				role: "assistant",
				tool_calls: [
					{ id: "orphan", type: "function", function: { name: "runner", arguments: "{}" } },
				],
			},
			{ role: "tool", tool_call_id: "orphan", content: "done" },
		])
	})

	it("groups parallel tool results onto one assistant turn", async () => {
		const fetch = fakeFetch([chatRoute(sse([]))])
		await drain(
			makeDriver(fetch).chat(
				makeRequest({
					messages: [
						message("assistant", ""),
						message("tool", "a", { toolCallId: "1", toolName: "first" }),
						message("tool", "b", { toolCallId: "2", toolName: "second" }),
					],
				}),
			),
		)
		const messages = chatBody(fetch).messages as Array<Record<string, unknown>>
		expect(messages[0]?.tool_calls).toHaveLength(2)
		// Empty content is dropped rather than sent as "".
		expect(messages[0]?.content).toBeUndefined()
	})

	it("recovers real arguments from a call this driver streamed earlier", async () => {
		const fetch = fakeFetch([
			chatRoute(
				sse([
					{
						choices: [
							{
								delta: {
									tool_calls: [
										{
											index: 0,
											id: "call_9",
											function: { name: "lookup", arguments: '{"q":"x"}' },
										},
									],
								},
							},
						],
					},
				]),
			),
		])
		const driver = makeDriver(fetch)
		// First turn: the driver streams and remembers the call.
		await drain(driver.chat(makeRequest()))
		// Second turn: the tool result carries only the id, no recorded arguments.
		await drain(
			driver.chat(
				makeRequest({
					messages: [
						message("assistant", ""),
						message("tool", "ok", { toolCallId: "call_9", toolName: "lookup" }),
					],
				}),
			),
		)
		const messages = chatBody(fetch).messages as Array<Record<string, unknown>>
		expect(messages[0]?.tool_calls).toEqual([
			{ id: "call_9", type: "function", function: { name: "lookup", arguments: '{"q":"x"}' } },
		])
	})
})

// ---------------------------------------------------------------------------
// embed
// ---------------------------------------------------------------------------

describe("VLLM — embed", () => {
	it("returns embeddings ordered by response index, plus usage", async () => {
		const fetch = fakeFetch([
			{
				url: `${BASE}/v1/embeddings`,
				method: "POST",
				response: mockResponse({
					json: {
						data: [
							{ embedding: [0.3], index: 1 },
							{ embedding: [0.1], index: 0 },
						],
						usage: { prompt_tokens: 7 },
					},
				}),
			},
		])
		const result = await makeDriver(fetch).embed({ model: "bge", input: ["a", "b"] })
		expect(result).toEqual({
			embeddings: [[0.1], [0.3]],
			usage: { inputTokens: 7, outputTokens: 0 },
		})
	})

	it("returns undefined usage when the response omits token counts", async () => {
		const fetch = fakeFetch([
			{
				url: `${BASE}/v1/embeddings`,
				method: "POST",
				response: mockResponse({ json: { data: [{ embedding: [1], index: 0 }] } }),
			},
		])
		const result = await makeDriver(fetch).embed({ model: "bge", input: ["a"] })
		expect(result.usage).toBeUndefined()
	})

	it("throws an error carrying .status on a non-2xx response", async () => {
		const fetch = fakeFetch([
			{
				url: `${BASE}/v1/embeddings`,
				method: "POST",
				response: mockResponse({ status: 400, body: "not an embedding model" }),
			},
		])
		await expect(makeDriver(fetch).embed({ model: "chat", input: ["a"] })).rejects.toMatchObject({
			status: 400,
		})
	})
})

// ---------------------------------------------------------------------------
// Connection lifecycle events
// ---------------------------------------------------------------------------

describe("VLLM — connection events", () => {
	it("listModels() success dispatches 'connect' with the resolved models", async () => {
		const fetch = fakeFetch([modelsRoute([LLAMA_ENTRY])])
		const driver = makeDriver(fetch)
		const seen: unknown[] = []
		driver.addEventListener("connect", (e) => seen.push(e.detail.models))
		const models = await driver.listModels()
		expect(seen).toEqual([models])
	})

	it("listModels() failure dispatches 'error' with phase and re-throws", async () => {
		const fetch = fakeFetch([]) // every route 404s
		const driver = makeDriver(fetch)
		const seen: Array<{ phase: string }> = []
		driver.addEventListener("error", (e) => seen.push(e.detail))
		await expect(driver.listModels()).rejects.toMatchObject({ status: 404 })
		expect(seen).toHaveLength(1)
		expect(seen[0]?.phase).toBe("listModels")
	})

	it("embed() failure dispatches 'error' with phase 'embed' and re-throws", async () => {
		const fetch = fakeFetch([])
		const driver = makeDriver(fetch)
		const seen: Array<{ phase: string }> = []
		driver.addEventListener("error", (e) => seen.push(e.detail))
		await expect(driver.embed({ model: "m", input: ["a"] })).rejects.toMatchObject({ status: 404 })
		expect(seen[0]?.phase).toBe("embed")
	})

	it("disconnect() dispatches 'disconnect' and clears the capabilities cache", async () => {
		const fetch = fakeFetch([modelsRoute([LLAMA_ENTRY])])
		const driver = makeDriver(fetch)
		await driver.listModels()
		expect(driver.capabilities(LLAMA_ENTRY.id).contextWindow).toBe(131072)

		let disconnected = false
		driver.addEventListener("disconnect", () => {
			disconnected = true
		})
		driver.disconnect()

		expect(disconnected).toBe(true)
		// Back to conservative defaults — the cached entry is gone.
		expect(driver.capabilities(LLAMA_ENTRY.id).contextWindow).toBeUndefined()
		expect(driver.capabilities(LLAMA_ENTRY.id).toolCalls).toBe(false)
	})
})
