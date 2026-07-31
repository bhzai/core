// LM Studio driver plugin — talks to a local (or remote) LM Studio server over
// plain `fetch`, using LM Studio's native REST API (`/api/v0/*`). Implements
// `BHZAIDriver` (from `src/types/driver.ts`) with no environment-specific
// bindings, so it runs in any runtime that has `fetch` (browser, Node,
// Electron).
//
// Scope of THIS file: the `LMStudio` class implementing `BHZAIDriver` in full —
// `chat()` (via `POST /api/v0/chat/completions`, SSE streaming), `listModels()`
// (via `GET /api/v0/models`), `capabilities()` (cached, sourced from the same
// `/api/v0/models` payload), and `embed()` (via `POST /api/v0/embeddings`). No
// new dependency is added — this driver uses only web-standard `fetch`, already
// available per ARCHITECTURE.md § 5's environment rules.
//
// WHY `/api/v0` AND NOT `/v1`: LM Studio also exposes an OpenAI-compatible
// `/v1` surface, but the native `/api/v0/models` payload carries the extra
// per-model metadata this driver needs to answer `capabilities()` —
// `max_context_length`, `type` (`'llm' | 'vlm' | 'embeddings'`), and the
// `capabilities` array on newer builds. `/v1/models` returns bare ids only,
// which would force every capability to a conservative default. The request and
// streaming-response bodies are OpenAI-shaped on both surfaces, so the chat
// mapping below is the familiar `choices[].delta` one.
//
// ENVIRONMENT BOUNDARY (§ 5): web-standard APIs only. This file touches only
// `fetch`, `AbortSignal`, `ReadableStream` (via `response.body`), `TextDecoder`,
// `crypto.randomUUID` (for fallback tool-call ids), and async iterables. No Node
// built-ins, no DOM.
//
// CREDENTIAL-RESOLUTION NOTE (§ 10.4): `LMStudioOptions.headers`, when supplied,
// are the "runtime values passed in driver options" that § 10.4 documents as the
// highest-priority tier of the credential-resolution chain. This driver simply
// accepts and forwards them on every `fetch` call — it does NOT implement the
// resolution chain itself. LM Studio's local server is unauthenticated by
// default (its optional API token is opt-in), so `headers` defaults to `{}` and
// every request works unauthenticated when omitted.

import type {
	BHZAIDriver,
	ChatRequest,
	DriverCapabilities,
	DriverEvent,
	ModelInfo,
	Usage,
} from "../../types/index.js"

/**
 * Host-supplied constructor options for {@link LMStudio}.
 */
export interface LMStudioOptions {
	/**
	 * Base URL of the LM Studio server ROOT — the driver appends `/api/v0/…`
	 * itself. Defaults to `'http://localhost:1234'`, the address LM Studio's
	 * Developer tab shows for a freshly started server.
	 */
	baseUrl?: string
	/**
	 * Custom headers forwarded on every `fetch` call (e.g. `Authorization`).
	 * Defaults to `{}`. These are the "runtime values passed in driver
	 * options" that § 10.4 documents as the highest-priority tier of the
	 * credential-resolution chain — the host supplies them; this driver does
	 * not resolve credentials itself.
	 */
	headers?: Record<string, string>
}

/**
 * One entry of LM Studio's `GET /api/v0/models` response (partial — only the
 * fields this driver reads).
 */
interface LMStudioModelEntry {
	id: string
	object?: string
	/** `'llm' | 'vlm' | 'embeddings'` on documented builds; treated as free text. */
	type?: string
	publisher?: string
	arch?: string
	compatibility_type?: string
	quantization?: string
	/** `'loaded' | 'not-loaded'`. Reported in `meta`, not in `availability`. */
	state?: string
	max_context_length?: number
	/**
	 * Declared capability slugs (e.g. `'tool_use'`). Present only on newer LM
	 * Studio builds — see {@link LMStudio.capabilities} for the fallback.
	 */
	capabilities?: string[]
}

/**
 * LM Studio `GET /api/v0/models` response shape (partial).
 */
interface ModelsResponse {
	object?: string
	data: LMStudioModelEntry[]
}

/**
 * One OpenAI-shaped streaming chunk from `POST /api/v0/chat/completions`
 * (partial — only the fields this driver reads).
 */
interface ChatChunk {
	id?: string
	object?: string
	model?: string
	choices?: Array<{
		index?: number
		delta?: {
			role?: string
			content?: string
			/** Emitted by reasoning models that separate thinking from the answer. */
			reasoning_content?: string
			tool_calls?: Array<{
				index?: number
				id?: string
				type?: string
				function?: { name?: string; arguments?: string }
			}>
		}
		finish_reason?: string | null
	}>
	usage?: {
		prompt_tokens?: number
		completion_tokens?: number
		total_tokens?: number
	}
}

/**
 * LM Studio `POST /api/v0/embeddings` response shape (partial).
 */
interface EmbedResponse {
	data: Array<{ embedding: number[]; index?: number }>
	usage?: { prompt_tokens?: number; total_tokens?: number }
}

/**
 * A tool call being assembled across streaming chunks. OpenAI-shaped streams
 * deliver the id and function name once, then the JSON arguments in fragments,
 * all keyed by `index` — so the driver accumulates and emits a single
 * `tool-call` event per index once the stream ends.
 */
interface PendingToolCall {
	/** Server-supplied id, or a `crypto.randomUUID()` fallback. */
	id: string
	/** Function name, assembled from whichever chunk carried it. */
	name: string
	/** Raw JSON argument text, concatenated in arrival order. */
	args: string
}

/**
 * Connection lifecycle event map for {@link LMStudio}.
 *
 * - `'connect'` — dispatched at the end of a successful `listModels()`,
 *   carrying the resolved `ModelInfo[]`.
 * - `'disconnect'` — dispatched by `disconnect()`; a host-intent signal
 *   (the stateless transport has no real connection to close).
 * - `'error'` — dispatched when `listModels()` or `embed()` fails, carrying
 *   the thrown error and the phase that failed. The original error is
 *   always re-thrown, so retry/kernel error routing is unchanged.
 */
export interface LMStudioEventMap {
	/** Resolved model list from a successful `listModels()`. */
	connect: { models: ModelInfo[] }
	/** No payload — `disconnect()` is a stateless host-intent signal. */
	// biome-ignore lint/suspicious/noConfusingVoidType: event-map value type, not a return type
	disconnect: void
	/** The thrown error and the method that failed. */
	error: { error: unknown; phase: "listModels" | "embed" }
}

/**
 * Declaration-merged typed `addEventListener` overloads for {@link LMStudio},
 * so consumers get typed listeners for the connection lifecycle events.
 * The inherited base `EventTarget.addEventListener` overloads remain
 * available for arbitrary event types.
 */
export interface LMStudio {
	/**
	 * Typed `'connect'` listener — receives the resolved model list.
	 */
	addEventListener(
		type: "connect",
		listener: (e: CustomEvent<LMStudioEventMap["connect"]>) => void,
	): void
	/**
	 * Typed `'disconnect'` listener — no payload (stateless host-intent).
	 */
	addEventListener(type: "disconnect", listener: (e: Event) => void): void
	/**
	 * Typed `'error'` listener — receives the thrown error and failed phase.
	 */
	addEventListener(
		type: "error",
		listener: (e: CustomEvent<LMStudioEventMap["error"]>) => void,
	): void
}

/**
 * `LMStudio` — a {@link BHZAIDriver} that talks to a local or remote LM Studio
 * server over plain `fetch`. Works in any fetch-capable runtime (browser, Node,
 * Electron).
 *
 * Shares the Ollama driver's posture (§ 10.3): no peer dependency, no engine
 * injection, web-standard APIs only. The difference is the wire format — LM
 * Studio speaks OpenAI-shaped JSON over Server-Sent Events, where Ollama speaks
 * its own NDJSON.
 *
 * Extends `EventTarget` to expose connection lifecycle events (`'connect'`,
 * `'disconnect'`, `'error'`) so hosts can observe connect/disconnect/
 * connection-fail without coupling to driver internals.
 */
// biome-ignore lint/suspicious/noUnsafeDeclarationMerging: intentional typed-event overloads via merged interface; adds only method overloads, no uninitialized fields
export class LMStudio extends EventTarget implements BHZAIDriver {
	readonly id = "lmstudio" as const
	private declare readonly baseUrl: string
	private declare readonly headers: Record<string, string>
	/**
	 * Cache of per-model capabilities, populated by `listModels()` (which reads
	 * them straight out of its own response) and by `chat()` (which calls
	 * `refreshCapabilitiesCache` for the model it is about to use). The
	 * synchronous `capabilities(model)` method reads from this cache, falling
	 * back to conservative defaults when no entry exists yet.
	 *
	 * SYNC/ASYNC MISMATCH RESOLUTION (same posture as the Ollama driver):
	 * `BHZAIDriver.capabilities(model)` is synchronous, but the data source
	 * (`GET /api/v0/models`) is asynchronous. This cache-then-read pattern
	 * resolves that tension. When `capabilities()` is called for a model no
	 * prior `listModels()`/`chat()` has populated, it returns conservative
	 * defaults (all booleans `false`, `contextWindow` `undefined`) rather than
	 * throwing.
	 */
	private readonly capabilitiesCache: Map<string, DriverCapabilities> = new Map()

	constructor(options?: LMStudioOptions) {
		super()
		this.baseUrl = options?.baseUrl ?? "http://localhost:1234"
		this.headers = options?.headers ?? {}
		// Test-injection seam: if the caller passed the internal
		// `fetchOverride` field, use it; otherwise use the global `fetch`.
		const internal = options as LMStudioInternalOptions | undefined
		// `globalThis.fetch` must be bound to the global object. Storing it as
		// a property and calling it later would make `this` the LMStudio
		// instance, which native fetch rejects with "Illegal invocation".
		this.fetchFn = internal?.fetchOverride ?? globalThis.fetch.bind(globalThis)
	}

	/**
	 * `GET {baseUrl}/api/v0/models` — lists every model LM Studio has
	 * downloaded, loaded or not, and caches each one's capabilities on the way
	 * through (no second request needed).
	 *
	 * AVAILABILITY MAPPING: every returned entry is `'ready'`. LM Studio's
	 * `state` field distinguishes `'loaded'` (resident in memory) from
	 * `'not-loaded'` (downloaded but idle), which is a *warm-up* distinction,
	 * not an availability one — LM Studio JIT-loads a `not-loaded` model on the
	 * first request that names it. Reporting `'downloadable'` would wrongly
	 * suggest the host must fetch something first, so the raw `state` is
	 * surfaced under `meta.state` instead and `availability` stays `'ready'`.
	 */
	async listModels(): Promise<ModelInfo[]> {
		try {
			const entries = await this.fetchModelEntries()
			const models: ModelInfo[] = entries.map((entry) => ({
				ref: `lmstudio/${entry.id}`,
				driver: "lmstudio",
				id: entry.id,
				label: entry.id,
				capabilities: this.capabilities(entry.id),
				availability: "ready" as const,
				meta: {
					type: entry.type,
					publisher: entry.publisher,
					arch: entry.arch,
					quantization: entry.quantization,
					compatibilityType: entry.compatibility_type,
					state: entry.state,
					maxContextLength: entry.max_context_length,
				},
			}))
			this.dispatchEvent(
				new CustomEvent<LMStudioEventMap["connect"]>("connect", {
					detail: { models },
				}),
			)
			return models
		} catch (error) {
			this.emitError("listModels", error)
			throw error
		}
	}

	/**
	 * Per-model capability flags. **Synchronous** — reads from the internal
	 * cache populated by `listModels()`/`chat()`. Returns conservative
	 * defaults (all booleans `false`, `contextWindow` `undefined`) when the
	 * cache has no entry for the model yet.
	 *
	 * Mapping from an `/api/v0/models` entry:
	 * - `streaming`: always `true` — `/api/v0/chat/completions` streams.
	 * - `toolCalls`: `capabilities.includes('tool_use')` when the server
	 *   declares a `capabilities` array; otherwise `type !== 'embeddings'`.
	 * - `reasoning`: `capabilities.includes('reasoning')`, else `false`.
	 * - `embeddings`: `type === 'embeddings'`.
	 * - `contextWindow`: `max_context_length`.
	 *
	 * EXPLICIT DEVIATION from the Ollama driver's "conservative default":
	 * `toolCalls` falls back to `true` for non-embedding models when the server
	 * omits the `capabilities` array, because LM Studio builds predating that
	 * field still serve tool calls through their generic tool-call parser.
	 * Defaulting to `false` there would silently strip every tool from every
	 * request against those builds — a far worse failure than forwarding tools
	 * to a model that then ignores them. Models the cache has never seen at all
	 * still get `toolCalls: false`; that is an absence of data, not a build
	 * that declined to declare.
	 */
	capabilities(model: string): DriverCapabilities {
		return (
			this.capabilitiesCache.get(model) ?? {
				streaming: true,
				toolCalls: false,
				reasoning: false,
				embeddings: false,
				contextWindow: undefined,
			}
		)
	}

	/**
	 * Host-intent disconnect signal. The LM Studio transport is stateless
	 * (plain `fetch` over HTTP — there is no persistent connection to close),
	 * so this method performs no network I/O. It clears the
	 * `capabilitiesCache` (a disconnected provider's cached caps are stale)
	 * and dispatches a `'disconnect'` event so hosts can react to the
	 * lifecycle transition.
	 */
	disconnect(): void {
		this.capabilitiesCache.clear()
		this.dispatchEvent(new Event("disconnect"))
	}

	/**
	 * One LLM call via `POST {baseUrl}/api/v0/chat/completions` with SSE
	 * streaming.
	 *
	 * Error handling: non-2xx responses throw an error object shaped
	 * `{ status, body }` so the retry classifier can inspect `.status`.
	 * Network-level `fetch` failures (thrown `TypeError`) propagate uncaught.
	 */
	async *chat(request: ChatRequest): AsyncIterable<DriverEvent> {
		// Ensure capabilities are cached for this model (for tool-call gating).
		await this.refreshCapabilitiesCache(request.model)
		const caps = this.capabilities(request.model)

		// Step 1: map BHZAIMessage[] into the OpenAI `{ role, content }` shape.
		// MVP simplification: multi-block ContentBlock[] content collapses to
		// the message's `content` string field, same posture as the WebLLM and
		// Ollama mappings.
		const messages = request.messages.map((m) => ({
			role: m.role,
			content: m.content,
		}))
		if (request.systemPrompt) {
			messages.unshift({ role: "system", content: request.systemPrompt })
		}

		// Step 2: map tools only when the model is tool-capable.
		const tools =
			caps.toolCalls && request.tools
				? request.tools.map((t) => ({
						type: "function" as const,
						function: {
							name: t.name,
							description: t.description,
							parameters: t.inputSchema,
						},
					}))
				: undefined

		// Step 3: assemble the request body. `stream_options.include_usage`
		// asks LM Studio for a final usage-only chunk; builds that don't
		// understand the option simply omit it and the `usage` event is
		// skipped.
		const body: Record<string, unknown> = {
			model: request.model,
			messages,
			stream: true,
			stream_options: { include_usage: true },
		}
		if (tools) body.tools = tools
		if (request.params?.temperature !== undefined) body.temperature = request.params.temperature
		if (request.params?.maxTokens !== undefined) body.max_tokens = request.params.maxTokens
		if (request.params?.stop) body.stop = request.params.stop

		// Step 4: POST and check status.
		const response = await this.fetch(`${this.baseUrl}/api/v0/chat/completions`, {
			method: "POST",
			headers: { "Content-Type": "application/json", ...this.headers },
			body: JSON.stringify(body),
			signal: request.signal,
		})
		if (!response.ok) {
			throw await this.httpError(response)
		}

		const stream = response.body
		if (!stream) {
			yield { type: "done", stopReason: "stop" }
			return
		}

		// Step 5: read the SSE stream. Tool calls are assembled across chunks
		// and emitted once at the end; usage and the terminal `done` follow.
		const pending = new Map<number, PendingToolCall>()
		let usage: Usage | undefined
		let finishReason: string | undefined
		const reader = stream.getReader()
		const decoder = new TextDecoder()
		let buffer = ""
		let finished = false
		try {
			while (!finished) {
				if (request.signal.aborted) {
					yield { type: "done", stopReason: "abort" }
					return
				}
				const { done, value } = await reader.read()
				if (done) break
				buffer += decoder.decode(value, { stream: true })
				// Split on newlines and process complete lines.
				let newlineIndex = buffer.indexOf("\n")
				while (newlineIndex >= 0) {
					const line = buffer.slice(0, newlineIndex).trim()
					buffer = buffer.slice(newlineIndex + 1)
					newlineIndex = buffer.indexOf("\n")
					// Blank separators, `event:` lines and `:` comments carry
					// nothing this driver needs.
					if (!line.startsWith("data:")) continue
					const payload = line.slice("data:".length).trim()
					if (payload === "[DONE]") {
						finished = true
						break
					}
					const chunk = JSON.parse(payload) as ChatChunk
					const choice = chunk.choices?.[0]
					const delta = choice?.delta
					// Reasoning text arrives on its own channel for models that
					// separate it; `<think>`-tag reasoning stays inline in
					// `content` and is the conversation layer's `parseThink` job.
					if (delta?.reasoning_content) {
						yield { type: "reasoning-delta", text: delta.reasoning_content }
					}
					if (delta?.content) {
						yield { type: "delta", text: delta.content }
					}
					if (delta?.tool_calls) {
						this.accumulateToolCalls(pending, delta.tool_calls)
					}
					if (choice?.finish_reason) {
						finishReason = choice.finish_reason
					}
					// A usage-bearing chunk may arrive with or without choices;
					// the last one seen wins.
					if (chunk.usage) {
						usage = {
							inputTokens: chunk.usage.prompt_tokens ?? 0,
							outputTokens: chunk.usage.completion_tokens ?? 0,
						}
					}
				}
			}
		} finally {
			reader.releaseLock()
		}

		// Step 6: terminal events, in the order the agent loop expects —
		// tool calls, then usage, then done.
		for (const index of Array.from(pending.keys()).sort((a, b) => a - b)) {
			const call = pending.get(index)
			if (!call) continue
			yield {
				type: "tool-call",
				toolCallId: call.id,
				name: call.name,
				input: call.args,
			}
		}
		if (usage) {
			yield { type: "usage", inputTokens: usage.inputTokens, outputTokens: usage.outputTokens }
		}
		yield {
			type: "done",
			stopReason: this.mapFinishReason(finishReason, pending.size > 0),
		}
	}

	/**
	 * Generate embeddings via `POST {baseUrl}/api/v0/embeddings`.
	 *
	 * Only call this for models whose `capabilities(model).embeddings` is
	 * `true`; calling it for a non-embedding model still forwards the request
	 * as-is (LM Studio itself will error) — gatekeeping which models are
	 * "allowed" to embed is a host/kernel-level concern, not this driver's job
	 * to enforce.
	 *
	 * Embedding calls have no "output tokens" concept, so `outputTokens` is
	 * hardcoded to `0` when usage is reported (the shared `Usage` type requires
	 * both fields).
	 */
	async embed(request: {
		model: string
		input: string[]
		signal?: AbortSignal
	}): Promise<{ embeddings: number[][]; usage?: Usage }> {
		try {
			const response = await this.fetch(`${this.baseUrl}/api/v0/embeddings`, {
				method: "POST",
				headers: { "Content-Type": "application/json", ...this.headers },
				body: JSON.stringify({ model: request.model, input: request.input }),
				signal: request.signal,
			})
			if (!response.ok) {
				throw await this.httpError(response)
			}
			const data = (await response.json()) as EmbedResponse
			// The response is an OpenAI-shaped `data` array carrying an explicit
			// `index`; sort by it rather than trusting arrival order, so the
			// result lines up positionally with `request.input`.
			const rows = [...(data.data ?? [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
			return {
				embeddings: rows.map((row) => row.embedding),
				usage:
					data.usage?.prompt_tokens !== undefined
						? {
								inputTokens: data.usage.prompt_tokens,
								outputTokens: 0,
							}
						: undefined,
			}
		} catch (error) {
			this.emitError("embed", error)
			throw error
		}
	}

	/**
	 * Merge one chunk's `tool_calls` fragments into the in-flight accumulator.
	 *
	 * OpenAI-shaped streams send the id and function name on the first fragment
	 * for a given `index`, then the JSON arguments a few characters at a time.
	 * A missing `index` is treated as `0` — single-tool-call streams from
	 * simpler servers omit it.
	 *
	 * @param pending - The accumulator, keyed by tool-call index
	 * @param fragments - This chunk's `delta.tool_calls` entries
	 */
	private accumulateToolCalls(
		pending: Map<number, PendingToolCall>,
		fragments: NonNullable<NonNullable<ChatChunk["choices"]>[number]["delta"]>["tool_calls"],
	): void {
		for (const fragment of fragments ?? []) {
			const index = fragment.index ?? 0
			let call = pending.get(index)
			if (!call) {
				// LM Studio supplies an id on the opening fragment, but older
				// builds and non-standard servers do not — fall back to a
				// generated one so the call is still addressable.
				call = { id: fragment.id ?? crypto.randomUUID(), name: "", args: "" }
				pending.set(index, call)
			}
			if (fragment.id) call.id = fragment.id
			if (fragment.function?.name) call.name += fragment.function.name
			if (fragment.function?.arguments) call.args += fragment.function.arguments
		}
	}

	/**
	 * Build and dispatch an `'error'` lifecycle event for a failed
	 * `listModels()` or `embed()` call. The original error is NOT swallowed —
	 * callers re-throw it after this helper runs, so retry and kernel
	 * error-routing behavior is unchanged.
	 */
	private emitError(phase: "listModels" | "embed", error: unknown): void {
		this.dispatchEvent(
			new CustomEvent<LMStudioEventMap["error"]>("error", {
				detail: { error, phase },
			}),
		)
	}

	/**
	 * Map OpenAI's `finish_reason` to BHZAI's `stopReason`.
	 * - `'length'` → `'length'`
	 * - `'tool_calls'`, or any run that produced tool calls → `'tool-calls'`
	 * - anything else (`'stop'`, absent) → `'stop'`
	 *
	 * The `hadToolCalls` override matters because some LM Studio builds close a
	 * tool-calling turn with `finish_reason: 'stop'`; treating that as a
	 * natural stop would strand the buffered calls unexecuted.
	 */
	private mapFinishReason(
		finishReason: string | undefined,
		hadToolCalls: boolean,
	): "stop" | "tool-calls" | "length" {
		if (finishReason === "length") return "length"
		if (finishReason === "tool_calls" || hadToolCalls) return "tool-calls"
		return "stop"
	}

	/**
	 * Fetch `GET /api/v0/models` and cache every entry's capabilities.
	 *
	 * Unlike Ollama's per-model `/api/show`, LM Studio returns the whole
	 * catalogue — with per-model metadata — in one response, so one request
	 * populates the cache for every model at once.
	 *
	 * @returns The raw model entries, for `listModels()` to map
	 */
	private async fetchModelEntries(): Promise<LMStudioModelEntry[]> {
		const response = await this.fetch(`${this.baseUrl}/api/v0/models`, {
			method: "GET",
			headers: this.headers,
		})
		if (!response.ok) {
			throw await this.httpError(response)
		}
		const data = (await response.json()) as ModelsResponse
		const entries = data.data ?? []
		for (const entry of entries) {
			this.capabilitiesCache.set(entry.id, this.parseModelEntry(entry))
		}
		return entries
	}

	/**
	 * Populate the capabilities cache for a model, if it isn't cached already,
	 * so the synchronous `capabilities()` method has data to read.
	 *
	 * Swallows failures on purpose: a `chat()` call must not be aborted because
	 * the catalogue lookup failed. `capabilities()` then returns conservative
	 * defaults and the chat request itself surfaces any real connectivity
	 * problem.
	 */
	private async refreshCapabilitiesCache(model: string): Promise<void> {
		if (this.capabilitiesCache.has(model)) return
		try {
			await this.fetchModelEntries()
		} catch {
			// Network or parse error — leave the cache unpopulated; the
			// synchronous `capabilities()` method returns conservative defaults.
		}
	}

	/**
	 * Project one `/api/v0/models` entry onto `DriverCapabilities` using the
	 * mapping documented on {@link LMStudio.capabilities}.
	 */
	private parseModelEntry(entry: LMStudioModelEntry): DriverCapabilities {
		const declared = entry.capabilities
		const isEmbedding = entry.type === "embeddings"
		return {
			streaming: true,
			toolCalls: declared ? declared.includes("tool_use") : !isEmbedding,
			reasoning: declared ? declared.includes("reasoning") : false,
			embeddings: isEmbedding,
			contextWindow:
				typeof entry.max_context_length === "number" ? entry.max_context_length : undefined,
		}
	}

	/**
	 * Build a `{ status, body }`-shaped error from a non-2xx response, so the
	 * retry classifier can inspect `.status`. The body is parsed as JSON if
	 * possible, otherwise returned as raw text.
	 */
	private async httpError(response: Response): Promise<{ status: number; body: unknown }> {
		const text = await response.text()
		let body: unknown = text
		try {
			body = JSON.parse(text)
		} catch {
			// Not JSON — keep raw text.
		}
		return { status: response.status, body }
	}

	/**
	 * Wrapper around `fetch` — extracted so tests can inject a fake. In
	 * production this is the global `fetch`.
	 *
	 * TEST INJECTION: tests override this via the constructor's
	 * `fetchOverride` option (not part of the public `LMStudioOptions` type to
	 * keep the public API clean). When no override is supplied, the global
	 * `fetch` is used.
	 */
	private declare readonly fetchFn: typeof fetch
	private fetch(input: string, init?: RequestInit): Promise<Response> {
		return this.fetchFn(input, init)
	}
}

/**
 * Internal constructor options (extends the public `LMStudioOptions` with a
 * test-injection seam for `fetch`). The `fetchOverride` field is not part of
 * the public API — it exists so tests can inject a fake `fetch` without
 * monkey-patching the global.
 */
export interface LMStudioInternalOptions extends LMStudioOptions {
	/** @internal Test-only override for the global `fetch`. */
	fetchOverride?: typeof fetch
}
