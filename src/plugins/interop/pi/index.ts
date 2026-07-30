/** @file pi coding-agent extension interop adapter (TASK_0039) */

import type { BHZAI } from "../../../core/bhzai.js"
import type { JSONSchema } from "../../../types/content.js"
import type {
	BHZAICommandDefinition,
	BHZAIConversation,
	BHZAIToolDefinition,
	CallToolResult,
	ToolInvocation,
} from "../../../types/index.js"

/**
 * Warnings for unsupported/no-op pi API calls recorded during extension execution.
 *
 * Each warning represents one call site to an unsupported API (TUI-bound or
 * otherwise). Multiple calls to the same API produce multiple warnings.
 */
export interface PiUnsupportedCallWarning {
	/** Dotted path of the unsupported call, e.g. 'ui.render', 'session.fork'. */
	api: string
	/** Arguments the extension passed, captured for diagnostics (best-effort). */
	args: unknown[]
	/** Epoch ms when the call was made. */
	time: number
}

/**
 * Handle returned by runPiExtension, containing runtime diagnostics.
 *
 * Callers (hosts, tests) inspect this after the factory has run to decide
 * whether to warn or log about unsupported APIs.
 */
export interface PiAdapterHandle {
	/** Every unsupported/no-op call invoked by the extension, in call order. */
	readonly warnings: readonly PiUnsupportedCallWarning[]
}

/**
 * A pi-style extension factory function.
 *
 * Receives a shim PiExtensionAPI and may register tools, commands, hooks,
 * or call other extension APIs. May be async.
 */
export type PiExtensionFactory = (pi: PiExtensionAPI) => void | Promise<void>

/**
 * Handler signature for pi events.
 *
 * May be sync or async; may return a patch object or a block signal.
 * Patch and block semantics are preserved from BHZAI's own event bus.
 */
type PiHandler = (
	payload: unknown,
	ctx?: unknown,
) =>
	| undefined
	| Record<string, unknown>
	| { block: true; reason?: string }
	| (Record<string, unknown> & { block: true })
	| Promise<
			| undefined
			| Record<string, unknown>
			| { block: true; reason?: string }
			| (Record<string, unknown> & { block: true })
	  >

/**
 * Tool definition shape accepted by pi.registerTool.
 *
 * The `parameters` field is expected to already be a valid JSON Schema
 * (no TypeBox conversion performed by the adapter).
 */
interface PiToolDef {
	name: string
	description: string
	parameters: JSONSchema
	execute: (
		params: unknown,
		ctx: {
			conversation?: BHZAIConversation
			signal?: AbortSignal
			progress?: (update: string) => void
		},
	) => Promise<unknown>
}

/**
 * Command definition shape accepted by pi.registerCommand.
 */
interface PiCommandDef {
	name: string
	description: string
	handler: (args: string[], ctx: unknown) => unknown | Promise<unknown>
	getArgumentCompletions?: (prefix: string) => unknown | Promise<unknown>
}

/**
 * The shim ExtensionAPI object passed to pi extension factories.
 *
 * This is NOT imported from any real pi package; it is defined entirely by
 * this adapter to support the portable subset of pi extensions that map onto
 * BHZAI's kernel primitives.
 */
export interface PiExtensionAPI {
	on(event: string, handler: PiHandler): void
	registerTool(def: PiToolDef): void
	registerCommand(def: PiCommandDef): void
	registerFlag<T>(name: string, opts: { default: T; description?: string }): void
	getFlag<T>(name: string): T
	sendMessage(
		content: string,
		options?: { deliverAs?: "immediate" | "steer" | "followUp" },
	): Promise<unknown>
	sendUserMessage(
		content: string,
		options?: { deliverAs?: "immediate" | "steer" | "followUp" },
	): Promise<unknown>
	events: {
		on(name: string, handler: (payload: unknown) => void): void
		emit(name: string, payload: unknown): void
	}
	ui: Record<string, (...args: unknown[]) => unknown>
	shortcuts: Record<string, (...args: unknown[]) => unknown>
	themes: Record<string, (...args: unknown[]) => unknown>
	session: Record<string, (...args: unknown[]) => unknown>
}

/**
 * Runs a pi-style extension factory against a live BHZAI instance.
 *
 * Constructs a shim ExtensionAPI object, runs the factory with it, and
 * translates every call the extension makes onto BHZAI kernel primitives.
 * TUI-bound calls are recorded as no-ops.
 *
 * Intended usage (wrapped in a named plugin for proper lifecycle):
 *
 * ```ts
 * bh.use({
 *   name: 'pi:my-extension',
 *   initialize: ({ bh }) => runPiExtension(myPiFactory, bh)
 * })
 * ```
 *
 * @param factory The pi extension factory function
 * @param bh The BHZAI kernel instance to run against
 * @param pluginName Optional plugin name for event prefixing and config.
 *                   If not provided, derived from the enclosing plugin context
 *                   or defaults to 'pi-extension-<uuid>'.
 *
 * @returns A handle containing warnings about unsupported calls.
 */
export async function runPiExtension(
	factory: PiExtensionFactory,
	bh: BHZAI,
	pluginName?: string,
): Promise<PiAdapterHandle> {
	const warnings: PiUnsupportedCallWarning[] = []
	let mostRecentConversation: BHZAIConversation | undefined

	// Derive plugin name if not provided
	let derivedPluginName = pluginName
	if (!derivedPluginName) {
		// In a real scenario, the pluginName would come from the enclosing
		// named plugin. For standalone use (mainly in tests), generate a default.
		derivedPluginName = `pi-extension-${crypto.randomUUID()}`
	}

	// Accumulate flag registrations
	const flagDefaults = new Map<string, { default: unknown; description?: string }>()
	const flagSchemaProperties: Record<string, JSONSchema> = {}
	// Flush any `pi.events.emit()` calls a sync factory fires before returning.
	const pendingEmits: Promise<unknown>[] = []

	// Track conversation.created events to maintain most-recent conversation
	bh.on("conversation.created", ({ conversation }: { conversation: BHZAIConversation }) => {
		mostRecentConversation = conversation
	})

	/**
	 * Create a proxy handler for TUI-bound namespaces (ui, shortcuts, themes, session)
	 * that records each call as an unsupported warning and returns undefined.
	 */
	const makeTuiProxy = (namespace: string): Record<string, (...args: unknown[]) => unknown> => {
		return new Proxy(
			{},
			{
				get: (_target, prop) => {
					if (typeof prop === "string") {
						return (...args: unknown[]) => {
							warnings.push({
								api: `${namespace}.${prop}`,
								args,
								time: Date.now(),
							})
							return Promise.resolve(undefined)
						}
					}
					return undefined
				},
			},
		)
	}

	/**
	 * The shim ExtensionAPI object passed to the factory.
	 */
	const piApi: PiExtensionAPI = {
		// Row 1: before_agent_start -> conversation.on('start')
		// Row 2: agent_start/agent_end -> conversation.on('loop', state discriminated)
		// Row 4: input -> conversation.on('message', state=before, role=user)
		// Row 5: message_update -> conversation.on('message.delta')
		// Row 6: context -> conversation.on('context')
		// Row 7: tool_call -> conversation.on('tool', state=beforeCall)
		// Row 8: tool_result -> conversation.on('tool', state=complete/error)
		// Row 9: before_provider_request/after_provider_response -> bh.on('request')
		// Row 10: turn_start/turn_end -> conversation.on('turn')
		// Row 11: session_before_compact/session_compact -> conversation.on('compact')
		// Row 12: model_select/thinking_level_select -> bh.on('model.selected'/'model.resolve')
		// Row 13: session_start -> bh.on('conversation.created')
		// Row 15: session_shutdown -> bh.on('dispose')
		on(event: string, handler: PiHandler): void {
			switch (event) {
				case "before_agent_start": {
					// Row 1: subscribe on conversation.created, then on 'start'
					bh.on("conversation.created", ({ conversation }: { conversation: BHZAIConversation }) => {
						conversation.on("start", async (payload) => {
							const result = await handler(payload)
							return result
						})
					})
					break
				}
				case "agent_start": {
					// Row 2: loop with state=start
					bh.on("conversation.created", ({ conversation }: { conversation: BHZAIConversation }) => {
						// biome-ignore lint/suspicious/noExplicitAny: BHZAI event payloads are union types; discriminating on state field requires any
						conversation.on("loop", async (payload: any) => {
							if (payload.state === "start") {
								// Filter and dispatch; ignore return
								await handler(payload)
							}
						})
					})
					break
				}
				case "agent_end": {
					// Row 2: loop with state=end
					bh.on("conversation.created", ({ conversation }: { conversation: BHZAIConversation }) => {
						// biome-ignore lint/suspicious/noExplicitAny: BHZAI event payloads are union types; discriminating on state field requires any
						conversation.on("loop", async (payload: any) => {
							if (payload.state === "end") {
								// Filter and dispatch; ignore return
								await handler(payload)
							}
						})
					})
					break
				}
				case "input": {
					// Row 4: message with state=before, role=user
					bh.on("conversation.created", ({ conversation }: { conversation: BHZAIConversation }) => {
						// biome-ignore lint/suspicious/noExplicitAny: BHZAI event payloads are union types; discriminating on state field requires any
						conversation.on("message", async (payload: any) => {
							if (payload.state === "before" && payload.role === "user") {
								const result = await handler(payload)
								return result
							}
						})
					})
					break
				}
				case "message_update": {
					// Row 5: message.delta; translate kind='reasoning' to thinking=true
					bh.on("conversation.created", ({ conversation }: { conversation: BHZAIConversation }) => {
						// biome-ignore lint/suspicious/noExplicitAny: BHZAI event payloads are union types; discriminating on kind field requires any
						conversation.on("message.delta", async (payload: any) => {
							const piPayload = {
								...payload,
								thinking: payload.kind === "reasoning",
							}
							await handler(piPayload)
						})
					})
					break
				}
				case "context": {
					// Row 6: context event, pass through unchanged
					bh.on("conversation.created", ({ conversation }: { conversation: BHZAIConversation }) => {
						conversation.on("context", async (payload) => {
							const result = await handler(payload)
							return result
						})
					})
					break
				}
				case "tool_call": {
					// Row 7: tool with state=beforeCall
					bh.on("conversation.created", ({ conversation }: { conversation: BHZAIConversation }) => {
						// biome-ignore lint/suspicious/noExplicitAny: BHZAI tool event payloads are union types; discriminating on state field requires any
						conversation.on("tool", async (payload: any) => {
							if (payload.state === "beforeCall") {
								const result = await handler(payload)
								return result
							}
						})
					})
					break
				}
				case "tool_result": {
					// Row 8: tool with state=complete/error
					bh.on("conversation.created", ({ conversation }: { conversation: BHZAIConversation }) => {
						// biome-ignore lint/suspicious/noExplicitAny: BHZAI tool event payloads are union types; discriminating on state field requires any
						conversation.on("tool", async (payload: any) => {
							if (payload.state === "complete" || payload.state === "error") {
								const result = await handler(payload)
								return result
							}
						})
					})
					break
				}
				case "before_provider_request": {
					// Row 9: request with state=before
					bh.on("conversation.created", ({ conversation }: { conversation: BHZAIConversation }) => {
						// biome-ignore lint/suspicious/noExplicitAny: BHZAI request event payloads are union types; discriminating on state field requires any
						conversation.on("request", async (payload: any) => {
							if (payload.state === "before") {
								const result = await handler(payload)
								return result
							}
						})
					})
					break
				}
				case "after_provider_response": {
					// Row 9: request with state=after, observe-only
					bh.on("conversation.created", ({ conversation }: { conversation: BHZAIConversation }) => {
						// biome-ignore lint/suspicious/noExplicitAny: BHZAI request event payloads are union types; discriminating on state field requires any
						conversation.on("request", async (payload: any) => {
							if (payload.state === "after") {
								await handler(payload)
							}
						})
					})
					break
				}
				case "turn_start": {
					// Row 10: turn with state=start
					bh.on("conversation.created", ({ conversation }: { conversation: BHZAIConversation }) => {
						// biome-ignore lint/suspicious/noExplicitAny: BHZAI turn event payloads are union types; discriminating on state field requires any
						conversation.on("turn", async (payload: any) => {
							if (payload.state === "start") {
								await handler(payload)
							}
						})
					})
					break
				}
				case "turn_end": {
					// Row 10: turn with state=end; return may include continueWith
					bh.on("conversation.created", ({ conversation }: { conversation: BHZAIConversation }) => {
						// biome-ignore lint/suspicious/noExplicitAny: BHZAI turn event payloads are union types; discriminating on state field requires any
						conversation.on("turn", async (payload: any) => {
							if (payload.state === "end") {
								const result = await handler(payload)
								return result
							}
						})
					})
					break
				}
				case "session_before_compact": {
					// Row 11: compact with state=before
					bh.on("conversation.created", ({ conversation }: { conversation: BHZAIConversation }) => {
						// biome-ignore lint/suspicious/noExplicitAny: BHZAI compact event payloads are union types; discriminating on state field requires any
						conversation.on("compact", async (payload: any) => {
							if (payload.state === "before") {
								const result = await handler(payload)
								return result
							}
						})
					})
					break
				}
				case "session_compact": {
					// Row 11: compact with state=compacting or complete (pi doesn't distinguish)
					bh.on("conversation.created", ({ conversation }: { conversation: BHZAIConversation }) => {
						// biome-ignore lint/suspicious/noExplicitAny: BHZAI compact event payloads are union types; discriminating on state field requires any
						conversation.on("compact", async (payload: any) => {
							if (payload.state === "compacting" || payload.state === "complete") {
								await handler(payload)
							}
						})
					})
					break
				}
				case "model_select": {
					// Row 12: model.selected event
					bh.on("model.selected", async (payload) => {
						await handler(payload)
					})
					break
				}
				case "thinking_level_select": {
					// Row 12: treating as alias to model.resolve (best-effort for reasoning level)
					bh.on("model.resolve", async (payload) => {
						const result = await handler(payload)
						return result
					})
					break
				}
				case "session_start": {
					// Row 13: conversation.created
					bh.on("conversation.created", async (payload) => {
						await handler(payload)
					})
					break
				}
				case "session_shutdown": {
					// Row 15: dispose
					bh.on("dispose", async (payload) => {
						await handler(payload)
					})
					break
				}
				// Note: 'idle' (row 3) is explicitly NOT mapped per task spec
				// (it's a blocking method in pi, not an event)
				default:
					// Unknown pi event; log but don't throw
					console.warn(`[pi-adapter] Unknown event type: ${event}`)
			}
		},

		registerTool(def: PiToolDef): void {
			// Row (registerTool mapping): accept pi tool def, map to BHZAI
			bh.addTool({
				name: def.name,
				description: def.description,
				inputSchema: def.parameters, // pi's parameters -> BHZAI's inputSchema
				execute: async (invocation: ToolInvocation) => {
					// Wrap pi-shaped execute into BHZAI's ToolInvocation shape
					return (await def.execute(invocation.params, {
						conversation: invocation.conversation,
						signal: invocation.signal,
						progress: invocation.progress,
						// biome-ignore lint/suspicious/noExplicitAny: pi tools may return anything; normalizeToolResult handles conversion
					})) as any
				},
			})
		},

		registerCommand(def: PiCommandDef): void {
			// Row (registerCommand mapping): pi command -> BHZAI command
			bh.addCommand(def.name, {
				description: def.description,
				// biome-ignore lint/suspicious/noExplicitAny: pi handler signature compatible with BHZAI command handler
				handler: def.handler as any,
				complete: def.getArgumentCompletions, // pi's getArgumentCompletions -> BHZAI's complete
			})
		},

		registerFlag<T>(name: string, opts: { default: T; description?: string }): void {
			// Row (registerFlag mapping): accumulate into schema, declare after factory runs
			flagDefaults.set(name, opts)

			// Build JSON Schema properties from the default's type
			const typeStr = typeof opts.default
			const schemaType =
				typeStr === "boolean"
					? "boolean"
					: typeStr === "number"
						? "number"
						: typeStr === "string"
							? "string"
							: "string" // default fallback

			flagSchemaProperties[name] = {
				type: schemaType,
				default: opts.default,
				...(opts.description && { description: opts.description }),
			}
		},

		getFlag<T>(name: string): T {
			// Row (getFlag mapping): read from BHZAI config, fall back to registered default
			const flagDef = flagDefaults.get(name)
			if (!flagDef) {
				throw new Error(`Flag "${name}" not registered`)
			}

			// Try to get from BHZAI config; if bh.init() hasn't run yet, config will be undefined
			try {
				const config = bh.getConfig(derivedPluginName) as Record<string, unknown> | undefined
				if (config && name in config) {
					return config[name] as T
				}
			} catch {
				// getConfig may throw if called before init(); fall through to default
			}

			// Return registered default
			return flagDef.default as T
		},

		async sendMessage(
			content: string,
			options?: { deliverAs?: "immediate" | "steer" | "followUp" },
		): Promise<unknown> {
			// Row 14: sendMessage drives the loop
			if (!mostRecentConversation) {
				throw new Error("No active conversation for pi.sendMessage")
			}
			return mostRecentConversation.sendMessage(content, {
				deliverAs: options?.deliverAs,
			})
		},

		async sendUserMessage(
			content: string,
			options?: { deliverAs?: "immediate" | "steer" | "followUp" },
		): Promise<unknown> {
			// Row 14: sendUserMessage does NOT drive the loop (per § 11.1)
			if (!mostRecentConversation) {
				throw new Error("No active conversation for pi.sendUserMessage")
			}
			return mostRecentConversation.addMessage(content, "user", {})
		},

		events: {
			on(name: string, handler: (payload: unknown) => void): void {
				// Row 16: custom events, auto-prefix un-namespaced names
				const fullName = name.includes(".") ? name : `${derivedPluginName}.${name}`
				bh.on(fullName, (payload) => {
					handler(payload)
				})
			},
			emit(name: string, payload: unknown): void {
				// Row 16: custom events, auto-prefix un-namespaced names
				const fullName = name.includes(".") ? name : `${derivedPluginName}.${name}`
				pendingEmits.push(bh.emit(fullName, payload))
			},
		},

		// TUI-bound stubs: all recorded as no-ops
		ui: makeTuiProxy("ui"),
		shortcuts: makeTuiProxy("shortcuts"),
		themes: makeTuiProxy("themes"),
		session: makeTuiProxy("session"),
	}

	// Run the factory with the shim API
	await factory(piApi)
	// Ensure any synchronous pi.events.emit() calls have drained before the
	// adapter call returns.
	await Promise.all(pendingEmits)

	// After factory runs, declare the config schema if any flags were registered
	if (Object.keys(flagSchemaProperties).length > 0) {
		bh.declareConfig(derivedPluginName, {
			type: "object",
			properties: flagSchemaProperties,
		})
	}

	return { warnings }
}
