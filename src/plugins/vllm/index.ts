// vLLM driver plugin — talks to a self-hosted vLLM OpenAI-compatible server
// over plain `fetch`, using its `/v1/*` REST API. Implements `BHZAIDriver`
// (from `src/types/driver.ts`) with no environment-specific bindings, so it runs
// in any runtime that has `fetch` (browser, Node, Electron).
//
// Scope of THIS file: the `VLLM` class implementing `BHZAIDriver` in full —
// `chat()` (via `POST /v1/chat/completions`, SSE streaming), `listModels()`
// (via `GET /v1/models`), `capabilities()` (cached, declaration-first — see
// below), and `embed()` (via `POST /v1/embeddings`). No new dependency is added:
// vLLM speaks plain HTTP + JSON, so the whole driver is a few `fetch` calls.
//
// WHY A DEDICATED DRIVER AND NOT `OpenAIOptions.baseUrl`: the bundled `OpenAI`
// driver can be pointed at a vLLM server and will mostly work, but three things
// make a first-class driver worth its weight:
//
//  1. `driver.id`. `bh.addDriver()` shadows by id, so an `OpenAI` instance aimed
//     at vLLM and one aimed at api.openai.com cannot both be live — the second
//     replaces the first in the catalogue. `id === 'vllm'` lets a host run both.
//  2. **vLLM declares its context window.** `GET /v1/models` carries
//     `max_model_len` per entry, which is a REAL declaration rather than the
//     OpenAI driver's id-prefix family-table guess. This matters beyond display:
//     auto-compaction is disabled for models reporting no `contextWindow`.
//  3. **Reasoning arrives on a differently-named field.** Current vLLM streams
//     thinking text as `delta.reasoning`; the OpenAI driver only reads
//     `delta.reasoning_content`, so reasoning output would be dropped entirely.
//     This driver reads BOTH (see {@link VLLM.chat}).
//
// WHY `/v1/models` IS THE RIGHT ENDPOINT: unlike LM Studio (which exposes a
// metadata-rich native `/api/v0` alongside its OpenAI-compatible surface), vLLM
// publishes exactly ONE catalogue endpoint. It is not metadata-poor, though —
// vLLM extends the standard model object with `max_model_len`, `root` and
// `parent` (the last two express LoRA-adapter lineage), all of which this driver
// reads. There is nothing richer to prefer.
//
// ENVIRONMENT BOUNDARY (§ 5): web-standard APIs only. This file touches only
// `fetch`, `AbortSignal`, `ReadableStream` (via `response.body`), `TextDecoder`,
// `crypto.randomUUID` (for fallback tool-call ids), and async iterables. No Node
// built-ins, no DOM.
//
// CREDENTIAL-RESOLUTION NOTE (§ 10.4): `VLLMOptions.headers`, when supplied, are
// the "runtime values passed in driver options" that § 10.4 documents as the
// highest-priority tier of the credential-resolution chain. This driver simply
// accepts and forwards them on every `fetch` call — it does NOT implement the
// resolution chain, and it NEVER reads environment variables or files. A vLLM
// server started without `--api-key` accepts every request unauthenticated, so
// `headers` defaults to `{}`; one started WITH it expects
// `{ Authorization: 'Bearer <key>' }`.
//
// BROWSER NOTE: vLLM serves no CORS headers by default. A browser host must
// start the server with `--allowed-origins`, e.g.
// `vllm serve <model> --allowed-origins '["http://localhost:5173"]'`, or the
// page's requests fail with an opaque `TypeError: Failed to fetch` even though
// `curl` against the same address succeeds. See the plugin README.

import type {
	BHZAIDriver,
	BHZAIMessage,
	ChatRequest,
	DriverCapabilities,
	DriverEvent,
	ModelInfo,
	ToolCallRecord,
	Usage,
} from "../../types/index.js"

/**
 * Host-supplied constructor options for {@link VLLM}.
 */
export interface VLLMOptions {
	/**
	 * Base URL of the vLLM server ROOT — the driver appends `/v1/…` itself.
	 * Defaults to `'http://localhost:8000'`, the address `vllm serve` binds by
	 * default.
	 */
	baseUrl?: string
	/**
	 * Custom headers forwarded on every `fetch` call. Defaults to `{}`. A server
	 * started with `--api-key` expects `{ Authorization: 'Bearer <key>' }`. These
	 * are the "runtime values passed in driver options" that § 10.4 documents as
	 * the highest-priority tier of the credential-resolution chain — the host
	 * supplies them; this driver does not resolve credentials itself.
	 */
	headers?: Record<string, string>
	/**
	 * Force the `toolCalls` capability for every model, overriding the default
	 * described on {@link VLLM.capabilities}.
	 *
	 * WHY THIS EXISTS: vLLM only serves tool calls when the server was launched
	 * with `--enable-auto-tool-choice --tool-call-parser <parser>`, and NOTHING
	 * on the wire reports whether it was. The driver therefore has to guess, and
	 * either guess is wrong for somebody. Set this to `false` when pointing at a
	 * server without those flags, so tools are stripped locally instead of
	 * producing a 400 from the server.
	 */
	toolCalls?: boolean
	/**
	 * Force the `reasoning` capability for every model. Defaults to `false`.
	 *
	 * WHY THIS EXISTS: vLLM emits separated reasoning only when launched with
	 * `--reasoning-parser <parser>`, which — like the tool-call parser — is
	 * invisible on the wire. Set this to `true` when pointing at a server started
	 * with one, so hosts that gate a thinking-level control on the capability
	 * flag will offer it.
	 */
	reasoning?: boolean
}

/**
 * One entry of vLLM's `GET /v1/models` response (partial — only the fields this
 * driver reads).
 */
interface VLLMModelEntry {
	id: string
	object?: string
	/** Unix seconds. Surfaced under `meta.created`. */
	created?: number
	/** Serving organization — `'vllm'` on a stock server. Surfaced under `meta.ownedBy`. */
	owned_by?: string
	/**
	 * Maximum sequence length in tokens, as resolved by the server at startup
	 * (`--max-model-len` or the model config's own limit). vLLM's extension to
	 * the standard model object, and the reason `contextWindow` is a real
	 * declaration here rather than a guess.
	 */
	max_model_len?: number
	/**
	 * The underlying artifact this entry serves — a HuggingFace repo id or a
	 * local path. For a LoRA adapter it is the adapter's own location, which
	 * differs from `id`. Surfaced under `meta.root`.
	 */
	root?: string
	/**
	 * The base model a LoRA adapter was loaded against, or `null` for a base
	 * model. Surfaced under `meta.parent`, and used to inherit the base model's
	 * context window (see {@link VLLM.parseModelEntry}).
	 */
	parent?: string | null
}

/**
 * vLLM `GET /v1/models` response shape (partial).
 */
interface ModelsResponse {
	object?: string
	data: VLLMModelEntry[]
}

/**
 * One `chat.completion.chunk` from `POST /v1/chat/completions` (partial — only
 * the fields this driver reads).
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
			/**
			 * Separated thinking text on CURRENT vLLM builds serving a model with
			 * `--reasoning-parser`. This is the field the stable docs document.
			 */
			reasoning?: string
			/**
			 * The same channel's name on OLDER vLLM builds (and on several
			 * downstream forks that track the older field). Read as a fallback so
			 * reasoning is not silently dropped against those servers — see
			 * {@link VLLM.chat}.
			 */
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
 * vLLM `POST /v1/embeddings` response shape (partial).
 */
interface EmbedResponse {
	data: Array<{ embedding: number[]; index?: number }>
	usage?: { prompt_tokens?: number; total_tokens?: number }
}

/**
 * A tool call being assembled across streaming chunks. vLLM streams the id and
 * function name on the opening fragment for a given `index`, then the JSON
 * arguments a few characters at a time — so the driver accumulates and emits a
 * single `tool-call` event per index once the stream ends.
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
 * One message in the `POST /v1/chat/completions` request body.
 *
 * `tool_calls` and `tool_call_id` are what make a multi-iteration tool loop
 * render correctly through vLLM's chat templates — see {@link VLLM.mapMessages}.
 */
interface WireMessage {
	role: "system" | "user" | "assistant" | "tool"
	content?: string
	tool_call_id?: string
	tool_calls?: Array<{
		id: string
		type: "function"
		function: { name: string; arguments: string }
	}>
}

/**
 * The modality buckets {@link VLLM.listModels} reports under `meta.type`.
 *
 * A vLLM server serves one task at a time, so in practice a catalogue is all
 * chat models or all embedding models — but the wire does not say which, so the
 * bucket is inferred from the model id (see {@link classifyModel}). Hosts filter
 * their pickers on it; `example/src/lib/models.ts` keeps only `'chat'`.
 */
export type VLLMModelType = "chat" | "embeddings"

/**
 * Substring markers that identify an embedding model by id.
 *
 * WHY INFERENCE AT ALL: `GET /v1/models` reports the served model's id and
 * length but never its task, so an embedding deployment is indistinguishable
 * from a chat one on the wire. These markers cover the families actually served
 * for embeddings — the `embed`/`embedding` naming convention plus the four
 * dominant open embedding families (BGE, GTE, E5, Nomic Embed).
 *
 * Unknown ids fall through to `'chat'` on purpose: a chat model wrongly hidden
 * from a picker is a worse failure than an embedding model wrongly offered,
 * which errors visibly on first use.
 */
const EMBEDDING_MARKERS = ["embed", "bge-", "gte-", "e5-", "-e5", "nomic-embed"]

/**
 * Classify a model id into a modality bucket.
 *
 * Matched against the id lowercased, and also against the segment after the last
 * `/`, because vLLM ids are normally full HuggingFace repo paths
 * (`BAAI/bge-large-en-v1.5`) where the meaningful part follows the slash.
 *
 * @param id - The model id from the catalogue
 * @returns The inferred modality bucket
 */
function classifyModel(id: string): VLLMModelType {
	const lower = id.toLowerCase()
	const slash = lower.lastIndexOf("/")
	const keys = slash >= 0 ? [lower, lower.slice(slash + 1)] : [lower]
	return EMBEDDING_MARKERS.some((marker) => keys.some((key) => key.includes(marker)))
		? "embeddings"
		: "chat"
}

/**
 * Read the tool calls an assistant message recorded under `meta.toolCalls`.
 *
 * The agent loop writes `ToolCallRecord[]` there for every turn that produced
 * tool calls (`src/conversation/agent-loop.ts`), and it survives the snapshot
 * round-trip. Defensive about the shape because `meta` is an open
 * `Record<string, unknown>` that hosts and plugins also write to, and a restored
 * snapshot could predate the record.
 *
 * @param message - The message to read
 * @returns The recorded calls, or an empty array when there are none
 */
function readToolCallRecords(message: BHZAIMessage): ToolCallRecord[] {
	if (message.role !== "assistant") return []
	const recorded = message.meta?.toolCalls
	if (!Array.isArray(recorded)) return []
	return recorded.filter(
		(call): call is ToolCallRecord =>
			typeof call === "object" &&
			call !== null &&
			typeof (call as ToolCallRecord).id === "string" &&
			typeof (call as ToolCallRecord).name === "string",
	)
}

/**
 * How many streamed tool calls {@link VLLM} remembers for argument recovery.
 * A tool result is answered on the very next loop iteration, so a small window
 * is enough; the cap only exists to bound memory on a long conversation.
 */
const TOOL_CALL_MEMORY = 256

/**
 * Connection lifecycle event map for {@link VLLM}.
 *
 * - `'connect'` — dispatched at the end of a successful `listModels()`, carrying
 *   the resolved `ModelInfo[]`.
 * - `'disconnect'` — dispatched by `disconnect()`; a host-intent signal (the
 *   stateless transport has no real connection to close).
 * - `'error'` — dispatched when `listModels()` or `embed()` fails, carrying the
 *   thrown error and the phase that failed. The original error is always
 *   re-thrown, so retry/kernel error routing is unchanged.
 */
export interface VLLMEventMap {
	/** Resolved model list from a successful `listModels()`. */
	connect: { models: ModelInfo[] }
	/** No payload — `disconnect()` is a stateless host-intent signal. */
	// biome-ignore lint/suspicious/noConfusingVoidType: event-map value type, not a return type
	disconnect: void
	/** The thrown error and the method that failed. */
	error: { error: unknown; phase: "listModels" | "embed" }
}

/**
 * Declaration-merged typed `addEventListener` overloads for {@link VLLM}, so
 * consumers get typed listeners for the connection lifecycle events. The
 * inherited base `EventTarget.addEventListener` overloads remain available for
 * arbitrary event types.
 */
export interface VLLM {
	/**
	 * Typed `'connect'` listener — receives the resolved model list.
	 */
	addEventListener(
		type: "connect",
		listener: (e: CustomEvent<VLLMEventMap["connect"]>) => void,
	): void
	/**
	 * Typed `'disconnect'` listener — no payload (stateless host-intent).
	 */
	addEventListener(type: "disconnect", listener: (e: Event) => void): void
	/**
	 * Typed `'error'` listener — receives the thrown error and failed phase.
	 */
	addEventListener(type: "error", listener: (e: CustomEvent<VLLMEventMap["error"]>) => void): void
}

/**
 * `VLLM` — a {@link BHZAIDriver} that talks to a self-hosted vLLM server over
 * plain `fetch`. Works in any fetch-capable runtime (browser, Node, Electron).
 *
 * Shares the LM Studio and OpenAI drivers' posture (§ 10.3): no peer dependency,
 * no engine injection, web-standard APIs only, OpenAI-shaped JSON over
 * Server-Sent Events. What is specific to vLLM:
 *
 * 1. **The context window is declared, not guessed** — `max_model_len` comes
 *    straight off `/v1/models`, so no family table is needed.
 * 2. **Reasoning arrives as `delta.reasoning`** (older builds:
 *    `delta.reasoning_content`); both are read.
 * 3. **Tool and reasoning support are server-launch flags**, invisible on the
 *    wire, so both are overridable via {@link VLLMOptions}.
 * 4. **Thinking is a chat-template kwarg**, not a `reasoning_effort` enum — see
 *    {@link VLLM.chat}.
 *
 * Extends `EventTarget` to expose connection lifecycle events (`'connect'`,
 * `'disconnect'`, `'error'`) so hosts can observe connect/disconnect/
 * connection-fail without coupling to driver internals.
 */
// biome-ignore lint/suspicious/noUnsafeDeclarationMerging: intentional typed-event overloads via merged interface; adds only method overloads, no uninitialized fields
export class VLLM extends EventTarget implements BHZAIDriver {
	readonly id = "vllm" as const
	private declare readonly baseUrl: string
	private declare readonly headers: Record<string, string>
	private declare readonly toolCallsOverride: boolean | undefined
	private declare readonly reasoningOverride: boolean | undefined

	/**
	 * Cache of per-model capabilities, populated by `listModels()` and by
	 * `chat()` (which calls `refreshCapabilitiesCache` for the model it is about
	 * to use). The synchronous `capabilities(model)` method reads from this
	 * cache, falling back to conservative defaults when no entry exists yet.
	 *
	 * SYNC/ASYNC MISMATCH RESOLUTION (same posture as the LM Studio and OpenAI
	 * drivers): `BHZAIDriver.capabilities(model)` is synchronous, but the data
	 * source (`GET /v1/models`) is asynchronous. This cache-then-read pattern
	 * resolves that tension. When `capabilities()` is called for a model no prior
	 * `listModels()`/`chat()` has populated, it returns conservative defaults
	 * (all booleans `false`, `contextWindow` `undefined`) rather than throwing.
	 */
	private readonly capabilitiesCache: Map<string, DriverCapabilities> = new Map()

	/**
	 * Tool calls this driver has streamed, keyed by tool-call id, so a later
	 * iteration of the same agent loop can rebuild the assistant `tool_calls`
	 * entry vLLM's tool chat templates expect (see {@link VLLM.mapMessages}).
	 *
	 * Bounded to {@link TOOL_CALL_MEMORY} entries, evicting oldest-first: a long
	 * conversation would otherwise grow this map without limit, and only recent
	 * calls are ever referenced (a tool result is answered on the very next
	 * iteration).
	 */
	private readonly toolCallMemory: Map<string, { name: string; args: string }> = new Map()

	/**
	 * Whether a catalogue fetch has succeeded on this connection.
	 *
	 * Distinct from "is this model cached": a server can be asked for a model id
	 * it does not list (a LoRA adapter added after startup, say), and in that
	 * case the per-model cache stays empty however many times the catalogue is
	 * fetched. Without this flag `chat()` would re-poll `/v1/models` before every
	 * call and never succeed in filling the gap. Cleared by `disconnect()`.
	 */
	private catalogueLoaded = false

	constructor(options?: VLLMOptions) {
		super()
		this.baseUrl = options?.baseUrl ?? "http://localhost:8000"
		this.headers = options?.headers ?? {}
		this.toolCallsOverride = options?.toolCalls
		this.reasoningOverride = options?.reasoning
		// Test-injection seam: if the caller passed the internal `fetchOverride`
		// field, use it; otherwise use the global `fetch`.
		const internal = options as VLLMInternalOptions | undefined
		// `globalThis.fetch` must be bound to the global object. Storing it as a
		// property and calling it later would make `this` the VLLM instance,
		// which native fetch rejects with "Illegal invocation".
		this.fetchFn = internal?.fetchOverride ?? globalThis.fetch.bind(globalThis)
	}

	/**
	 * `GET {baseUrl}/v1/models` — lists every model this server is serving
	 * (its base model plus any LoRA adapters loaded alongside it), and caches
	 * each one's capabilities on the way through (no second request needed).
	 *
	 * AVAILABILITY MAPPING: every returned entry is `'ready'`. vLLM loads its
	 * model into GPU memory at startup and only starts serving once that
	 * finishes, so anything the catalogue lists is usable immediately — there is
	 * nothing to download and no warm-up state to report.
	 *
	 * LoRA LINEAGE: an adapter entry carries `parent` (the base model it was
	 * loaded against) and `root` (its own artifact location); both are surfaced
	 * under `meta` so a host can group or label them.
	 */
	async listModels(): Promise<ModelInfo[]> {
		try {
			const entries = await this.fetchModelEntries()
			const models: ModelInfo[] = entries.map((entry) => ({
				ref: `vllm/${entry.id}`,
				driver: "vllm",
				id: entry.id,
				label: entry.id,
				capabilities: this.capabilities(entry.id),
				availability: "ready" as const,
				meta: {
					type: classifyModel(entry.id),
					ownedBy: entry.owned_by,
					created: entry.created,
					root: entry.root,
					parent: entry.parent,
					maxModelLen: entry.max_model_len,
				},
			}))
			this.dispatchEvent(
				new CustomEvent<VLLMEventMap["connect"]>("connect", {
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
	 * Per-model capability flags. **Synchronous** — reads from the internal cache
	 * populated by `listModels()`/`chat()`. Returns conservative defaults (all
	 * booleans `false`, `contextWindow` `undefined`) when the cache has no entry
	 * for the model yet.
	 *
	 * Mapping from a `/v1/models` entry:
	 *
	 * - `streaming`: always `true` — `/v1/chat/completions` streams.
	 * - `toolCalls`: `VLLMOptions.toolCalls` when the host set it; otherwise
	 *   `true` for non-embedding models (see the deviation note below).
	 * - `reasoning`: `VLLMOptions.reasoning` when the host set it; otherwise
	 *   `false`.
	 * - `embeddings`: `true` when the id looks like an embedding model
	 *   ({@link EMBEDDING_MARKERS}).
	 * - `contextWindow`: `max_model_len`, verbatim — a real server-side
	 *   declaration, not a guess. A LoRA adapter that omits it inherits its
	 *   `parent`'s value (see {@link VLLM.parseModelEntry}).
	 *
	 * EXPLICIT DEVIATION from the conservative default, matching the LM Studio
	 * and OpenAI drivers' precedent: `toolCalls` defaults to `true` for
	 * non-embedding models. vLLM only serves tool calls when launched with
	 * `--enable-auto-tool-choice --tool-call-parser <parser>`, and nothing on the
	 * wire says whether it was, so this is a guess either way. Defaulting to
	 * `false` would silently strip every tool from every request against a
	 * correctly-configured server — a silent, hard-to-diagnose failure.
	 * Defaulting to `true` against a server WITHOUT those flags produces a loud
	 * 400 naming the missing flag, which is actionable. Hosts that know they are
	 * pointing at a tool-less server set `VLLMOptions.toolCalls: false`.
	 *
	 * Models the cache has never seen at all still get `toolCalls: false`; that
	 * is an absence of data, not an inference.
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
	 * Host-intent disconnect signal. The vLLM transport is stateless (plain
	 * `fetch` over HTTP — there is no persistent connection to close), so this
	 * method performs no network I/O. It clears the `capabilitiesCache`, the
	 * tool-call memory and the catalogue-loaded flag (a disconnected provider's
	 * cached state is stale) and dispatches a `'disconnect'` event so hosts can
	 * react to the lifecycle transition.
	 */
	disconnect(): void {
		this.capabilitiesCache.clear()
		this.toolCallMemory.clear()
		this.catalogueLoaded = false
		this.dispatchEvent(new Event("disconnect"))
	}

	/**
	 * One LLM call via `POST {baseUrl}/v1/chat/completions` with SSE streaming.
	 *
	 * REASONING IS A TEMPLATE KWARG, NOT AN EFFORT ENUM. vLLM has no
	 * `reasoning_effort` parameter; a thinking model is toggled through its chat
	 * template, so BHZAI's six-level `params.reasoning` scale collapses onto a
	 * boolean the way Ollama's `think` does — `'off'` is `false`, every other
	 * level is `true`. Both spellings in circulation are sent
	 * (`enable_thinking` for the Qwen3 family, `thinking` for Granite); a Jinja
	 * template that does not use a kwarg simply ignores it.
	 *
	 * The kwargs are sent only when the host explicitly set `params.reasoning` —
	 * NOT gated on `capabilities().reasoning`, which is `false` by default
	 * precisely because the server's `--reasoning-parser` flag is invisible on
	 * the wire. Gating on it would make the control dead against every default
	 * configuration.
	 *
	 * Error handling: non-2xx responses throw an error object shaped
	 * `{ status, body }` so the retry classifier can inspect `.status`.
	 * Network-level `fetch` failures (thrown `TypeError`) propagate uncaught.
	 */
	async *chat(request: ChatRequest): AsyncIterable<DriverEvent> {
		// Ensure capabilities are cached for this model (for tool-call gating).
		await this.refreshCapabilitiesCache(request.model)
		const caps = this.capabilities(request.model)

		// Step 1: map BHZAIMessage[] onto the wire shape, rebuilding the assistant
		// `tool_calls` records vLLM's tool chat templates expect.
		const messages = this.mapMessages(request.messages)
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

		// Step 3: assemble the request body. `stream_options.include_usage` asks
		// for a final usage-only chunk; builds that don't understand the option
		// simply omit it and the `usage` event is skipped.
		const body: Record<string, unknown> = {
			model: request.model,
			messages,
			stream: true,
			stream_options: { include_usage: true },
		}
		if (tools) body.tools = tools
		if (request.params?.temperature !== undefined) body.temperature = request.params.temperature
		// `max_tokens`, NOT `max_completion_tokens`: vLLM accepts both on current
		// builds but only `max_tokens` on older ones, and it is the field its own
		// docs use throughout. There is no reasoning-model exception here the way
		// there is on api.openai.com.
		if (request.params?.maxTokens !== undefined) body.max_tokens = request.params.maxTokens
		if (request.params?.stop) body.stop = request.params.stop
		if (request.params?.reasoning) {
			const thinking = request.params.reasoning !== "off"
			body.chat_template_kwargs = { enable_thinking: thinking, thinking }
		}

		// Step 4: POST and check status.
		const response = await this.fetch(`${this.baseUrl}/v1/chat/completions`, {
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

		// Step 5: read the SSE stream. Tool calls are assembled across chunks and
		// emitted once at the end; usage and the terminal `done` follow.
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
					// Separated reasoning text. Current vLLM names this field
					// `reasoning`; older builds and several forks name it
					// `reasoning_content`. Read whichever is present so thinking
					// output is never silently dropped. Inline `<think>`-tag
					// reasoning (a server with NO `--reasoning-parser`) stays in
					// `content` and is the conversation layer's `parseThink` job.
					const reasoning = delta?.reasoning ?? delta?.reasoning_content
					if (reasoning) {
						yield { type: "reasoning-delta", text: reasoning }
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
					// A usage-bearing chunk arrives last and carries an empty
					// `choices` array; the last one seen wins.
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

		// Step 6: terminal events, in the order the agent loop expects — tool
		// calls, then usage, then done.
		for (const index of Array.from(pending.keys()).sort((a, b) => a - b)) {
			const call = pending.get(index)
			if (!call) continue
			this.rememberToolCall(call)
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
	 * Generate embeddings via `POST {baseUrl}/v1/embeddings`.
	 *
	 * Only meaningful against a server started for an embedding task
	 * (`vllm serve <model> --task embed`); a chat deployment rejects the call.
	 * Calling it for a non-embedding model still forwards the request as-is —
	 * gatekeeping which models are "allowed" to embed is a host/kernel-level
	 * concern, not this driver's job to enforce.
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
			const response = await this.fetch(`${this.baseUrl}/v1/embeddings`, {
				method: "POST",
				headers: { "Content-Type": "application/json", ...this.headers },
				body: JSON.stringify({ model: request.model, input: request.input }),
				signal: request.signal,
			})
			if (!response.ok) {
				throw await this.httpError(response)
			}
			const data = (await response.json()) as EmbedResponse
			// The response carries an explicit `index` per row; sort by it rather
			// than trusting arrival order, so the result lines up positionally with
			// `request.input`.
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
	 * Project `BHZAIMessage[]` onto the Chat Completions wire shape, rebuilding
	 * the assistant `tool_calls` records a tool loop needs.
	 *
	 * WHY THIS IS MORE THAN A `{ role, content }` MAP (unlike the Ollama and LM
	 * Studio drivers): vLLM renders the conversation through the model's Jinja
	 * chat template. The tool templates (`llama3_json`, `hermes`, and friends)
	 * read `message.tool_calls` off the assistant turn to render the call, and
	 * pair a `role: 'tool'` message to it by `tool_call_id`. The kernel records
	 * the id on the tool-result message's `meta.toolCallId`
	 * (`src/conversation/agent-loop.ts`) but does NOT record the calls on the
	 * assistant message that made them, so a naive mapping renders a tool result
	 * with no antecedent — the model then sees an answer to a question it never
	 * asked.
	 *
	 * The reconstruction walks each run of consecutive `tool` messages and
	 * attaches the matching `tool_calls` to the assistant message in front of it,
	 * inserting a synthetic empty assistant message when there is none.
	 *
	 * ARGUMENTS come from three sources, in descending order of authority:
	 *
	 * 1. **`meta.toolCalls` on the assistant message** ({@link ToolCallRecord}),
	 *    written by the agent loop for exactly this purpose. Complete and
	 *    snapshot-safe, so a restored conversation replays the model's real
	 *    arguments.
	 * 2. **{@link VLLM.toolCallMemory}** — calls this driver instance streamed
	 *    but that carry no record, e.g. a message a host injected by hand.
	 * 3. **`'{}'`** — last resort. The id and name are still correct, which is
	 *    what the pairing needs; only the argument text is lost.
	 *
	 * Multi-block `ContentBlock[]` content collapses to the message's `content`
	 * string, the same posture as every other bundled driver.
	 *
	 * @param messages - The conversation's context messages
	 * @returns Wire messages ready to serialize into the request body
	 */
	private mapMessages(messages: BHZAIMessage[]): WireMessage[] {
		const wire: WireMessage[] = []
		for (const message of messages) {
			if (message.role !== "tool") {
				const entry: WireMessage = { role: message.role, content: message.content }
				// An assistant message that requested tools carries them in
				// `meta.toolCalls`; that record is authoritative, so advertise it
				// verbatim rather than waiting to rebuild it from the results.
				const recorded = readToolCallRecords(message)
				if (recorded.length > 0) {
					entry.tool_calls = recorded.map((call) => ({
						id: call.id,
						type: "function" as const,
						function: { name: call.name, arguments: call.arguments || "{}" },
					}))
					// An assistant turn carrying tool calls renders from those, and
					// an empty string would add a stray blank line to the prompt.
					if (!entry.content) entry.content = undefined
				}
				wire.push(entry)
				continue
			}
			// A tool result without a recorded id cannot be paired with anything, so
			// mint one here and use it on BOTH sides of the pairing below.
			const toolCallId =
				typeof message.meta?.toolCallId === "string" && message.meta.toolCallId
					? message.meta.toolCallId
					: crypto.randomUUID()
			const name = typeof message.meta?.toolName === "string" ? message.meta.toolName : "tool"
			wire.push({ role: "tool", tool_call_id: toolCallId, content: message.content })
			this.attachToolCall(wire, toolCallId, name)
		}
		return wire
	}

	/**
	 * Ensure the assistant message preceding a `tool` message advertises the tool
	 * call it answers.
	 *
	 * Called once per tool message as {@link VLLM.mapMessages} builds the list,
	 * so the "preceding assistant" is found by scanning back over the run of tool
	 * messages already emitted. Appends to an existing assistant message's
	 * `tool_calls` (parallel calls share one assistant message) or splices in a
	 * synthetic one when the run is not preceded by an assistant message at all.
	 *
	 * @param wire - The wire list being built; mutated in place
	 * @param toolCallId - The id the tool message answers
	 * @param name - The tool's name, for the reconstructed call record
	 */
	private attachToolCall(wire: WireMessage[], toolCallId: string, name: string): void {
		// Scan back over this run of tool messages (the one just pushed included)
		// to find where the assistant message should be.
		let index = wire.length - 1
		while (index >= 0 && wire[index]?.role === "tool") index--

		const anchor = wire[index]
		// Already advertised from the assistant message's own `meta.toolCalls`
		// record — that is the authoritative source, so leave it alone.
		if (anchor?.tool_calls?.some((call) => call.id === toolCallId)) return

		const remembered = this.toolCallMemory.get(toolCallId)
		const record = {
			id: toolCallId,
			type: "function" as const,
			function: { name: remembered?.name ?? name, arguments: remembered?.args || "{}" },
		}

		if (anchor?.role === "assistant") {
			anchor.tool_calls = [...(anchor.tool_calls ?? []), record]
			// With tool calls present, empty content is dropped rather than sent as
			// "" so the template does not render a blank assistant line.
			if (anchor.content === "") anchor.content = undefined
			return
		}
		wire.splice(index + 1, 0, { role: "assistant", tool_calls: [record] })
	}

	/**
	 * Record a streamed tool call so a later iteration can rebuild its wire
	 * record with the real arguments (see {@link VLLM.mapMessages}).
	 *
	 * Evicts oldest-first past {@link TOOL_CALL_MEMORY} entries: only the most
	 * recent iteration's calls are ever looked up, so a hard cap keeps a
	 * long-running conversation from growing this map without bound.
	 *
	 * @param call - The assembled tool call being emitted
	 */
	private rememberToolCall(call: PendingToolCall): void {
		this.toolCallMemory.set(call.id, { name: call.name, args: call.args })
		while (this.toolCallMemory.size > TOOL_CALL_MEMORY) {
			const oldest = this.toolCallMemory.keys().next()
			if (oldest.done) break
			this.toolCallMemory.delete(oldest.value)
		}
	}

	/**
	 * Merge one chunk's `tool_calls` fragments into the in-flight accumulator.
	 *
	 * vLLM sends the id and function name on the first fragment for a given
	 * `index`, then the JSON arguments a few characters at a time. A missing
	 * `index` is treated as `0` — some tool-call parsers emit a single call
	 * without one.
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
				// vLLM supplies an id on the opening fragment, but not every
				// tool-call parser does — fall back to a generated one so the call
				// is still addressable.
				call = { id: fragment.id ?? crypto.randomUUID(), name: "", args: "" }
				pending.set(index, call)
			}
			if (fragment.id) call.id = fragment.id
			if (fragment.function?.name) call.name += fragment.function.name
			if (fragment.function?.arguments) call.args += fragment.function.arguments
		}
	}

	/**
	 * Build and dispatch an `'error'` lifecycle event for a failed `listModels()`
	 * or `embed()` call. The original error is NOT swallowed — callers re-throw
	 * it after this helper runs, so retry and kernel error-routing behavior is
	 * unchanged.
	 */
	private emitError(phase: "listModels" | "embed", error: unknown): void {
		this.dispatchEvent(
			new CustomEvent<VLLMEventMap["error"]>("error", {
				detail: { error, phase },
			}),
		)
	}

	/**
	 * Map vLLM's `finish_reason` to BHZAI's `stopReason`.
	 * - `'length'` → `'length'`
	 * - `'tool_calls'`, or any run that produced tool calls → `'tool-calls'`
	 * - anything else (`'stop'`, absent) → `'stop'`
	 *
	 * The `hadToolCalls` override matters because several of vLLM's tool-call
	 * parsers close a tool-calling turn with `finish_reason: 'stop'` (the parser
	 * extracts the call from text the model ended normally); treating that as a
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
	 * Fetch `GET /v1/models` and cache every entry's capabilities.
	 *
	 * One catalogue request populates the cache for every model at once, so
	 * `listModels()` issues exactly one fetch.
	 *
	 * @returns The raw model entries, for `listModels()` to map
	 */
	private async fetchModelEntries(): Promise<VLLMModelEntry[]> {
		const response = await this.fetch(`${this.baseUrl}/v1/models`, {
			method: "GET",
			headers: this.headers,
		})
		if (!response.ok) {
			throw await this.httpError(response)
		}
		const data = (await response.json()) as ModelsResponse
		const entries = data.data ?? []
		for (const entry of entries) {
			this.capabilitiesCache.set(entry.id, this.parseModelEntry(entry, entries))
		}
		// Reached only on a 2xx that parsed: the catalogue is now known, even if it
		// turned out to be empty.
		this.catalogueLoaded = true
		return entries
	}

	/**
	 * Populate the capabilities cache for a model, if it isn't cached already, so
	 * the synchronous `capabilities()` method has data to read.
	 *
	 * Fetches the catalogue AT MOST ONCE per connection, tracked by
	 * {@link VLLM.catalogueLoaded} rather than by whether this particular model
	 * landed in the cache. A model absent from a catalogue that loaded fine is
	 * legitimately absent, so keying off the per-model miss would re-poll
	 * `/v1/models` before every single `chat()` call and never succeed.
	 * `listModels()` still re-fetches unconditionally, so a host that refreshes
	 * its catalogue picks up newly loaded LoRA adapters.
	 *
	 * Swallows failures on purpose: a `chat()` call must not be aborted because
	 * the catalogue lookup failed. `capabilities()` then returns conservative
	 * defaults and the chat request itself surfaces any real connectivity
	 * problem. A failed attempt does not set the flag, so the next call retries.
	 */
	private async refreshCapabilitiesCache(model: string): Promise<void> {
		if (this.capabilitiesCache.has(model) || this.catalogueLoaded) return
		try {
			await this.fetchModelEntries()
		} catch {
			// Network, auth or parse error — leave the cache unpopulated; the
			// synchronous `capabilities()` method returns conservative defaults.
		}
	}

	/**
	 * Project one `/v1/models` entry onto `DriverCapabilities` using the mapping
	 * documented on {@link VLLM.capabilities}.
	 *
	 * @param entry - The catalogue entry to project
	 * @param all - The full catalogue, so a LoRA adapter can inherit its base
	 *   model's `max_model_len` when it reports none of its own
	 */
	private parseModelEntry(entry: VLLMModelEntry, all: VLLMModelEntry[]): DriverCapabilities {
		const isEmbedding = classifyModel(entry.id) === "embeddings"
		// A LoRA adapter is served through its base model's weights and therefore
		// has that model's sequence limit, but does not always repeat it.
		const inherited = entry.parent
			? all.find((candidate) => candidate.id === entry.parent)?.max_model_len
			: undefined
		return {
			streaming: true,
			toolCalls: this.toolCallsOverride ?? !isEmbedding,
			reasoning: this.reasoningOverride ?? false,
			embeddings: isEmbedding,
			contextWindow: typeof entry.max_model_len === "number" ? entry.max_model_len : inherited,
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
	 * TEST INJECTION: tests override this via the constructor's `fetchOverride`
	 * option (not part of the public `VLLMOptions` type to keep the public API
	 * clean). When no override is supplied, the global `fetch` is used.
	 */
	private declare readonly fetchFn: typeof fetch
	private fetch(input: string, init?: RequestInit): Promise<Response> {
		return this.fetchFn(input, init)
	}
}

/**
 * Internal constructor options (extends the public `VLLMOptions` with a
 * test-injection seam for `fetch`). The `fetchOverride` field is not part of the
 * public API — it exists so tests can inject a fake `fetch` without
 * monkey-patching the global.
 */
export interface VLLMInternalOptions extends VLLMOptions {
	/** @internal Test-only override for the global `fetch`. */
	fetchOverride?: typeof fetch
}
