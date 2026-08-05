// OpenAI driver plugin — talks to the OpenAI platform (or any OpenAI-compatible
// gateway) over plain `fetch`, using the public `/v1/*` REST API. Implements
// `BHZAIDriver` (from `src/types/driver.ts`) with no environment-specific
// bindings, so it runs in any runtime that has `fetch` (browser, Node,
// Electron).
//
// Scope of THIS file: the `OpenAI` class implementing `BHZAIDriver` in full —
// `chat()` (via `POST /v1/chat/completions`, SSE streaming), `listModels()`
// (via `GET /v1/models`), `capabilities()` (cached, inferred — see below), and
// `embed()` (via `POST /v1/embeddings`). No new dependency is added: the
// official `openai` SDK is deliberately NOT used, because it is a heavy
// dependency that would have to be a peer dep and injected, and the two
// endpoints this driver needs are a plain `fetch` away.
//
// WHY `/v1/models` EVEN THOUGH IT IS METADATA-POOR: unlike LM Studio (which
// exposes a metadata-rich native `/api/v0/models` next to its OpenAI-compatible
// `/v1`), OpenAI publishes exactly ONE catalogue endpoint, and a model object
// there carries only `{ id, object, created, owned_by }` — no modality, no
// context length, no capability list. There is nothing richer to prefer. The
// consequence is that against api.openai.com itself `capabilities()` cannot read
// declarations off the wire the way the LM Studio driver does; it INFERS them
// from the model id's family (see {@link OpenAI.capabilities}) and lets the host
// override `contextWindow` via `OpenAIOptions.contextWindows`. OpenAI-compatible
// GATEWAYS do commonly enrich the same endpoint (`context_length`,
// `supported_parameters`), and those declarations are preferred when present —
// verified against a live OpenRouter catalogue, where all 337 models report a
// context length that would otherwise have been lost.
//
// ENVIRONMENT BOUNDARY (§ 5): web-standard APIs only. This file touches only
// `fetch`, `AbortSignal`, `ReadableStream` (via `response.body`), `TextDecoder`,
// `crypto.randomUUID` (for fallback tool-call ids), and async iterables. No Node
// built-ins, no DOM.
//
// CREDENTIAL-RESOLUTION NOTE (§ 10.4): `OpenAIOptions.headers`, when supplied,
// are the "runtime values passed in driver options" that § 10.4 documents as the
// highest-priority tier of the credential-resolution chain. This driver simply
// accepts and forwards them on every `fetch` call — it does NOT implement the
// resolution chain, and it NEVER reads `process.env.OPENAI_API_KEY` or any file.
// Unlike the local-server drivers, api.openai.com rejects every unauthenticated
// request, so a host that omits `headers` will see 401s: supplying
// `{ Authorization: 'Bearer <key>' }` is effectively mandatory in production.
//
// BROWSER WARNING: sending an OpenAI API key from a browser page exposes it to
// anyone using that page. This driver runs in a browser because the kernel is
// environment-agnostic, not because doing so is a good idea — point `baseUrl` at
// a server-side proxy that injects the key instead. See the plugin README.

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
 * Host-supplied constructor options for {@link OpenAI}.
 */
export interface OpenAIOptions {
	/**
	 * Base URL of the API ROOT — the driver appends `/v1/…` itself. Defaults to
	 * `'https://api.openai.com'`. Point it at a proxy (or an OpenAI-compatible
	 * gateway such as OpenRouter, Together or a self-hosted vLLM) to use the
	 * same driver against a different host.
	 */
	baseUrl?: string
	/**
	 * Custom headers forwarded on every `fetch` call. Defaults to `{}`. This is
	 * where the API key goes (`{ Authorization: 'Bearer sk-…' }`), alongside the
	 * optional `OpenAI-Organization` / `OpenAI-Project` headers. These are the
	 * "runtime values passed in driver options" that § 10.4 documents as the
	 * highest-priority tier of the credential-resolution chain — the host
	 * supplies them; this driver does not resolve credentials itself.
	 */
	headers?: Record<string, string>
	/**
	 * Per-model context-window overrides, keyed by bare model id
	 * (`'gpt-4o-mini'`, not `'openai/gpt-4o-mini'`).
	 *
	 * `GET /v1/models` does not report context windows, so the driver falls back
	 * to a built-in family table (see {@link FAMILY_CONTEXT_WINDOWS}). Supply
	 * this map to correct or extend that table — an exact id match always wins.
	 * Relevant beyond display: auto-compaction is disabled for models that report
	 * no `contextWindow` at all.
	 */
	contextWindows?: Record<string, number>
}

/**
 * One entry of OpenAI's `GET /v1/models` response. This is the entire documented
 * model object — there is no further metadata to read.
 */
interface OpenAIModelEntry {
	id: string
	object?: string
	/** Unix seconds. Surfaced under `meta.created`. */
	created?: number
	/** Owning organization, e.g. `'openai'` or `'system'`. Surfaced under `meta.ownedBy`. */
	owned_by?: string
	/**
	 * Context window in tokens. NOT part of OpenAI's own model object, but most
	 * OpenAI-compatible gateways add it (OpenRouter reports it for every model,
	 * as do LiteLLM and vLLM). Read when present — a real declaration always
	 * beats the family-table guess.
	 */
	context_length?: number
	/** OpenRouter's per-provider block, which repeats the context length. */
	top_provider?: { context_length?: number }
	/**
	 * Request parameters this model accepts, e.g. `'tools'`, `'reasoning'`.
	 * Another gateway extension (OpenRouter declares it for all but a handful of
	 * models). When present it is authoritative for `toolCalls`/`reasoning`,
	 * exactly as LM Studio's `capabilities` array is for that driver.
	 */
	supported_parameters?: string[]
}

/**
 * OpenAI `GET /v1/models` response shape (partial).
 */
interface ModelsResponse {
	object?: string
	data: OpenAIModelEntry[]
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
			 * Set when the model declines to answer. Surfaced as ordinary `delta`
			 * text so the turn is not silently empty.
			 */
			refusal?: string
			/**
			 * Not emitted by api.openai.com's Chat Completions surface (reasoning
			 * summaries live in the Responses API), but OpenAI-compatible gateways
			 * that front reasoning models do emit it. Read for their benefit.
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
 * OpenAI `POST /v1/embeddings` response shape (partial).
 */
interface EmbedResponse {
	data: Array<{ embedding: number[]; index?: number }>
	usage?: { prompt_tokens?: number; total_tokens?: number }
}

/**
 * A tool call being assembled across streaming chunks. OpenAI streams the id and
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
 * legal on this API — see {@link OpenAI.mapMessages}.
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
 * The modality buckets {@link OpenAI.listModels} reports under `meta.type`.
 *
 * OpenAI's catalogue mixes chat models with embeddings, speech, image and
 * moderation models that a chat host cannot use. The bucket is inferred from the
 * model id (nothing on the wire declares it) so a host can filter its picker —
 * `example/src/lib/models.ts` keeps only the conversational ones.
 */
export type OpenAIModelType =
	| "chat"
	| "embeddings"
	| "audio"
	| "image"
	| "moderation"
	| "completion"

/**
 * Context windows by model-id family, longest-prefix wins.
 *
 * WHY A TABLE AT ALL: `GET /v1/models` reports no context length, and a model
 * that reports no `contextWindow` disables auto-compaction in the conversation
 * layer (`src/conversation/agent-loop.ts`) — so returning `undefined` for every
 * OpenAI model would quietly turn that feature off for the entire provider.
 *
 * WHY IT IS SAFE ENOUGH: every value errs LOW (it is the published window of the
 * family's baseline member). Under-reporting makes compaction fire early, which
 * costs a little quality; over-reporting would let a conversation grow past the
 * real limit and fail the request outright. A newer member of a family is
 * assumed to be at least as large as its baseline.
 *
 * WHY IT IS OVERRIDABLE: the catalogue changes faster than this package ships,
 * and fine-tuned or proxied ids need not follow any of these families. Hosts
 * correct it per-model with `OpenAIOptions.contextWindows`, which always wins.
 *
 * Compiled against the published model reference as of 2026-07.
 */
const FAMILY_CONTEXT_WINDOWS: Record<string, number> = {
	"gpt-3.5-turbo": 16385,
	"gpt-4": 8192,
	"gpt-4-turbo": 128000,
	"gpt-4o": 128000,
	"gpt-4.1": 1047576,
	"gpt-5": 400000,
	o1: 200000,
	o3: 200000,
	o4: 200000,
	"text-embedding": 8191,
}

/**
 * Model-id prefixes whose family supports the `reasoning_effort` parameter: the
 * `o`-series and the GPT-5 line. Matched as prefixes so dated snapshots
 * (`o3-2025-04-16`) and size variants (`gpt-5-mini`) are covered.
 */
const REASONING_PREFIXES = ["o1", "o3", "o4", "gpt-5", "codex"]

/**
 * Substring probes that classify a model id into a non-chat modality, in
 * priority order. The first match wins; anything unmatched is treated as a chat
 * model (see {@link classifyModel}).
 */
const MODALITY_PROBES: Array<{ type: OpenAIModelType; match: (id: string) => boolean }> = [
	{ type: "embeddings", match: (id) => id.includes("embedding") },
	{ type: "moderation", match: (id) => id.includes("moderation") },
	{
		type: "image",
		match: (id) => id.startsWith("dall-e") || id.startsWith("gpt-image") || id.startsWith("sora"),
	},
	{
		type: "audio",
		match: (id) =>
			id.startsWith("whisper") ||
			id.startsWith("tts-") ||
			id.includes("-tts") ||
			id.includes("-transcribe") ||
			id.includes("-realtime"),
	},
	{
		type: "completion",
		match: (id) => id.startsWith("babbage-") || id.startsWith("davinci-"),
	},
]

/**
 * Read the tool calls an assistant message recorded under `meta.toolCalls`.
 *
 * The agent loop writes `ToolCallRecord[]` there for every turn that produced
 * tool calls (`src/conversation/agent-loop.ts`), and it survives the snapshot
 * round-trip. Defensive about the shape because `meta` is an open
 * `Record<string, unknown>` that hosts and plugins also write to, and a
 * restored snapshot could predate the record.
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
 * Strip a fine-tune wrapper so family matching sees the base model.
 *
 * Fine-tuned ids look like `ft:gpt-4o-mini-2024-07-18:acme::AbC123`; the base
 * model sits between the first and second colon and determines every capability
 * the fine-tune inherits.
 *
 * @param id - The raw model id from the catalogue
 * @returns The base model id, or the input unchanged when it is not a fine-tune
 */
function baseModelId(id: string): string {
	if (!id.startsWith("ft:")) return id
	const parts = id.slice(3).split(":")
	return parts[0] ?? id
}

/**
 * The keys a model id should be matched against, most specific first.
 *
 * Gateways namespace their ids by vendor — every OpenRouter id looks like
 * `openai/gpt-5-mini` or `deepseek/deepseek-v4` — so a prefix test against the
 * raw id matches nothing and every inference silently fails. Trying the segment
 * after the last `/` as well makes the same tables work for both the bare ids
 * api.openai.com returns and the namespaced ones a gateway returns.
 *
 * @param id - The raw model id from the catalogue
 * @returns The id (fine-tune wrapper stripped), plus its last path segment
 */
function familyKeys(id: string): string[] {
	const base = baseModelId(id)
	const slash = base.lastIndexOf("/")
	if (slash < 0 || slash === base.length - 1) return [base]
	return [base, base.slice(slash + 1)]
}

/**
 * Classify a model id into a modality bucket.
 *
 * Unknown ids fall through to `'chat'` on purpose: OpenAI ships new chat models
 * far more often than new modalities, so an unrecognized id is much more likely
 * to be the next GPT than the next image model, and a chat model wrongly hidden
 * from a picker is a worse failure than a non-chat model wrongly offered (which
 * errors visibly on first use).
 *
 * @param id - The bare model id
 * @returns The inferred modality bucket
 */
function classifyModel(id: string): OpenAIModelType {
	const keys = familyKeys(id)
	return MODALITY_PROBES.find((probe) => keys.some((key) => probe.match(key)))?.type ?? "chat"
}

/**
 * Resolve a context window from the family table by longest-prefix match.
 *
 * Longest-prefix is what keeps overlapping families correct: `gpt-4o` (128k)
 * must beat `gpt-4` (8k) for `gpt-4o-mini`, and `gpt-4.1` (1M) must beat both.
 *
 * @param id - The bare model id
 * @returns The family's context window, or `undefined` when no family matches
 */
function familyContextWindow(id: string): number | undefined {
	const keys = familyKeys(id)
	let best: string | undefined
	for (const family of Object.keys(FAMILY_CONTEXT_WINDOWS)) {
		if (
			keys.some((key) => key.startsWith(family)) &&
			(best === undefined || family.length > best.length)
		) {
			best = family
		}
	}
	return best === undefined ? undefined : FAMILY_CONTEXT_WINDOWS[best]
}

/**
 * How many streamed tool calls {@link OpenAI} remembers for argument recovery.
 * A tool result is answered on the very next loop iteration, so a small window
 * is enough; the cap only exists to bound memory on a long conversation.
 */
const TOOL_CALL_MEMORY = 256

/**
 * Map BHZAI's six-level `params.reasoning` scale onto OpenAI's
 * `reasoning_effort` enum (`none`/`minimal`/`low`/`medium`/`high`/`xhigh`/`max`).
 *
 * The scales line up one-to-one except for `'off'`, which becomes `'none'`.
 * Not every reasoning model accepts every value — a model that rejects one
 * errors visibly rather than silently ignoring it, which is the behavior a host
 * can act on.
 *
 * @param level - The requested thinking level
 * @returns The matching `reasoning_effort` value
 */
function mapReasoningEffort(
	level: NonNullable<NonNullable<ChatRequest["params"]>["reasoning"]>,
): string {
	return level === "off" ? "none" : level
}

/**
 * Connection lifecycle event map for {@link OpenAI}.
 *
 * - `'connect'` — dispatched at the end of a successful `listModels()`,
 *   carrying the resolved `ModelInfo[]`.
 * - `'disconnect'` — dispatched by `disconnect()`; a host-intent signal
 *   (the stateless transport has no real connection to close).
 * - `'error'` — dispatched when `listModels()` or `embed()` fails, carrying
 *   the thrown error and the phase that failed. The original error is
 *   always re-thrown, so retry/kernel error routing is unchanged.
 */
export interface OpenAIEventMap {
	/** Resolved model list from a successful `listModels()`. */
	connect: { models: ModelInfo[] }
	/** No payload — `disconnect()` is a stateless host-intent signal. */
	// biome-ignore lint/suspicious/noConfusingVoidType: event-map value type, not a return type
	disconnect: void
	/** The thrown error and the method that failed. */
	error: { error: unknown; phase: "listModels" | "embed" }
}

/**
 * Declaration-merged typed `addEventListener` overloads for {@link OpenAI}, so
 * consumers get typed listeners for the connection lifecycle events. The
 * inherited base `EventTarget.addEventListener` overloads remain available for
 * arbitrary event types.
 */
export interface OpenAI {
	/**
	 * Typed `'connect'` listener — receives the resolved model list.
	 */
	addEventListener(
		type: "connect",
		listener: (e: CustomEvent<OpenAIEventMap["connect"]>) => void,
	): void
	/**
	 * Typed `'disconnect'` listener — no payload (stateless host-intent).
	 */
	addEventListener(type: "disconnect", listener: (e: Event) => void): void
	/**
	 * Typed `'error'` listener — receives the thrown error and failed phase.
	 */
	addEventListener(type: "error", listener: (e: CustomEvent<OpenAIEventMap["error"]>) => void): void
}

/**
 * `OpenAI` — a {@link BHZAIDriver} that talks to the OpenAI platform (or any
 * OpenAI-compatible gateway) over plain `fetch`. Works in any fetch-capable
 * runtime (browser, Node, Electron).
 *
 * Shares the LM Studio driver's posture (§ 10.3): no peer dependency, no engine
 * injection, web-standard APIs only, OpenAI-shaped JSON over Server-Sent Events.
 * Three things differ, all consequences of talking to a hosted multi-modal
 * platform rather than a local single-purpose server:
 *
 * 1. **Capabilities are inferred, not declared** — `/v1/models` carries no
 *    metadata, so families are matched by id prefix.
 * 2. **The catalogue is multi-modal** — image, audio and moderation models are
 *    listed alongside chat ones and are tagged via `meta.type` so hosts can
 *    filter.
 * 3. **Tool loops are reconstructed** — OpenAI validates that a `tool` message
 *    answers an assistant message carrying matching `tool_calls`, which the
 *    kernel's message list does not record. See {@link OpenAI.mapMessages}.
 *
 * Extends `EventTarget` to expose connection lifecycle events (`'connect'`,
 * `'disconnect'`, `'error'`) so hosts can observe connect/disconnect/
 * connection-fail without coupling to driver internals.
 */
// biome-ignore lint/suspicious/noUnsafeDeclarationMerging: intentional typed-event overloads via merged interface; adds only method overloads, no uninitialized fields
export class OpenAI extends EventTarget implements BHZAIDriver {
	readonly id = "openai" as const
	private declare readonly baseUrl: string
	private declare readonly headers: Record<string, string>
	private declare readonly contextWindowOverrides: Record<string, number>

	/**
	 * Cache of per-model capabilities, populated by `listModels()` and by
	 * `chat()` (which calls `refreshCapabilitiesCache` for the model it is about
	 * to use). The synchronous `capabilities(model)` method reads from this
	 * cache, falling back to conservative defaults when no entry exists yet.
	 *
	 * SYNC/ASYNC MISMATCH RESOLUTION (same posture as the LM Studio driver):
	 * `BHZAIDriver.capabilities(model)` is synchronous, but the data source
	 * (`GET /v1/models`) is asynchronous. This cache-then-read pattern resolves
	 * that tension. When `capabilities()` is called for a model no prior
	 * `listModels()`/`chat()` has populated, it returns conservative defaults
	 * (all booleans `false`, `contextWindow` `undefined`) rather than throwing.
	 */
	private readonly capabilitiesCache: Map<string, DriverCapabilities> = new Map()

	/**
	 * Tool calls this driver has streamed, keyed by tool-call id, so a later
	 * iteration of the same agent loop can rebuild the assistant `tool_calls`
	 * entry OpenAI requires before a `tool` message (see
	 * {@link OpenAI.mapMessages}).
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
	 * Distinct from "is this model cached": a gateway may serve a model it does
	 * not list, or return an empty `data` array entirely, and in both cases the
	 * per-model cache stays empty however many times the catalogue is fetched.
	 * Without this flag `chat()` would re-poll `/v1/models` before every call and
	 * never succeed in filling the gap. Cleared by `disconnect()`.
	 */
	private catalogueLoaded = false

	constructor(options?: OpenAIOptions) {
		super()
		this.baseUrl = options?.baseUrl ?? "https://api.openai.com"
		this.headers = options?.headers ?? {}
		this.contextWindowOverrides = options?.contextWindows ?? {}
		// Test-injection seam: if the caller passed the internal `fetchOverride`
		// field, use it; otherwise use the global `fetch`.
		const internal = options as OpenAIInternalOptions | undefined
		// `globalThis.fetch` must be bound to the global object. Storing it as a
		// property and calling it later would make `this` the OpenAI instance,
		// which native fetch rejects with "Illegal invocation".
		this.fetchFn = internal?.fetchOverride ?? globalThis.fetch.bind(globalThis)
	}

	/**
	 * `GET {baseUrl}/v1/models` — lists every model the API key can reach, and
	 * caches each one's inferred capabilities on the way through (no second
	 * request needed).
	 *
	 * AVAILABILITY MAPPING: every returned entry is `'ready'`. A hosted model is
	 * usable the moment it is listed — there is nothing to download and no
	 * warm-up state to report. Models the key cannot access are simply absent
	 * from the response rather than listed as `'unavailable'`.
	 *
	 * MULTI-MODAL CATALOGUE: the response mixes chat models with embeddings,
	 * speech, image and moderation models. All of them are returned — filtering
	 * the catalogue is a host decision, not a driver one — but each carries an
	 * inferred `meta.type` so a chat UI can drop the ones it cannot use.
	 */
	async listModels(): Promise<ModelInfo[]> {
		try {
			const entries = await this.fetchModelEntries()
			const models: ModelInfo[] = entries.map((entry) => ({
				ref: `openai/${entry.id}`,
				driver: "openai",
				id: entry.id,
				label: entry.id,
				capabilities: this.capabilities(entry.id),
				availability: "ready" as const,
				meta: {
					type: classifyModel(entry.id),
					ownedBy: entry.owned_by,
					created: entry.created,
				},
			}))
			this.dispatchEvent(
				new CustomEvent<OpenAIEventMap["connect"]>("connect", {
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
	 * DECLARATION FIRST, THEN INFERENCE. api.openai.com's `GET /v1/models`
	 * returns `{ id, object, created, owned_by }` and nothing else — no modality,
	 * no context length, no capability list — so against OpenAI itself every flag
	 * is inferred from the model id's family. OpenAI-COMPATIBLE GATEWAYS commonly
	 * add real metadata to the same endpoint (OpenRouter reports `context_length`
	 * for every model and `supported_parameters` for nearly all of them), and a
	 * declaration always beats a guess:
	 *
	 * - `streaming`: always `true` — `/v1/chat/completions` streams.
	 * - `toolCalls`: `supported_parameters.includes('tools')` when declared;
	 *   otherwise `true` for chat models and `false` for every other modality.
	 * - `reasoning`: `supported_parameters` includes `'reasoning'` or
	 *   `'reasoning_effort'` when declared; otherwise `true` for the `o`-series,
	 *   GPT-5 and codex families, i.e. the models that accept `reasoning_effort`.
	 * - `embeddings`: `true` for the `text-embedding-*` family.
	 * - `contextWindow`: `OpenAIOptions.contextWindows[model]` if the host
	 *   supplied one, else the provider-reported `context_length`, else the
	 *   family table, else `undefined`.
	 *
	 * NAMESPACED IDS: gateways prefix ids by vendor (`openai/gpt-5-mini`). Every
	 * id-based test above also runs against the segment after the last `/`, so
	 * the same tables work for bare and namespaced ids alike — see
	 * {@link familyKeys}.
	 *
	 * EXPLICIT DEVIATION from the conservative default, matching the LM Studio
	 * driver's precedent: `toolCalls` defaults to `true` for chat models. Every
	 * current OpenAI chat model supports tool calling and the API declares
	 * nothing, so defaulting to `false` would silently strip every tool from
	 * every request — a far worse failure than forwarding tools to a model that
	 * then ignores them. Models the cache has never seen at all still get
	 * `toolCalls: false`; that is an absence of data, not an inference.
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
	 * Host-intent disconnect signal. The OpenAI transport is stateless (plain
	 * `fetch` over HTTPS — there is no persistent connection to close), so this
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
	 * Error handling: non-2xx responses throw an error object shaped
	 * `{ status, body }` so the retry classifier can inspect `.status`.
	 * Network-level `fetch` failures (thrown `TypeError`) propagate uncaught.
	 */
	async *chat(request: ChatRequest): AsyncIterable<DriverEvent> {
		// Ensure capabilities are cached for this model (for tool-call gating and
		// the reasoning-effort parameter).
		await this.refreshCapabilitiesCache(request.model)
		const caps = this.capabilities(request.model)

		// Step 1: map BHZAIMessage[] onto the wire shape, rebuilding the
		// assistant `tool_calls` records OpenAI requires before `tool` messages.
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
		// for a final usage-only chunk; gateways that don't understand the option
		// simply omit it and the `usage` event is skipped.
		const body: Record<string, unknown> = {
			model: request.model,
			messages,
			stream: true,
			stream_options: { include_usage: true },
		}
		if (tools) body.tools = tools
		if (request.params?.temperature !== undefined) body.temperature = request.params.temperature
		// `max_completion_tokens`, NOT `max_tokens`: the latter is deprecated and
		// is rejected outright by the o-series and GPT-5 reasoning models. The new
		// name is accepted by every current chat model, so there is no branch.
		if (request.params?.maxTokens !== undefined) {
			body.max_completion_tokens = request.params.maxTokens
		}
		if (request.params?.stop) body.stop = request.params.stop
		// Reasoning effort is only meaningful — and only accepted — on reasoning
		// models, so it is gated on the capability flag.
		if (caps.reasoning && request.params?.reasoning) {
			body.reasoning_effort = mapReasoningEffort(request.params.reasoning)
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
					// Reasoning text arrives on its own channel only from
					// OpenAI-compatible gateways; api.openai.com keeps reasoning
					// summaries in the Responses API. Inline `<think>`-tag
					// reasoning stays in `content` and is the conversation
					// layer's `parseThink` job.
					if (delta?.reasoning_content) {
						yield { type: "reasoning-delta", text: delta.reasoning_content }
					}
					if (delta?.content) {
						yield { type: "delta", text: delta.content }
					}
					// A refusal replaces the answer. Surfacing it as ordinary
					// text is what keeps a refused turn from rendering as an
					// empty assistant message with no explanation.
					if (delta?.refusal) {
						yield { type: "delta", text: delta.refusal }
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
	 * Only call this for models whose `capabilities(model).embeddings` is `true`;
	 * calling it for a non-embedding model still forwards the request as-is
	 * (OpenAI itself will error) — gatekeeping which models are "allowed" to
	 * embed is a host/kernel-level concern, not this driver's job to enforce.
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
			// than trusting arrival order, so the result lines up positionally
			// with `request.input`.
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
	 * the assistant `tool_calls` records the API requires.
	 *
	 * WHY THIS IS MORE THAN A `{ role, content }` MAP (unlike the Ollama and LM
	 * Studio drivers): OpenAI validates conversation structure. A `role: 'tool'`
	 * message must carry a `tool_call_id` AND must be preceded by an assistant
	 * message whose `tool_calls` array contains that id, or the request fails
	 * with 400 before the model ever sees it. The kernel records the id on the
	 * tool-result message's `meta.toolCallId` (`src/conversation/agent-loop.ts`)
	 * but does NOT record the calls on the assistant message that made them, so
	 * a naive mapping breaks on the second iteration of every tool loop.
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
	 * 2. **{@link OpenAI.toolCallMemory}** — calls this driver instance streamed
	 *    but that carry no record, e.g. a message a host injected by hand.
	 * 3. **`'{}'`** — last resort. The id and name are still correct, which is
	 *    what the API validates; only the argument text is lost.
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
					// The API rejects an assistant message with neither content
					// nor tool calls, and rejects `content: ""` alongside them.
					if (!entry.content) entry.content = undefined
				}
				wire.push(entry)
				continue
			}
			// A tool result without a recorded id cannot be paired with anything,
			// so mint one here and use it on BOTH sides of the pairing below.
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
	 * Called once per tool message as {@link OpenAI.mapMessages} builds the list,
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
			// The API rejects an assistant message with neither content nor tool
			// calls; with tool calls present, empty content is dropped rather
			// than sent as "".
			if (anchor.content === "") anchor.content = undefined
			return
		}
		wire.splice(index + 1, 0, { role: "assistant", tool_calls: [record] })
	}

	/**
	 * Record a streamed tool call so a later iteration can rebuild its wire
	 * record with the real arguments (see {@link OpenAI.mapMessages}).
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
	 * OpenAI sends the id and function name on the first fragment for a given
	 * `index`, then the JSON arguments a few characters at a time. A missing
	 * `index` is treated as `0` — compatible gateways with simpler serializers
	 * omit it.
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
				// OpenAI supplies an id on the opening fragment, but compatible
				// gateways do not always — fall back to a generated one so the
				// call is still addressable.
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
			new CustomEvent<OpenAIEventMap["error"]>("error", {
				detail: { error, phase },
			}),
		)
	}

	/**
	 * Map OpenAI's `finish_reason` to BHZAI's `stopReason`.
	 * - `'length'` → `'length'`
	 * - `'tool_calls'`, or any run that produced tool calls → `'tool-calls'`
	 * - anything else (`'stop'`, `'content_filter'`, absent) → `'stop'`
	 *
	 * The `hadToolCalls` override matters because a compatible gateway can close
	 * a tool-calling turn with `finish_reason: 'stop'`; treating that as a
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
	 * Fetch `GET /v1/models` and cache every entry's inferred capabilities.
	 *
	 * One catalogue request populates the cache for every model at once, so
	 * `listModels()` issues exactly one fetch.
	 *
	 * @returns The raw model entries, for `listModels()` to map
	 */
	private async fetchModelEntries(): Promise<OpenAIModelEntry[]> {
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
			this.capabilitiesCache.set(entry.id, this.parseModelEntry(entry))
		}
		// Reached only on a 2xx that parsed: the catalogue is now known, even if
		// it turned out to be empty.
		this.catalogueLoaded = true
		return entries
	}

	/**
	 * Populate the capabilities cache for a model, if it isn't cached already, so
	 * the synchronous `capabilities()` method has data to read.
	 *
	 * Fetches the catalogue AT MOST ONCE per connection, tracked by
	 * {@link OpenAI.catalogueLoaded} rather than by whether this particular model
	 * landed in the cache. A model absent from a catalogue that loaded fine is
	 * legitimately absent — gateways commonly serve models they do not list, and
	 * some return an empty `data` array altogether — so keying off the per-model
	 * miss would re-poll `/v1/models` before every single `chat()` call and never
	 * succeed. `listModels()` still re-fetches unconditionally, so a host that
	 * refreshes its catalogue picks up newly available models.
	 *
	 * Swallows failures on purpose: a `chat()` call must not be aborted because
	 * the catalogue lookup failed. `capabilities()` then returns conservative
	 * defaults and the chat request itself surfaces any real problem — including
	 * the common one here, an invalid API key, which fails both calls the same
	 * way. A failed attempt does not set the flag, so the next call retries.
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
	 * Project one `/v1/models` entry onto `DriverCapabilities` using the
	 * inference documented on {@link OpenAI.capabilities}.
	 */
	private parseModelEntry(entry: OpenAIModelEntry): DriverCapabilities {
		const type = classifyModel(entry.id)
		const keys = familyKeys(entry.id)
		// A gateway that declares its supported parameters is authoritative —
		// same posture as LM Studio's `capabilities` array. An explicit empty
		// array is a statement ("nothing"), not missing data; only an absent
		// field falls through to inference.
		const declared = entry.supported_parameters
		return {
			streaming: true,
			toolCalls: declared ? declared.includes("tools") : type === "chat",
			reasoning: declared
				? declared.includes("reasoning") || declared.includes("reasoning_effort")
				: type === "chat" && REASONING_PREFIXES.some((p) => keys.some((k) => k.startsWith(p))),
			embeddings: type === "embeddings",
			// Priority: host override → what the provider actually reports →
			// the family-table guess. The middle tier is why an OpenRouter model
			// gets its real window rather than nothing.
			contextWindow:
				this.contextWindowOverrides[entry.id] ??
				entry.context_length ??
				entry.top_provider?.context_length ??
				familyContextWindow(entry.id),
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
	 * option (not part of the public `OpenAIOptions` type to keep the public API
	 * clean). When no override is supplied, the global `fetch` is used.
	 */
	private declare readonly fetchFn: typeof fetch
	private fetch(input: string, init?: RequestInit): Promise<Response> {
		return this.fetchFn(input, init)
	}
}

/**
 * Internal constructor options (extends the public `OpenAIOptions` with a
 * test-injection seam for `fetch`). The `fetchOverride` field is not part of the
 * public API — it exists so tests can inject a fake `fetch` without
 * monkey-patching the global.
 */
export interface OpenAIInternalOptions extends OpenAIOptions {
	/** @internal Test-only override for the global `fetch`. */
	fetchOverride?: typeof fetch
}
