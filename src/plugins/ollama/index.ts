// Ollama driver plugin — talks to a local/remote Ollama server over plain
// `fetch` (ARCHITECTURE.md § 10.3). Implements `BHZAIDriver` (from
// `src/types/driver.ts`) with no environment-specific bindings, so it runs
// in any runtime that has `fetch` (browser, Node, Electron).
//
// Scope of THIS file (TASK_0020): the `Ollama` class implementing `BHZAIDriver`
// in full — `chat()` (via `POST /api/chat`), `listModels()` (via
// `GET /api/tags`), `capabilities()` (via `GET /api/show`, cached), and
// `embed()` (via `POST /api/embed`). No new dependency is added — this driver
// uses only web-standard `fetch`, already available per § 5's environment
// rules.
//
// ENVIRONMENT BOUNDARY (§ 5): web-standard APIs only. This file touches only
// `fetch`, `AbortSignal`, `ReadableStream` (via `response.body`'s async
// iterable), `crypto.randomUUID` (for fallback tool-call ids), and async
// iterables. No Node built-ins, no DOM.
//
// PATH NOTE: TASK_0020 specifies `bhzai/src/drivers/ollama/index.ts`, but the
// package layout already established by TASK_0001/TASK_0002 places plugins
// under `src/plugins/<name>/` (see `package.json` `exports` and
// `tsup.config.ts`). This file follows the existing repo convention; the
// behavioral contract is unchanged.
//
// CREDENTIAL-RESOLUTION NOTE (§ 10.4): `OllamaOptions.headers`, when supplied,
// are the "runtime values passed in driver options" that § 10.4 documents as
// the highest-priority tier of the credential-resolution chain. This driver
// simply accepts and forwards them on every `fetch` call — it does NOT
// implement the resolution chain itself (that's TASK_0021's
// `resolveCredentials`). Since local Ollama needs no auth, `headers` defaults
// to `{}` and every request works unauthenticated when omitted — this is the
// expected, correct default, not a missing feature.

import type {
	BHZAIDriver,
	ChatRequest,
	DriverCapabilities,
	DriverEvent,
	ModelInfo,
	Usage,
} from "../../types/index.js"

/**
 * Host-supplied constructor options for {@link Ollama}.
 */
export interface OllamaOptions {
	/**
	 * Base URL of the Ollama server. Defaults to `'http://localhost:11434'`.
	 */
	baseUrl?: string
	/**
	 * Custom headers forwarded on every `fetch` call (e.g.
	 * `Authorization`). Defaults to `{}`. These are the "runtime values
	 * passed in driver options" that § 10.4 documents as the highest-
	 * priority tier of the credential-resolution chain — the host supplies
	 * them; this driver does not resolve credentials itself.
	 */
	headers?: Record<string, string>
}

/**
 * Ollama `/api/tags` response shape (partial — only fields this driver reads).
 */
interface TagsResponse {
	models: Array<{
		name: string
		model: string
		size: number
		digest: string
		details?: {
			family?: string
			parameter_size?: string
			quantization_level?: string
		}
	}>
}

/**
 * Ollama `/api/show` response shape (partial — only fields this driver reads).
 */
interface ShowResponse {
	capabilities?: string[]
	model_info?: Record<string, unknown>
}

/**
 * Ollama `/api/chat` NDJSON line shape (partial — only fields this driver
 * reads).
 */
interface ChatChunk {
	model?: string
	created_at?: string
	message?: {
		role?: string
		content?: string
		tool_calls?: Array<{
			id?: string
			function: { name: string; arguments: string }
		}>
	}
	done: boolean
	done_reason?: string
	prompt_eval_count?: number
	eval_count?: number
}

/**
 * Ollama `/api/embed` response shape (partial).
 */
interface EmbedResponse {
	embeddings: number[][]
	prompt_eval_count?: number
}

/**
 * Connection lifecycle event map for {@link Ollama}.
 *
 * - `'connect'` — dispatched at the end of a successful `listModels()`,
 *   carrying the resolved `ModelInfo[]`.
 * - `'disconnect'` — dispatched by `disconnect()`; a host-intent signal
 *   (the stateless transport has no real connection to close).
 * - `'error'` — dispatched when `listModels()` or `embed()` fails, carrying
 *   the thrown error and the phase that failed. The original error is
 *   always re-thrown, so retry/kernel error routing is unchanged.
 */
export interface OllamaEventMap {
	/** Resolved model list from a successful `listModels()`. */
	connect: { models: ModelInfo[] }
	/** No payload — `disconnect()` is a stateless host-intent signal. */
	// biome-ignore lint/suspicious/noConfusingVoidType: event-map value type, not a return type
	disconnect: void
	/** The thrown error and the method that failed. */
	error: { error: unknown; phase: "listModels" | "embed" }
}

/**
 * Declaration-merged typed `addEventListener` overloads for {@link Ollama},
 * so consumers get typed listeners for the connection lifecycle events.
 * The inherited base `EventTarget.addEventListener` overloads remain
 * available for arbitrary event types.
 */
export interface Ollama {
	/**
	 * Typed `'connect'` listener — receives the resolved model list.
	 */
	addEventListener(
		type: "connect",
		listener: (e: CustomEvent<OllamaEventMap["connect"]>) => void,
	): void
	/**
	 * Typed `'disconnect'` listener — no payload (stateless host-intent).
	 */
	addEventListener(type: "disconnect", listener: (e: Event) => void): void
	/**
	 * Typed `'error'` listener — receives the thrown error and failed phase.
	 */
	addEventListener(type: "error", listener: (e: CustomEvent<OllamaEventMap["error"]>) => void): void
}

/**
 * `Ollama` — a {@link BHZAIDriver} that talks to a local or remote Ollama
 * server over plain `fetch`. Works in any fetch-capable runtime (browser,
 * Node, Electron).
 *
 * This is the second of the two "bundled drivers" (§ 10.3). Unlike WebLLM,
 * it needs no peer dependency — just `fetch`.
 *
 * Extends `EventTarget` to expose connection lifecycle events
 * (`'connect'`, `'disconnect'`, `'error'`) so hosts can observe
 * connect/disconnect/connection-fail without coupling to driver internals.
 */
// biome-ignore lint/suspicious/noUnsafeDeclarationMerging: intentional typed-event overloads via merged interface; adds only method overloads, no uninitialized fields
export class Ollama extends EventTarget implements BHZAIDriver {
	readonly id = "ollama" as const
	private declare readonly baseUrl: string
	private declare readonly headers: Record<string, string>
	/**
	 * Cache of per-model capabilities, populated eagerly by `listModels()`
	 * and `chat()` (both call `fetchShowCapabilities` for any model they
	 * reference). The synchronous `capabilities(model)` method reads from
	 * this cache, falling back to conservative defaults when no entry
	 * exists yet.
	 *
	 * SYNC/ASYNC MISMATCH RESOLUTION (explicit assumption, since the spec
	 * doesn't reconcile it): `BHZAIDriver.capabilities(model)` is
	 * synchronous per TASK_0009/TASK_0002, but this driver's data source
	 * (`GET /api/show`) is inherently asynchronous. This cache-then-read
	 * pattern resolves that tension: the first `listModels()` or `chat()`
	 * call for a given model eagerly fetches and caches `/api/show` results,
	 * and subsequent synchronous `capabilities(model)` calls read from the
	 * cache. When `capabilities()` is called before any prior
	 * `listModels()`/`chat()` populated the cache for that specific model,
	 * it returns conservative defaults (all booleans `false`,
	 * `contextWindow` `undefined`) — not a thrown error. A future task
	 * could add an async `refreshCapabilities(model)` method if this
	 * caching approach proves insufficient; that is explicitly out of
	 * scope here.
	 */
	private readonly capabilitiesCache: Map<string, DriverCapabilities> = new Map()

	constructor(options?: OllamaOptions) {
		super()
		this.baseUrl = options?.baseUrl ?? "http://localhost:11434"
		this.headers = options?.headers ?? {}
		// Test-injection seam: if the caller passed the internal
		// `fetchOverride` field, use it; otherwise use the global `fetch`.
		const internal = options as OllamaInternalOptions | undefined
		// `globalThis.fetch` must be bound to the global object. Storing it as
		// a property and calling it later would make `this` the Ollama
		// instance, which native fetch rejects with "Illegal invocation".
		this.fetchFn = internal?.fetchOverride ?? globalThis.fetch.bind(globalThis)
	}

	/**
	 * `GET {baseUrl}/api/tags` — lists all pulled models. Every model
	 * returned by `/api/tags` is, by definition, already pulled, so
	 * `availability` is always `'ready'`.
	 *
	 * BOUNDARY NOTE: this method only ever returns `'ready'` entries. Any
	 * `'downloadable'` Ollama entries in the merged catalogue come from a
	 * `modelSource` hook contribution merged in later by TASK_0022, not
	 * from this driver directly — Ollama's HTTP API does not expose a
	 * "known but unpulled" catalogue endpoint.
	 */
	async listModels(): Promise<ModelInfo[]> {
		try {
			const response = await this.fetch(`${this.baseUrl}/api/tags`, {
				method: "GET",
				headers: this.headers,
			})
			if (!response.ok) {
				throw await this.httpError(response)
			}
			const data = (await response.json()) as TagsResponse
			// Eagerly fetch and cache capabilities for each model so subsequent
			// synchronous `capabilities(model)` calls have data to read.
			const models: ModelInfo[] = []
			for (const m of data.models ?? []) {
				await this.refreshCapabilitiesCache(m.name)
				models.push({
					ref: `ollama/${m.name}`,
					driver: "ollama",
					id: m.name,
					label: m.name,
					capabilities: this.capabilities(m.name),
					availability: "ready",
					meta: {
						size: m.size,
						digest: m.digest,
						family: m.details?.family,
						parameterSize: m.details?.parameter_size,
						quantization: m.details?.quantization_level,
					},
				})
			}
			this.dispatchEvent(
				new CustomEvent<OllamaEventMap["connect"]>("connect", {
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
	 * Field-name assumptions (this task's own best-effort mapping of
	 * Ollama's documented API surface, since the architecture doc doesn't
	 * enumerate Ollama's exact response schema):
	 * - `toolCalls`: `response.capabilities?.includes('tools')` → `true`
	 * - `reasoning`: `response.capabilities?.includes('thinking')` → `true`
	 * - `embeddings`: `response.capabilities?.includes('embedding')` → `true`
	 * - `contextWindow`: first numeric `*.context_length` field in
	 *   `response.model_info`
	 *
	 * A future task should update this mapping if Ollama's API evolves.
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
	 * Host-intent disconnect signal. The Ollama transport is stateless
	 * (plain `fetch` over HTTP — there is no persistent connection to
	 * close), so this method performs no network I/O. It clears the
	 * `capabilitiesCache` (a disconnected provider's cached caps are
	 * stale) and dispatches a `'disconnect'` event so hosts can react to
	 * the lifecycle transition.
	 */
	disconnect(): void {
		this.capabilitiesCache.clear()
		this.dispatchEvent(new Event("disconnect"))
	}

	/**
	 * One LLM call via `POST {baseUrl}/api/chat` with NDJSON streaming.
	 *
	 * Error handling: non-2xx responses throw an error object shaped
	 * `{ status, body }` so TASK_0018's retry classifier can inspect
	 * `.status`. Network-level `fetch` failures (thrown `TypeError`)
	 * propagate uncaught.
	 */
	async *chat(request: ChatRequest): AsyncIterable<DriverEvent> {
		// Ensure capabilities are cached for this model (for tool-call
		// gating and reasoning mapping).
		await this.refreshCapabilitiesCache(request.model)
		const caps = this.capabilities(request.model)

		// Step 1: map BHZAIMessage[] into Ollama's { role, content } shape.
		// MVP simplification: multi-block ContentBlock[] content collapses
		// to the message's `content` string field, same posture as
		// TASK_0019's WebLLM mapping.
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

		// Step 3: map generation params. `reasoning` is mapped to Ollama's
		// boolean `think` parameter when the model supports it (many-to-one
		// simplification: BHZAI's 6-level scale → Ollama's boolean toggle).
		const options: Record<string, unknown> = {}
		if (request.params?.temperature !== undefined) options.temperature = request.params.temperature
		if (request.params?.maxTokens !== undefined) options.num_predict = request.params.maxTokens
		if (request.params?.stop) options.stop = request.params.stop

		const body: Record<string, unknown> = {
			model: request.model,
			messages,
			stream: true,
		}
		if (tools) body.tools = tools
		if (Object.keys(options).length > 0) body.options = options
		if (caps.reasoning && request.params?.reasoning) {
			body.think = request.params.reasoning !== "off"
		}

		// Step 4: POST and check status.
		const response = await this.fetch(`${this.baseUrl}/api/chat`, {
			method: "POST",
			headers: { "Content-Type": "application/json", ...this.headers },
			body: JSON.stringify(body),
			signal: request.signal,
		})
		if (!response.ok) {
			throw await this.httpError(response)
		}

		// Step 5: read NDJSON stream.
		const stream = response.body
		if (!stream) {
			yield { type: "done", stopReason: "stop" }
			return
		}
		const reader = stream.getReader()
		const decoder = new TextDecoder()
		let buffer = ""
		let hadToolCalls = false
		try {
			while (true) {
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
					if (!line) continue
					const chunk = JSON.parse(line) as ChatChunk
					if (chunk.done) {
						// Final chunk: yield usage (if present) then done.
						if (chunk.prompt_eval_count !== undefined || chunk.eval_count !== undefined) {
							yield {
								type: "usage",
								inputTokens: chunk.prompt_eval_count ?? 0,
								outputTokens: chunk.eval_count ?? 0,
							}
						}
						yield {
							type: "done",
							stopReason: this.mapDoneReason(chunk.done_reason, hadToolCalls),
						}
						return
					}
					// Content delta.
					if (chunk.message?.content) {
						yield { type: "delta", text: chunk.message.content }
					}
					// Tool calls.
					if (chunk.message?.tool_calls) {
						for (const call of chunk.message.tool_calls) {
							hadToolCalls = true
							// Ollama's tool_calls entries do not carry a
							// stable `id` field in all server versions —
							// generate one via crypto.randomUUID() when
							// the server doesn't supply one.
							const toolCallId = call.id ?? crypto.randomUUID()
							yield {
								type: "tool-call",
								toolCallId,
								name: call.function.name,
								input: call.function.arguments,
							}
						}
					}
					// Look for the next newline in the remaining buffer.
					newlineIndex = buffer.indexOf("\n")
				}
			}
			// Stream ended without a done chunk — defensive fallback.
			yield { type: "done", stopReason: "stop" }
		} finally {
			reader.releaseLock()
		}
	}

	/**
	 * Generate embeddings via `POST {baseUrl}/api/embed`.
	 *
	 * Only call this for models whose `capabilities(model).embeddings` is
	 * `true`; calling it for a non-embedding model still forwards the
	 * request as-is (Ollama itself will error) — gatekeeping which models
	 * are "allowed" to embed is a host/kernel-level concern, not this
	 * driver's job to enforce.
	 *
	 * Embedding calls have no "output tokens" concept, so `outputTokens`
	 * is hardcoded to `0` when usage is reported (the shared `Usage` type
	 * requires both fields).
	 */
	async embed(request: {
		model: string
		input: string[]
		signal?: AbortSignal
	}): Promise<{ embeddings: number[][]; usage?: Usage }> {
		try {
			const response = await this.fetch(`${this.baseUrl}/api/embed`, {
				method: "POST",
				headers: { "Content-Type": "application/json", ...this.headers },
				body: JSON.stringify({ model: request.model, input: request.input }),
				signal: request.signal,
			})
			if (!response.ok) {
				throw await this.httpError(response)
			}
			const data = (await response.json()) as EmbedResponse
			return {
				embeddings: data.embeddings,
				usage:
					data.prompt_eval_count !== undefined
						? {
								inputTokens: data.prompt_eval_count,
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
	 * Build and dispatch an `'error'` lifecycle event for a failed
	 * `listModels()` or `embed()` call. The original error is NOT
	 * swallowed — callers re-throw it after this helper runs, so retry
	 * and kernel error-routing behavior is unchanged.
	 */
	private emitError(phase: "listModels" | "embed", error: unknown): void {
		this.dispatchEvent(
			new CustomEvent<OllamaEventMap["error"]>("error", {
				detail: { error, phase },
			}),
		)
	}

	/**
	 * Map Ollama's `done_reason` to BHZAI's `stopReason`.
	 * - `'stop'` → `'stop'`
	 * - `'length'` → `'length'`
	 * - `'load'` or absent-but-had-tool-calls → `'tool-calls'`
	 * - absent (no tool calls) → `'stop'`
	 */
	private mapDoneReason(
		doneReason: string | undefined,
		hadToolCalls: boolean,
	): "stop" | "tool-calls" | "length" {
		if (doneReason === "length") return "length"
		if (doneReason === "load" || (hadToolCalls && !doneReason)) {
			return "tool-calls"
		}
		return "stop"
	}

	/**
	 * Fetch and cache capabilities for a model via `GET /api/show`.
	 * Called eagerly by `listModels()` and `chat()` so the synchronous
	 * `capabilities()` method has data to read.
	 */
	private async refreshCapabilitiesCache(model: string): Promise<void> {
		if (this.capabilitiesCache.has(model)) return
		try {
			const response = await this.fetch(`${this.baseUrl}/api/show`, {
				method: "POST",
				headers: { "Content-Type": "application/json", ...this.headers },
				body: JSON.stringify({ model }),
			})
			if (!response.ok) return
			const data = (await response.json()) as ShowResponse
			this.capabilitiesCache.set(model, this.parseShowResponse(data))
		} catch {
			// Network or parse error — leave cache unpopulated; the
			// synchronous `capabilities()` method will return conservative
			// defaults. This is the "conservative defaults on missing
			// fields" behavior per § 10.3.
		}
	}

	/**
	 * Parse an `/api/show` response into `DriverCapabilities` using the
	 * field-name assumptions documented on `capabilities()`.
	 */
	private parseShowResponse(data: ShowResponse): DriverCapabilities {
		const caps = data.capabilities ?? []
		// Find the first numeric `*.context_length` field in model_info.
		let contextWindow: number | undefined
		if (data.model_info) {
			for (const [key, value] of Object.entries(data.model_info)) {
				if (key.endsWith(".context_length") && typeof value === "number") {
					contextWindow = value
					break
				}
			}
		}
		return {
			streaming: true,
			toolCalls: caps.includes("tools"),
			reasoning: caps.includes("thinking"),
			embeddings: caps.includes("embedding"),
			contextWindow,
		}
	}

	/**
	 * Build a `{ status, body }`-shaped error from a non-2xx response, so
	 * TASK_0018's retry classifier can inspect `.status`. The body is
	 * parsed as JSON if possible, otherwise returned as raw text.
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
	 * `fetchOverride` option (not part of the public `OllamaOptions` type
	 * to keep the public API clean). When no override is supplied, the
	 * global `fetch` is used.
	 */
	private declare readonly fetchFn: typeof fetch
	private fetch(input: string, init?: RequestInit): Promise<Response> {
		return this.fetchFn(input, init)
	}
}

/**
 * Internal constructor options (extends the public `OllamaOptions` with a
 * test-injection seam for `fetch`). The `fetchOverride` field is not part
 * of the public API — it exists so tests can inject a fake `fetch` without
 * monkey-patching the global.
 */
export interface OllamaInternalOptions extends OllamaOptions {
	/** @internal Test-only override for the global `fetch`. */
	fetchOverride?: typeof fetch
}
