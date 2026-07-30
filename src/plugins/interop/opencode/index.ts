/** @file TASK_0040: OpenCode plugin interop adapter — maps OpenCode-style plugins onto BHZAI primitives */

import type { BHZAIConversationImpl } from "../../../conversation/conversation.js"
import type { BHZAI } from "../../../core/bhzai.js"
import type { CredentialResolver, CredentialScope, Credentials } from "../../../core/credentials.js"
import type { JSONSchema } from "../../../types/content.js"
import type { BHZAIToolDefinition } from "../../../types/tool.js"

/**
 * Internal interface: tool invocation passed to wrapped tool execute functions.
 */
interface ToolInvocation {
	params: unknown
	conversation?: unknown
	signal?: AbortSignal
}

/**
 * Internal interface: payload shape for conversation.created event.
 */
interface ConversationCreatedPayload {
	conversation: BHZAIConversationImpl
}

/**
 * Internal interface: payload shape for "idle" event.
 */
interface IdleEventPayload {
	[key: string]: unknown
}

/**
 * Internal interface: payload shape for "message.delta" event.
 */
interface MessageDeltaEventPayload {
	[key: string]: unknown
}

/**
 * Internal interface: payload shape for "compact" event.
 */
interface CompactEventPayload {
	state: "before" | "compacting" | "complete"
	[key: string]: unknown
}

/**
 * Internal interface: payload shape for "message" event.
 */
interface MessageEventPayload {
	state: string
	role: string
	[key: string]: unknown
}

/**
 * Internal interface: payload shape for "context" event.
 */
interface ContextEventPayload {
	[key: string]: unknown
}

/**
 * Internal interface: payload shape for "tool" event.
 */
interface ToolEventPayload {
	state: "beforeCall" | "complete" | "error"
	tool?: { name: string }
	response?: unknown
	isError?: boolean
	[key: string]: unknown
}

/**
 * Internal interface: payload shape for "turn" event.
 */
interface TurnEventPayload {
	state: string
	[key: string]: unknown
}

/**
 * Internal interface: plugin capability object for use in bh.use().
 */
interface PluginCapabilities {
	name: string
	configSchema?: JSONSchema
	auth?: CredentialResolver
}

/**
 * Minimal stand-in for OpenCode's `client` parameter — a fetch-based wrapper
 * that rejects every method call unless a `fetchImpl` is supplied.
 * Real OpenCode's client talks to a running OpenCode server; this adapter's
 * world has no server, so calls are only meaningful if the host supplies
 * a `fetchImpl` (and a base URL, implicit in this stub's error messages).
 */
export interface OpenCodeClientStub {
	/** Resolves with a clear "not available" error unless fetchImpl is supplied. */
	[key: string]: (...args: unknown[]) => Promise<unknown>
}

/**
 * Minimal context supplied to an OpenCode plugin function.
 * Matches the shape of OpenCode's real context, with realistic stubs for what
 * cannot be provided in this adapter's environment.
 */
export interface OpenCodePluginContext {
	/** Project metadata (required by callers; no defaults are invented). */
	project: { name: string; root: string }
	/** Minimal fetch-based stand-in for OpenCode's real server-backed `client`. */
	client: OpenCodeClientStub
	/** Shell-execution helper (`$`). Deliberately omitted (not stubbed) per ARCHITECTURE.md § 12 — plugins
	 * that shell out will throw a `TypeError`, and this is an accepted adapter limitation. */
	$: undefined
	/** Working directory for the plugin's operations. */
	directory: string
}

/**
 * Options passed to {@link runOpenCodePlugin} to configure the minimal context.
 */
export interface OpenCodeAdapterOptions {
	/** Project identity (name + root). */
	project: { name: string; root: string }
	/** Working directory. */
	directory: string
	/** Optional fetch implementation for the `client` stub. When omitted, `client` methods reject. */
	fetchImpl?: typeof fetch
}

/**
 * An OpenCode plugin function — the canonical entry point for OpenCode-style plugins.
 * Receives a minimal context and returns a hooks object mapping the plugin's behaviors.
 */
export type OpenCodePluginFn = (ctx: OpenCodePluginContext) => Promise<OpenCodeHooks>

/**
 * The hooks object returned by an OpenCode plugin function.
 * Each key is a well-known hook name; TASK_0040 implements the ones that map cleanly
 * onto BHZAI mechanisms (see § 8.3 mapping table). Dotted keys (e.g., `'tool.execute.before'`)
 * are normalized to nested structure internally by the adapter.
 */
export interface OpenCodeHooks {
	/** Tool definitions, keyed by name. */
	tool?: Record<
		string,
		{
			description: string
			/** Schema object exposing a `.toJSONSchema()` method (zod v4, TypeBox, ArkType style). */
			args: { toJSONSchema(): JSONSchema }
			execute(args: unknown, ctx: unknown): Promise<unknown>
		}
	>
	/** Generic event hook — receives tagged-union events (e.g., `{event: {type: 'session.idle', ...}}`). */
	event?: (input: { event: unknown }) => void | Promise<void>
	/** Chat-related hooks. */
	chat?: {
		/** Fires on user message before, receives (input, output) where output can be mutated. */
		message?: (input: unknown, output: unknown) => void | Promise<void>
		/** Fires on context event, receives (input, output) for partial chat-params patching. */
		params?: (input: unknown, output: unknown) => void | Promise<void>
	}
	/** Tool execution observer (non-blocking) — fires on beforeCall. */
	tool_execute_before?: (input: unknown, output: unknown) => void | Promise<void>
	/** Tool execution observer (non-blocking) — fires on complete/error. */
	tool_execute_after?: (input: unknown, output: unknown) => void | Promise<void>
	/** Tool approval hook (blockable) — fires on beforeCall, returns 'allow'/'deny'/undefined. */
	permission_ask?: (input: unknown, output: unknown) => Promise<"allow" | "deny" | undefined>
	/** Veto hook for turn end — receives (input, output), returns optional {continueWith?}. */
	stop?: (
		input: unknown,
		output: unknown,
	) => undefined | Promise<undefined | { continueWith?: string }>
	/** Plugin configuration — returns JSONSchema or {schema, values?}. */
	config?: (config: unknown) => JSONSchema | { schema: JSONSchema; values?: unknown }
	/** Credential resolution hook — returns a key-value map or undefined. */
	auth?: (scope: { kind: "driver" | "mcp"; id: string }) => Promise<Credentials | undefined>
}

/**
 * Runs an OpenCode-style plugin function against a live BHZAI instance, mapping its
 * returned hooks object onto BHZAI kernel primitives per ARCHITECTURE.md § 8.3 and § 12.
 *
 * The adapter:
 * - Builds a minimal {@link OpenCodePluginContext} (project, directory, fetch-based client stub, omitted `$`)
 * - Calls the plugin function with that context
 * - Maps each present hook onto corresponding BHZAI mechanisms:
 *   - `tool`: registers via `bh.addTool()` with schema conversion via `.toJSONSchema()`
 *   - `tool_execute_before`/`tool_execute_after`: non-blocking observers on `tool(beforeCall)`/`tool(complete|error)`
 *   - `permission_ask`: a single `tool(beforeCall)` subscriber that blocks on `'deny'`, composing with native approvers
 *   - `chat.message`/`chat.params`: conversation event subscribers
 *   - `stop`: turn-end veto via `turn(end)`
 *   - `event`: generic event hook dispatching for supported BHZAI events
 *   - `config`: declared via `bh.declareConfig()` with default-merging
 *   - `auth`: registered as a tier-2 credential resolver in the chain
 *
 * @param plugin The unmodified OpenCode plugin function.
 * @param bh The BHZAI instance to register hooks against.
 * @param options Context configuration (project, directory, optional fetchImpl).
 *
 * @throws If the plugin function throws or rejects.
 * @throws If any `bh.addTool()` / `bh.declareConfig()` / other kernel operation fails.
 */
export async function runOpenCodePlugin(
	plugin: OpenCodePluginFn,
	bh: BHZAI,
	options: OpenCodeAdapterOptions,
): Promise<void> {
	// Step 1: Build the minimal OpenCode-shaped context
	const clientStub = buildClientStub(options.fetchImpl)
	const context: OpenCodePluginContext = {
		project: options.project,
		client: clientStub,
		$: undefined,
		directory: options.directory,
	}

	// Step 2: Call the plugin function and get its hooks
	const hooks = await plugin(context)

	// Step 3: Wire up each present hook onto BHZAI mechanisms

	// Tool hook: register each tool with JSON Schema conversion
	if (hooks.tool) {
		for (const [toolKey, toolDef] of Object.entries(hooks.tool)) {
			const jsonSchema = toolDef.args.toJSONSchema()
			const wrappedExecute = async (invocation: unknown) => {
				const inv = invocation as ToolInvocation
				return toolDef.execute(inv.params, {
					conversation: inv.conversation,
					signal: inv.signal,
				})
			}
			bh.addTool({
				name: toolKey,
				description: toolDef.description,
				inputSchema: jsonSchema,
				execute: wrappedExecute,
			} as BHZAIToolDefinition)
		}
	}

	// Register all other hooks via a wrapper plugin on the BHZAI instance.
	// Note: we register the plugin FIRST (so its auth capability is available to the kernel),
	// then run setupHookHandlers DIRECTLY (not from initialize hook) so it works even if
	// init() has already been called (per the pattern used in the pi adapter).
	const wrapperPluginName = `opencode:${options.project.name}:${crypto.randomUUID()}`

	// Build the auth capability if an auth hook is present
	const authCapability: CredentialResolver | undefined = hooks.auth
		? {
				resolve: async (scope: CredentialScope) => {
					return hooks.auth?.(scope)
				},
			}
		: undefined

	// Build the config capability if present
	const configSchema = buildConfigCapability(hooks, options)

	// Build the plugin capability object
	const pluginCapabilities: PluginCapabilities = {
		name: wrapperPluginName,
	}
	if (configSchema) {
		pluginCapabilities.configSchema = configSchema
	}
	if (authCapability) {
		pluginCapabilities.auth = authCapability
	}

	bh.use(pluginCapabilities)

	// Setup conversation-level handlers DIRECTLY (not from initialize hook),
	// so they work even if init() has already been called.
	setupHookHandlers(bh, hooks, options)
}

/**
 * Builds a minimal fetch-based client stub that rejects every method call
 * unless a fetchImpl is supplied.
 */
function buildClientStub(fetchImpl?: typeof fetch): OpenCodeClientStub {
	return new Proxy({} as OpenCodeClientStub, {
		get: (_target, prop: string | symbol) => {
			if (typeof prop === "symbol") {
				return undefined
			}
			return async (..._args: unknown[]) => {
				if (!fetchImpl) {
					throw new Error(
						`OpenCode client.${prop}() is not available in the BHZAI adapter (no running OpenCode server and no fetchImpl supplied)`,
					)
				}
				throw new Error(`client.${prop}() not fully implemented in this adapter stub`)
			}
		},
	})
}

/**
 * Internal helper: extracts the config schema from a plugin's config hook,
 * if present. Returns the schema if found, undefined otherwise.
 * Also merges any supplied default values into the schema's per-property defaults.
 */
function buildConfigCapability(
	hooks: OpenCodeHooks,
	options: OpenCodeAdapterOptions,
): JSONSchema | undefined {
	if (!hooks.config) {
		return undefined
	}
	const configResult = hooks.config({} as Record<string, unknown>)
	let schema: JSONSchema | undefined
	if (typeof configResult === "object" && configResult !== null && "schema" in configResult) {
		schema = (configResult as { schema: JSONSchema; values?: Record<string, unknown> }).schema
	} else if (typeof configResult === "object" && configResult !== null) {
		schema = configResult as JSONSchema
	}
	// If values were supplied, merge them into the schema as per-property defaults
	if (
		schema &&
		typeof configResult === "object" &&
		configResult !== null &&
		"values" in configResult &&
		configResult.values
	) {
		mergeDefaultsIntoSchema(schema, configResult.values as Record<string, unknown>)
	}
	return schema
}

/**
 * Internal helper: wires up hook handlers directly (not via plugin.initialize).
 * This runs immediately in runOpenCodePlugin, AFTER the wrapper plugin is registered
 * but BEFORE (or AFTER) init() has run. Framework-level listeners are registered here
 * so they work regardless of init() timing, following the pi adapter pattern.
 */
function setupHookHandlers(bh: BHZAI, hooks: OpenCodeHooks, options: OpenCodeAdapterOptions): void {
	// Per the OpenCode adapter's contract, hook wiring happens here so they register
	// in the proper order with the event buses (framework + per-conversation).

	// Wire up per-conversation event handlers whenever a conversation is created.
	// This applies to ANY hook that needs conversation-level event subscription.
	// We check for the presence of any conversation-level hook to decide whether
	// to register the listener.
	const hasConversationHooks =
		hooks.event ||
		hooks.chat?.message ||
		hooks.chat?.params ||
		hooks.tool_execute_before ||
		hooks.tool_execute_after ||
		hooks.permission_ask ||
		hooks.stop

	if (hasConversationHooks) {
		bh.on("conversation.created", (payload: unknown) => {
			const p = payload as ConversationCreatedPayload
			// Wire up per-conversation event dispatches
			handleConversationCreated(p.conversation, hooks)
		})
	}

	// Note: config schema is registered via buildConfigCapability() during plugin.use(),
	// and auth hook is registered via the wrapper plugin's auth capability key,
	// so both become part of the plugin's capabilities and are handled by the kernel's
	// existing config/auth integration paths.
}

/**
 * Wires up per-conversation event handlers when a conversation is created.
 * Registers handlers on the conversation's event bus for all OpenCode-mapped hooks.
 */
function handleConversationCreated(
	conversation: BHZAIConversationImpl,
	hooks: OpenCodeHooks,
): void {
	// Generic event hook: idle, message.delta, compact, and conversation.created
	if (hooks.event) {
		// Idle event
		conversation.on("idle", (payload: unknown) => {
			const p = payload as IdleEventPayload
			void hooks.event?.({ event: { type: "session.idle", ...p } })
		})

		// Message delta event
		conversation.on("message.delta", (payload: unknown) => {
			const p = payload as MessageDeltaEventPayload
			void hooks.event?.({ event: { type: "message.part.updated", ...p } })
		})

		// Compact events (experimental.session.compacting for before/compacting, session.compacted for complete)
		conversation.on("compact", (payload: unknown) => {
			const p = payload as CompactEventPayload
			if (p.state === "before" || p.state === "compacting") {
				void hooks.event?.({ event: { type: "experimental.session.compacting", ...p } })
			} else if (p.state === "complete") {
				void hooks.event?.({ event: { type: "session.compacted", ...p } })
			}
		})
	}

	// Chat.message hook (user message before)
	if (hooks.chat?.message) {
		conversation.on("message", async (payload: unknown) => {
			const p = payload as MessageEventPayload
			if (p.state === "before" && p.role === "user") {
				const output = {}
				await hooks.chat?.message?.(p, output)
				// The output object might have been mutated with message modifications
				// PARTIAL IMPLEMENTATION: for now, we read back the output but don't apply mutations
				// (full message-mutation semantics would require deeper integration with
				// the message object's append/mutate methods, which are TASK_0025's concern)
			}
		})
	}

	// Chat.params hook (context event, PARTIAL per § 8.3)
	if (hooks.chat?.params) {
		conversation.on("context", async (payload: unknown) => {
			const p = payload as ContextEventPayload
			const output = {}
			await hooks.chat?.params?.(p, output)
			// PARTIAL: only systemPrompt/generation-related subset honored per the table note
		})
	}

	// Tool hooks: beforeCall and complete/error are handled via separate handlers
	// to ensure they each fire independently and can compose with other approvers.

	// tool_execute_before: non-blocking observer on beforeCall
	if (hooks.tool_execute_before) {
		conversation.on("tool", async (payload: unknown) => {
			const p = payload as ToolEventPayload
			if (p.state === "beforeCall") {
				const output = {}
				await hooks.tool_execute_before?.(p, output)
				// Non-blocking: never returns a patch, never blocks
			}
		})
	}

	// permission_ask: blockable observer on beforeCall, returns { block: true } on 'deny'
	if (hooks.permission_ask) {
		conversation.on("tool", async (payload: unknown) => {
			const p = payload as ToolEventPayload
			if (p.state === "beforeCall") {
				const output = {}
				const verdict = await hooks.permission_ask?.(p, output)
				if (verdict === "deny") {
					return { block: true, reason: "denied by OpenCode permission.ask hook" }
				}
				// verdict === 'allow' or undefined: no patch, let other handlers decide
			}
		})
	}

	// tool_execute_after: observer on complete/error
	if (hooks.tool_execute_after) {
		conversation.on("tool", async (payload: unknown) => {
			const p = payload as ToolEventPayload
			if (p.state === "complete" || p.state === "error") {
				const output = {
					response: p.response,
					isError: p.isError,
				}
				await hooks.tool_execute_after?.(p, output)
				// Return patch with any mutated response/isError
				if (output.response !== p.response || output.isError !== p.isError) {
					return { response: output.response, isError: output.isError }
				}
			}
		})
	}

	// Stop hook: turn end veto
	if (hooks.stop) {
		conversation.on("turn", async (payload: unknown) => {
			const p = payload as TurnEventPayload
			if (p.state === "end") {
				const output = {}
				const result = await hooks.stop?.(p, output)
				// Return any continueWith veto
				if (result && "continueWith" in result && result.continueWith !== undefined) {
					return { continueWith: result.continueWith }
				}
			}
		})
	}
}

/**
 * Merges supplied default values into a JSON Schema's per-property `default` keywords.
 * Called when a plugin's `config` hook supplies both a schema and default values.
 */
function mergeDefaultsIntoSchema(schema: JSONSchema, values: Record<string, unknown>): void {
	if (schema.properties && typeof schema.properties === "object") {
		for (const [key, value] of Object.entries(values)) {
			const prop = (schema.properties as Record<string, JSONSchema>)[key]
			if (prop && typeof prop === "object") {
				prop.default = value
			}
		}
	}
}

/**
 * Re-exported for use in the adapter's initialization flow.
 */
export type { CredentialScope, Credentials } from "../../../core/credentials.js"
