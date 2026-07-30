// BHZAI kernel class — the framework entry point (ARCHITECTURE.md § 6).
//
// Scope of THIS file: the constructor and `use()` (TASK_0003, plugin forms 1
// & 2; form 3 added by TASK_0007), `on()`/`emit()` (TASK_0004), `init()`/
// `dispose()` lifecycle (TASK_0005), and the plugin-configuration contract
// (TASK_0006, § 7.4 — `declareConfig`/`setConfig`/`getConfig` plus the
// validation-and-defaulting step inside `init()`). Every other § 6 method is
// stubbed with a `// TODO(TASK_XXXX)` comment naming the owning task; calling
// a stub throws so accidental use surfaces immediately rather than silently
// no-op'ing.
//
// ENVIRONMENT BOUNDARY (§ 5): this file uses only web-standard APIs.
// `crypto.randomUUID()` is the only external surface touched, and it is
// available in every supported runtime (browsers, Node ≥ 19, Deno, Bun).
// `ajv` (the JSON Schema validator used by TASK_0006's config step) is a
// pure-JS dependency with no environment-specific bindings, so importing it
// here does not violate the "web-standard APIs only" rule — it runs
// identically in every supported runtime.
//
// PATH NOTE: TASK_0003 specifies `bhzai/src/kernel/bhzai.ts`, but the package
// layout already established by TASK_0002 places the kernel under
// `src/core/` (see `src/core/index.ts` and the `./core` subpath export in
// `package.json`). This file follows the existing repo convention to keep
// one kernel directory; the behavioral contract is unchanged.

import Ajv, { type ErrorObject } from "ajv"
import {
	type BHZAIConversation,
	BHZAIConversationImpl,
	type ConversationSnapshot,
	type CreateConversationOptions,
} from "../conversation/conversation.js"
import { ToolRegistry } from "../tools/registry.js"
import type { JSONSchema } from "../types/content.js"
import type { EmitResult, Unsubscribe } from "../types/events.js"
import type {
	BHZAICommandDefinition,
	BHZAIDriver,
	BHZAIToolDefinition,
	ConversationStore,
	McpServerConfig,
	MemoryStore,
	ModelInfo,
	SkillResolver,
	ToolExecute,
	ToolFilter,
} from "../types/index.js"
import { CommandRegistry } from "./commands.js"
import { type ToolRegistrar, getPluginMetadata } from "./decorators.js"
import { DriverRegistry } from "./drivers.js"
import { type DispatchOptions, EventBus, type Handler } from "./event-bus.js"
import {
	type McpAttachedPayload,
	type McpClientFactory,
	type McpClientLike,
	type McpHandle,
	McpRegistry,
	type ResolvedGetMcpsHook,
	type ResolvedModelSourceHook,
	resolveGetMcpsHooks,
	resolveModelSourceHooks,
} from "./mcp-integration.js"
import { type MessageFieldDefinition, MessageFieldRegistry } from "./message-fields.js"
import {
	type ConversationsAccessor,
	createConversationsAccessor,
	resolveActiveConversationStore,
	wireAutoSave,
} from "./storage.js"

// `ajv` is chosen as the JSON Schema validator for TASK_0006's config step
// (§ 7.4) over alternatives (zod-to-JSON-Schema bridges, a hand-rolled
// minimal validator) because:
//  - it directly validates JSON Schema, the dialect BHZAI already standardizes
//    on for tool `inputSchema`/`outputSchema` (§ 9.1, 2020-12 dialect);
//  - it is widely used and battle-tested in the JS/TS ecosystem;
//  - it needs no schema-authoring-library lock-in (unlike zod, which would
//    require plugin authors to learn a second schema DSL just for config).
// This is a RETROACTIVE runtime dependency addition: TASK_0001's scaffolding
// anticipated only dev tooling. `ajv` is therefore declared in
// `package.json` under `dependencies` (not `devDependencies`) by TASK_0006,
// and is noted as such in the task's commit/PR description rather than
// silently introduced as if it had always been there.

/**
 * Host-supplied constructor options for {@link BHZAI}.
 *
 * All fields are stored verbatim by this task and acted on only by later
 * tasks — see the per-field comments. Nothing here is validated or resolved
 * in TASK_0003.
 */
export interface BHZAIHostOptions {
	/**
	 * Per-plugin configuration values, keyed by plugin name (§ 7.4). Each entry
	 * is equivalent to calling `bh.setConfig(pluginName, values)` before
	 * `bh.init()` runs. Wired up fully by TASK_0006.
	 */
	config?: Record<string, Record<string, unknown>>
	/** Qualified `'<driver>/<model>'` ref. Wired up by TASK_0009 / TASK_0023. */
	defaultModel?: string
	/** Base system prompt injected into conversation preambles (TASK_0023 / § 11.6). */
	systemPrompt?: string
}

/**
 * Payload of the `config.changed` framework event (§ 7.4 closing bullet).
 *
 * `config.*` is a reserved namespace prefix (TASK_0004's reserved list), so
 * this event is fired through the bus's internal `dispatch()` bypass, never
 * via the public `emit()`. It fires only when `setConfig()` is called AFTER
 * `bh.init()` has completed — pre-init `setConfig()` calls merely accumulate
 * initial values and do not constitute a "change" to a live config.
 */
export interface ConfigChangedPayload {
	/** The plugin whose config was updated. */
	pluginName: string
	/** The plugin's new merged (host-supplied + defaulted) config values. */
	values: Record<string, unknown>
}

/**
 * Payload of the `model.added` framework event.
 *
 * Dispatched once for every model that appears in the merged catalogue.
 */
export interface ModelAddedPayload {
	/** The driver id that owns this model. */
	driver: string
	/** The model catalogue entry that was added. */
	model: ModelInfo
}

/**
 * Payload of the `model.changed` framework event.
 *
 * Dispatched when a model already in the catalogue changes capabilities,
 * availability, label, or meta.
 */
export interface ModelChangedPayload {
	/** The driver id that owns this model. */
	driver: string
	/** The new model catalogue entry. */
	model: ModelInfo
	/** The previous model catalogue entry. */
	previous: ModelInfo
}

/**
 * Payload of the `model.removed` framework event.
 *
 * Dispatched once for every model that disappears from the merged catalogue.
 */
export interface ModelRemovedPayload {
	/** The driver id that owned this model. */
	driver: string
	/** The model catalogue entry that was removed. */
	model: ModelInfo
}

/**
 * Payload of the `models.changed` framework event.
 *
 * Dispatched once after all `model.added`/`model.changed`/`model.removed`
 * events for a single catalogue refresh have been dispatched.
 */
export interface ModelsChangedPayload {
	/** Models that were added. */
	added: ModelInfo[]
	/** Models that were removed. */
	removed: ModelInfo[]
	/** Models that changed, with previous and current values. */
	changed: { model: ModelInfo; previous: ModelInfo }[]
}

/**
 * A bare factory function — plugin form 1 (§ 7.2, pi style).
 *
 * The function IS the plugin's `setup`: it runs immediately at `use()` time,
 * receives the {@link BHZAI} instance, and registers whatever capabilities it
 * needs by calling kernel methods on that instance.
 */
export type BHZAIPluginFactory = (bh: BHZAI) => void | Promise<void>

/**
 * A capability object — plugin form 2 (§ 7.2, OpenCode style).
 *
 * Each key is a well-known hook; keys outside this allowlist are rejected
 * synchronously at `use()` time so typos like `initalize` fail fast.
 *
 * SCOPE NOTE: the owning tasks for `tools`, `getMcps`, `auth`, `retriever`,
 * `skillResolver`, `conversationStore`, and `memoryStore` have not landed
 * yet, so those fields are typed loosely (`unknown` / `unknown[]`) here
 * rather than blocking on their real types. Narrowing each field is the
 * owning task's job when it lands — it refines the type, not this file's
 * structure. The allowlist only needs to recognize the *presence* of these
 * keys, which it does regardless of their value type.
 */
export interface BHZAIPluginCapabilities {
	name?: string
	initialize?: (ctx: { bh: BHZAI }) => void | Promise<void>
	dispose?: (ctx: { bh: BHZAI }) => void | Promise<void>
	/** Refined to `ModelInfo[]` once TASK_0009 lands; `unknown[]` for now. */
	modelSource?: () => Promise<unknown[]>
	/** Refined to `McpServerConfig[]` once TASK_0015 lands. */
	getMcps?: () => Promise<unknown[]>
	/** Tool definitions declared by this plugin. Registered via `bh.addTool()` during `init()`. */
	tools?: BHZAIToolDefinition[]
	/** Refined to `Record<string, BHZAICommandDefinition>` once TASK_0010 lands. */
	commands?: Record<string, BHZAICommandDefinition>
	/** Declares host-supplied plugin configuration (§ 7.4); validated by TASK_0006. */
	configSchema?: JSONSchema
	/** Refined to `CredentialResolver` once TASK_0015 / § 10.4 lands. */
	auth?: unknown
	/** Refined once the § 11.8 RAG task lands. */
	retriever?: unknown
	/** Refined by TASK_0029 (§ 11.4): skill-resolver for '/slash' prompt expansion. */
	skillResolver?: SkillResolver
	/** Refined by TASK_0029 (§ 11.4): conversation-store for auto-save on message(sent). */
	conversationStore?: ConversationStore
	/** Refined by TASK_0029 (§ 11.4): memory-store for durable agent memory. */
	memoryStore?: MemoryStore
}

/**
 * Anything `use()` accepts — form 1 (factory), form 2 (capability object),
 * or form 3 (a `@Plugin`-decorated class instance, § 7.2 lines 282-316).
 *
 * `BHPlugin` is an empty marker interface (see `decorators.ts`), so
 * structurally it is satisfied by any object — the union therefore does not
 * narrow the type, but it documents that decorated instances are a legal
 * `use()` input. Form-3 instances are detected at runtime by
 * `getPluginMetadata()` reading the {@link BHZAI_PLUGIN_META} symbol stamped
 * by `@Plugin`, not by TypeScript's structural typing.
 */
export type BHZAIPluginLike =
	| BHZAIPluginFactory
	| BHZAIPluginCapabilities
	| import("./decorators.js").BHPlugin

/**
 * The canonical internal shape every plugin form normalizes to (§ 7.1).
 *
 * The rest of the kernel only ever sees this interface, so it never needs to
 * special-case which form a plugin arrived in. `capabilities` is preserved
 * for later tasks (lifecycle, config, tools) to read hook fields off the
 * original capability object without re-deriving them.
 */
export interface BHZAIPlugin {
	/** Unique name; duplicate `use()` calls with the same name are ignored. */
	name: string
	/** Runs immediately at `use()` time (§ 7.3 step 1). */
	setup(bh: BHZAI): void | Promise<void>
	/** Original capability object (form 2 only); preserved for later tasks. */
	capabilities?: BHZAIPluginCapabilities
}

/** Keys a form-2 capability object may carry (§ 7.2). Any other key is rejected. */
const ALLOWED_CAPABILITY_KEYS: ReadonlySet<string> = new Set([
	"name",
	"initialize",
	"dispose",
	"modelSource",
	"getMcps",
	"tools",
	"commands",
	"configSchema",
	"auth",
	"retriever",
	"skillResolver",
	"conversationStore",
	"memoryStore",
])

/**
 * Keys of `index` owned by `owner`, in insertion (registration) order. Used to
 * turn the kernel's reverse ownership indexes back into the per-plugin forward
 * view {@link PluginStatus} reports.
 */
function keysOwnedBy(index: Map<string, string>, owner: string): string[] {
	const out: string[] = []
	for (const [key, value] of index) {
		if (value === owner) out.push(key)
	}
	return out
}

/**
 * Everything a single plugin contributed to the kernel's registries, as
 * reported by {@link BHZAI.listPlugins}.
 *
 * Only *attributed* contributions appear here — see {@link BHZAI.runAs} for the
 * one case where a plugin's registration can land unattributed.
 */
export interface PluginContributions {
	/** Tool names registered by this plugin, including MCP-discovered ones. */
	readonly tools: readonly string[]
	/** '/slash'-command names registered by this plugin. */
	readonly commands: readonly string[]
	/** Driver ids registered by this plugin. */
	readonly drivers: readonly string[]
	/** MCP server names attached by this plugin. */
	readonly mcpServers: readonly string[]
	/** How many event handlers this plugin registered via `bh.on()`. */
	readonly eventHandlers: number
}

/** One registered plugin's activation state and contributions (§ 7). */
export interface PluginStatus {
	/** The plugin's name, as normalized at `use()` time. */
	name: string
	/** `false` only after an explicit {@link BHZAI.disablePlugin}. Defaults to `true`. */
	enabled: boolean
	/** What this plugin contributed. All-empty for a plugin that registered nothing. */
	contributions: PluginContributions
}

/**
 * BHZAI is the kernel class — the framework entry point every host
 * instantiates and every plugin registers itself onto.
 *
 * TASK_0003 implements only the constructor and {@link BHZAI.use}. Every
 * other method from § 6 is stubbed below with a `// TODO(TASK_XXXX)` comment
 * naming the task that implements it; calling a stub throws.
 */
export class BHZAI {
	/** Host options, stored verbatim. Acted on only by later tasks. */
	private readonly options: BHZAIHostOptions

	/**
	 * Registered plugins in `use()` order. Order matters for `init()`/`dispose()`
	 * (§ 7.3), so this is an array, not a map. Names are also indexed in
	 * `registeredNames` for O(1) duplicate detection.
	 */
	private readonly plugins: BHZAIPlugin[] = []

	/** Names already registered, for idempotent-by-name `use()` (§ 7.1). */
	private readonly registeredNames: Set<string> = new Set()

	/**
	 * Monotonic counter used to give unnamed form-1 factories a stable,
	 * instance-unique suffix in their auto-generated name. Combined with
	 * `crypto.randomUUID()` so two `BHZAI` instances in the same process can
	 * never collide.
	 */
	private unnamedCounter = 0

	/**
	 * Guards against double-`init()` (see {@link BHZAI.init}'s documented
	 * assumption). Set to `true` on first successful entry; a second call
	 * returns immediately without re-running hooks or re-firing the
	 * `initialize` framework event.
	 */
	private initialized = false

	/**
	 * Tracks whether this BHZAI instance has been disposed (TASK_0035).
	 * Set to `true` after all teardown steps complete in `dispose()`.
	 * Used by `assertNotDisposed()` to reject further use after teardown.
	 */
	private disposed = false

	/**
	 * Registry of live conversations (TASK_0035). Every conversation created
	 * via `createConversation()` or `loadConversation()` is added here.
	 * At `dispose()` time, each is aborted and awaited until idle.
	 */
	private readonly liveConversations: Set<BHZAIConversation> = new Set()

	/**
	 * The framework event bus (§ 8). All `on()`/`emit()` calls delegate here.
	 * The kernel fires reserved-name events (`initialize`/`dispose`/`error`)
	 * through the bus's internal `dispatch()` bypass, which skips the public
	 * reserved-name check. One bus per kernel instance; TASK_0023 adds a
	 * second per `Conversation`, reusing the same `EventBus` class.
	 */
	private readonly bus: EventBus = new EventBus()

	// ---------------------------------------------------------------------------
	// Plugin configuration state (TASK_0006, § 7.4).
	//
	// Two maps keyed by plugin name: declared schemas (from the `configSchema`
	// capability key or `declareConfig()` — both populate the same map) and
	// host-supplied values (from the constructor `config` option and
	// `setConfig()` calls). At `init()` time the two are merged + validated +
	// defaulted into `resolvedConfig`, which is what `getConfig()` returns.
	// The kernel never persists any of this — it stays storage-free per § 7.4.
	// ---------------------------------------------------------------------------

	/**
	 * Schemas declared by plugins, keyed by plugin name. Populated either by
	 * `use()` reading a form-2 capability object's `configSchema` key, or by
	 * `declareConfig()` from inside a plugin's `setup()`/`initialize()` body.
	 * Both paths write into this same map so the validation step has one place
	 * to read from.
	 */
	private readonly configSchemas: Map<string, JSONSchema> = new Map()

	/**
	 * Host-supplied config values, keyed by plugin name. Populated from the
	 * constructor `config` option (at construction time) and from
	 * `setConfig()` (which shallow-merges into any existing entry — see
	 * `setConfig`'s assumption comment). Pre-init calls accumulate; post-init
	 * calls additionally fire `config.changed`.
	 */
	private readonly configValues: Map<string, Record<string, unknown>> = new Map()

	/**
	 * Validated + defaulted config per plugin, populated by the validation
	 * step inside `init()`. `getConfig()` reads from here and throws if
	 * `init()` has not yet completed (no validated value exists yet).
	 */
	private readonly resolvedConfig: Map<string, Record<string, unknown>> = new Map()

	/**
	 * The tool registry (§ 9.2) — the single in-process store for every callable
	 * tool BHZAI knows about. Wired up by TASK_0008; backs `addTool`/
	 * `removeTool`/`listTools` and the {@link toolRegistrar} seam. Fires
	 * `tool.registered`/`tool.removed` (§ 8.1) through the framework
	 * {@link EventBus}.
	 */
	private readonly toolRegistry: ToolRegistry = new ToolRegistry(this.bus)

	/**
	 * The {@link ToolRegistrar} seam exposed to decorator-generated `setup()`
	 * functions (TASK_0007, § 7.2 form 3). `@Tool`-decorated methods register
	 * against this object via `bh.toolRegistrar.register(...)`.
	 *
	 * TASK_0008 wires this to the real {@link ToolRegistry}: `register(...)`
	 * delegates to `toolRegistry.register(...)`, which funnels through
	 * `addTool`'s sugar form (defaulting `description` to `''`). The
	 * `ToolRegistrar` interface in `decorators.ts` is unchanged — only the
	 * backing implementation swapped from the temporary in-memory stub to the
	 * real registry.
	 */
	readonly toolRegistrar: ToolRegistrar = {
		register: (toolDef) => {
			this.toolRegistry.register(toolDef)
			// Attribute here too, not just in `addTool`: `@Tool`-decorated methods
			// (form 3) reach the registry through this seam and would otherwise be
			// unowned, making decorated plugins the one form that cannot be
			// deactivated.
			this.attribute(this.toolOwners, toolDef.name)
		},
	}

	/**
	 * The driver registry (§ 10.1) — the kernel-side store of model-provider
	 * drivers. Wired up by TASK_0009; backs `addDriver`/`listModels`. Fires
	 * `driver.registered` (§ 8.1) through the framework {@link EventBus}. The
	 * `modelSource` plugin-hook half of `listModels()`'s merge is TASK_0015's
	 * responsibility — see the seam comment inside {@link DriverRegistry.listModels}.
	 */
	private readonly driverRegistry: DriverRegistry = new DriverRegistry(this.bus)

	/**
	 * The '/slash'-command registry (§ 6) — the kernel-side store of
	 * host-invocable commands. Wired up by TASK_0010; backs `addCommand` and
	 * the internal `listCommands()` accessor. Has NO event-bus integration:
	 * § 8.1 defines no `command.registered`/`command.removed` event pair, so
	 * this registry is a pure storage structure (see {@link CommandRegistry}).
	 */
	private readonly commandRegistry: CommandRegistry = new CommandRegistry()

	/**
	 * The MCP registry (§ 6 line 215, § 9.3) — the kernel-side store of
	 * attached MCP server handles. Wired up by TASK_0015; backs
	 * `addMcp()` and the `getMcps` hook resolver. Fires `mcp.attached`
	 * (§ 8.1) through the framework {@link EventBus}. The actual
	 * `McpClient` constructor is injected by the MCP plugin during `setup()`
	 * via {@link McpRegistry.registerClientFactory}, so the kernel never
	 * imports from `src/plugins/mcp/` (per `.claude/rules/packaging.md`
	 * rule 1 — "Core imports nothing optional").
	 */
	private readonly mcpRegistry: McpRegistry = new McpRegistry(this.bus, this.toolRegistry)

	// ---------------------------------------------------------------------------
	// Plugin activation (§ 7) — ownership ledger + enabled/disabled state.
	//
	// Deactivating a plugin means hiding everything it contributed, so the kernel
	// has to know which plugin contributed what. The registries are deliberately
	// origin-agnostic (see `src/tools/AGENTS.md`), so the attribution lives HERE,
	// in reverse indexes keyed by the same key each registry uses. Each registry
	// is then handed a predicate (see the constructor) and filters its own read
	// paths without learning anything about plugins.
	//
	// Reverse indexes are the single source of truth; `listPlugins()` walks them
	// to build the forward per-plugin view on demand. Keeping a second forward
	// map in sync would only create a way for the two to disagree.
	// ---------------------------------------------------------------------------

	/** Plugins explicitly deactivated. Absence means enabled — that is the default. */
	private readonly disabledPlugins: Set<string> = new Set()

	/** tool name → owning plugin. Tools absent from this map are unowned. */
	private readonly toolOwners: Map<string, string> = new Map()

	/** command name → owning plugin. */
	private readonly commandOwners: Map<string, string> = new Map()

	/** driver id → owning plugin. */
	private readonly driverOwners: Map<string, string> = new Map()

	/** MCP server name → owning plugin. */
	private readonly mcpOwners: Map<string, string> = new Map()

	/** plugin name → number of event handlers it registered via `bh.on()`. */
	private readonly eventHandlerCounts: Map<string, number> = new Map()

	/**
	 * Plugin-declared message fields — the open message contract. Backs
	 * {@link defineMessageField} and is read by the conversation layer's message
	 * factory, which installs one accessor per registered field on every
	 * message it builds. Seeded in the constructor with the built-in `think`
	 * field (see {@link CreateConversationOptions.parseThink}).
	 */
	private readonly messageFields: MessageFieldRegistry = new MessageFieldRegistry()

	/**
	 * `modelSource` hook results, kept per contributing plugin rather than as one
	 * flat list so a deactivated plugin's models can drop out of `listModels()`.
	 * `owner` is `undefined` for a hook whose plugin could not be determined.
	 */
	private readonly modelSourceContributions: Array<{
		owner: string | undefined
		models: ModelInfo[]
	}> = []

	/**
	 * Cached view of the last merged model catalogue used for diffing.
	 * Updated by {@link syncModelEvents} before any events are dispatched.
	 */
	private modelSnapshot: ModelInfo[] = []

	/**
	 * Guard against re-entrant catalogue syncs (e.g. a model event handler
	 * that calls `listModels()`).
	 */
	private syncingModels = false

	/**
	 * The plugin currently being set up or initialized. Every registration made
	 * while this is set is attributed to that plugin.
	 *
	 * ASSUMPTION — the precise scope of this ambient window. It is exact for:
	 *   - anything registered synchronously inside a form-1 factory's body, and
	 *   - the ENTIRE awaited duration of a form-2 `initialize` hook, because
	 *     `init()` awaits hooks strictly sequentially and nothing else touches
	 *     the kernel in between.
	 * It does NOT cover one case: a form-1 factory that registers after its own
	 * first `await`. `use()` deliberately does not await `setup()` (§ 7.3 step 1),
	 * so the window closes when the factory first suspends, and a later
	 * registration lands unattributed. Such a registration is treated as
	 * host-owned and is never gated — which is the safe direction to fail, since
	 * it means a plugin can at worst leave something switched permanently on,
	 * never silently break an unrelated host registration. Plugins that register
	 * asynchronously should wrap the registration in {@link runAs}.
	 *
	 * MCP attachment does not rely on this window at all — `addMcp()` registers
	 * its tools after an `await`, so attribution there is reported explicitly by
	 * `resolveGetMcpsHooks`'s `onAttached` callback instead.
	 */
	private attributionScope: string | undefined

	/**
	 * Accessor for conversation-store operations (TASK_0029, § 11.4).
	 *
	 * Populated during `bh.init()` with a {@link ConversationsAccessor} that delegates
	 * to the active `ConversationStore` (if registered), or throws a descriptive error
	 * if no store is present. The error-on-missing-store policy is intentional: a host
	 * calling `list()` with no store almost certainly has a configuration bug.
	 *
	 * Currently exposes only `list(query?)`, which delegates to `store.list()`.
	 * Future tasks may extend this with `load()`, `delete()`, etc.
	 */
	private conversationsAccessor: ConversationsAccessor = {
		list: () => Promise.reject(new Error("bh.init() has not completed yet")),
	}

	/** Public read-only accessor for the conversations API. */
	get conversations(): ConversationsAccessor {
		return this.conversationsAccessor
	}

	constructor(options?: BHZAIHostOptions) {
		this.options = options ?? {}
		// Hand every registry a view onto activation state. Each registry filters
		// its own read paths; none of them learns what a plugin is.
		this.toolRegistry.setActivePredicate((name) => this.isOwnerActive(this.toolOwners.get(name)))
		this.commandRegistry.setActivePredicate((name) =>
			this.isOwnerActive(this.commandOwners.get(name)),
		)
		this.driverRegistry.setActivePredicate((id) => this.isOwnerActive(this.driverOwners.get(id)))
		this.bus.setOwnerActivePredicate((owner) => this.isOwnerActive(owner))
		// The built-in `think` field. Registered unconditionally (not gated on
		// `parseThink`) because message fields are installed at construction
		// time, long before any conversation and its options exist — and because
		// `message.think` must keep reading a persisted `meta.think` on a
		// conversation reloaded from a snapshot, whatever this run's options say.
		this.messageFields.define("think")
		// Seed host-supplied config values from the constructor option. Each
		// entry is equivalent to a pre-init `setConfig(pluginName, values)`
		// call — last-write-wins per top-level key is irrelevant here since
		// each plugin name appears at most once in the constructor option.
		if (this.options.config) {
			for (const [pluginName, values] of Object.entries(this.options.config)) {
				this.configValues.set(pluginName, { ...values })
			}
		}
	}

	/**
	 * Register a plugin (§ 7). Accepts form 1 (bare factory function), form 2
	 * (capability object), or form 3 (a `@Plugin`-decorated class instance,
	 * TASK_0007).
	 *
	 * Normalizes any form into the canonical {@link BHZAIPlugin} shape, runs
	 * `setup()` immediately (§ 7.3 step 1), and returns `this` for chaining.
	 * Idempotent per *explicit* plugin name: a second `use()` with the same
	 * `name` is a silent no-op (its `setup`/capabilities are never
	 * registered). Unnamed form-1 factories each get a distinct auto-name
	 * and are never treated as duplicates.
	 *
	 * **Security**: Plugins run with the host's full privileges and are not sandboxed.
	 * Hosts must gate what they `use()` — the framework provides no sandbox.
	 */
	use(plugin: BHZAIPluginLike): this {
		this.assertNotDisposed()
		const normalized = this.normalize(plugin)
		if (this.registeredNames.has(normalized.name)) {
			// § 7.1: duplicate use() with the same name is ignored. Do not
			// run setup, do not merge capabilities, do not throw — just bail.
			return this
		}
		this.plugins.push(normalized)
		this.registeredNames.add(normalized.name)
		// TASK_0006 (§ 7.4): a form-2 capability object may declare a
		// `configSchema`. Record it in the schema map at use() time so the
		// init()-time validation step has every declared schema available
		// regardless of when the plugin was registered. `declareConfig()`
		// (form-1 factories, which have no capability object) populates this
		// same map from inside `setup()`/`initialize()`.
		if (normalized.capabilities?.configSchema) {
			this.configSchemas.set(normalized.name, normalized.capabilities.configSchema)
		}
		// § 7.3 step 1: setup() runs immediately at use() time. We do not
		// await it; full async-ordering guarantees are TASK_0005's concern.
		// For form 1, `setup` IS the factory, so this is the call that
		// actually runs the user's plugin body. For form 2, `setup` is a
		// no-op stub (capability hooks run at init()/dispose() time, not now).
		//
		// `runAs` opens the attribution window so everything the factory
		// registers is credited to this plugin. Because we do not await, the
		// window closes when the factory first suspends — see the ASSUMPTION on
		// `attributionScope`.
		this.runAs(normalized.name, () => {
			void normalized.setup(this)
		})
		return this
	}

	// ---------------------------------------------------------------------------
	// Plugin activation (§ 7).
	// ---------------------------------------------------------------------------

	/**
	 * Whether `owner`'s contributions are currently live. Unowned contributions
	 * (`owner === undefined`) are always live: they belong to the host, not to
	 * any plugin, so nothing can switch them off.
	 */
	private isOwnerActive(owner: string | undefined): boolean {
		if (owner === undefined) return true
		return !this.disabledPlugins.has(owner)
	}

	/**
	 * Reactivate a previously deactivated plugin. Idempotent — enabling an
	 * already-enabled plugin does nothing.
	 *
	 * Reactivation is instant and cannot fail: nothing was ever unregistered, so
	 * there is no setup to re-run and no I/O to retry. See
	 * {@link disablePlugin} for what "deactivated" does and does not cover.
	 *
	 * @throws {Error} if no plugin named `name` has been registered.
	 */
	enablePlugin(name: string): this {
		this.assertRegistered("enablePlugin", name)
		this.disabledPlugins.delete(name)
		// A plugin's drivers and modelSource contributions are now visible again;
		// refresh the catalogue so any resulting changes emit model lifecycle events.
		this.refreshModels()
		return this
	}

	/**
	 * Deactivate a registered plugin: its tools, '/slash'-commands, drivers,
	 * models, MCP-discovered tools and event handlers all stop being visible and
	 * stop running, kernel-wide, until {@link enablePlugin} is called.
	 *
	 * Deactivation is REVERSIBLE and REGISTRATION-PRESERVING. Nothing is torn
	 * down; every read path simply skips the plugin's contributions. Two
	 * consequences worth being explicit about:
	 *
	 *   - An MCP server the plugin attached STAYS CONNECTED. Its transport is
	 *     live, re-sync keeps running, and server-initiated traffic keeps
	 *     arriving — only its tools stop being listed and callable. Genuine
	 *     detachment needs per-plugin teardown (TASK_0035), which does not exist
	 *     yet; inventing it here would also make re-enabling a plugin an I/O
	 *     operation that can fail, which `enablePlugin` deliberately is not.
	 *   - A driver the plugin registered stays registered; its models just stop
	 *     appearing in `listModels()`.
	 *
	 * A plugin's `initialize`/`dispose` hooks are NOT re-run by either direction
	 * of the toggle — `dispose()` remains the whole-kernel teardown path.
	 *
	 * @throws {Error} if no plugin named `name` has been registered. This is
	 *   deliberately stricter than `use()`'s silent duplicate-name no-op and
	 *   `removeTool()`'s silent missing-name no-op: those two are idempotent
	 *   "already in the requested state" operations, whereas disabling a name
	 *   that does not exist is a request that cannot be satisfied — almost
	 *   always a typo, and exactly the failure mode `ALLOWED_CAPABILITY_KEYS`
	 *   exists to catch early.
	 */
	disablePlugin(name: string): this {
		this.assertRegistered("disablePlugin", name)
		this.disabledPlugins.add(name)
		// A plugin's drivers and modelSource contributions are now hidden;
		// refresh the catalogue so any resulting removals emit model lifecycle events.
		this.refreshModels()
		return this
	}

	/**
	 * Whether `name` is currently active. Unregistered names report `false`
	 * rather than throwing — this is a query, not a state change, and "is that
	 * plugin contributing right now?" has a truthful answer for a name that was
	 * never registered.
	 */
	isPluginEnabled(name: string): boolean {
		if (!this.registeredNames.has(name)) return false
		return !this.disabledPlugins.has(name)
	}

	/**
	 * Every registered plugin, in `use()` registration order, with its activation
	 * state and the contributions attributed to it.
	 *
	 * This is the read side of the activation interface — the kernel fires no
	 * `plugin.enabled`/`plugin.disabled` events, because § 8.1 defines no such
	 * rows and this codebase does not invent events the spec omits (see
	 * `commands.ts`'s matching note on `command.registered`). Hosts that need to
	 * render plugin state read it from here.
	 */
	listPlugins(): PluginStatus[] {
		return this.plugins.map((plugin) => ({
			name: plugin.name,
			enabled: !this.disabledPlugins.has(plugin.name),
			contributions: {
				tools: keysOwnedBy(this.toolOwners, plugin.name),
				commands: keysOwnedBy(this.commandOwners, plugin.name),
				drivers: keysOwnedBy(this.driverOwners, plugin.name),
				mcpServers: keysOwnedBy(this.mcpOwners, plugin.name),
				eventHandlers: this.eventHandlerCounts.get(plugin.name) ?? 0,
			},
		}))
	}

	/**
	 * Run `fn` with every registration it makes attributed to `pluginName`.
	 *
	 * The escape hatch for the one gap in ambient attribution documented on
	 * {@link attributionScope}: a plugin that registers asynchronously, after
	 * its `setup()` has already returned, wraps the registration in this so its
	 * contributions are still gated with the rest of the plugin's.
	 *
	 * Restores the previous scope on the way out (including on throw), so nesting
	 * is safe. Only registrations made SYNCHRONOUSLY inside `fn` are attributed —
	 * this is the same synchronous window `setup()` gets, not a fix for it.
	 */
	runAs<T>(pluginName: string, fn: () => T): T {
		const previous = this.attributionScope
		this.attributionScope = pluginName
		try {
			return fn()
		} finally {
			this.attributionScope = previous
		}
	}

	/** Shared guard for the two state-changing activation methods. */
	private assertRegistered(method: string, name: string): void {
		if (!this.registeredNames.has(name)) {
			throw new Error(`bh.${method}(): no plugin named "${name}" is registered`)
		}
	}

	/**
	 * Record `key` in `index` as owned by the plugin currently in scope. A no-op
	 * outside any plugin scope, which is what leaves host-level registrations
	 * unowned and therefore permanently active.
	 */
	private attribute(index: Map<string, string>, key: string): void {
		if (this.attributionScope !== undefined) {
			index.set(key, this.attributionScope)
		}
	}

	// ---------------------------------------------------------------------------
	// Stubs for every other § 6 method. Each throws so accidental use fails
	// loudly instead of silently no-op'ing. Implemented by the cited task.
	// ---------------------------------------------------------------------------

	/**
	 * Register a handler for `event` on the framework bus (§ 8.1). Returns an
	 * {@link Unsubscribe} that removes it. Handlers run in registration order
	 * (§ 8.2 rule 1). Any event name — including reserved kernel names like
	 * `initialize`/`dispose`/`error` — may be subscribed to; only the public
	 * {@link BHZAI.emit} restricts which names a plugin may fire.
	 *
	 * Implemented by TASK_0004 as a thin delegation to the internally-owned
	 * {@link EventBus} instance.
	 */
	on<Payload>(event: string, handler: Handler<Payload>): Unsubscribe {
		const owner = this.attributionScope
		if (owner !== undefined) {
			this.eventHandlerCounts.set(owner, (this.eventHandlerCounts.get(owner) ?? 0) + 1)
		}
		return this.bus.on(event, handler, owner)
	}

	/**
	 * Emit a namespaced custom event on the framework bus (§ 8.4). Throws
	 * synchronously (before dispatch begins) if `event` is a reserved kernel
	 * name or an un-namespaced custom name. Special case (TASK_0031): `emit('compact', ...)`
	 * always throws with a clear message, since compaction is conversation-scoped
	 * and cannot be triggered from the framework level. Use `conversation.emit('compact', ...)`
	 * instead. Resolves with an {@link EmitResult} after the dispatch and any
	 * re-entrantly queued dispatches have settled.
	 *
	 * Implemented by TASK_0004 as a thin delegation to the internally-owned
	 * {@link EventBus} instance.
	 */
	emit<Payload>(
		event: string,
		payload: Payload,
		options?: DispatchOptions,
	): Promise<EmitResult<Payload>> {
		// Compaction is conversation-scoped (TASK_0031) — throw on framework-level emit
		if (event === "compact") {
			throw new Error(
				"bh.emit('compact', ...): compaction is conversation-scoped — call conversation.emit('compact', ...) instead (TASK_0031)",
			)
		}
		return this.bus.emit(event, payload, options)
	}

	/**
	 * Runs plugin `initialize` hooks (in `use()`-registration order), then the
	 * `initialize` framework event (§ 7.3 step 2).
	 *
	 * ASSUMPTION (undocumented in ARCHITECTURE.md § 7.3): calling `init()` a
	 * second time is a no-op. Hooks do not re-run and the `initialize` event
	 * does not re-fire. This was chosen over "throw on double-init" or
	 * "re-run everything" because idempotent `init()` is the least surprising
	 * behavior for hosts that might call `init()` defensively (e.g. before
	 * every conversation creation) without tracking whether it already ran.
	 */
	async init(): Promise<void> {
		if (this.initialized) {
			return
		}
		this.initialized = true

		// TASK_0040 (issue #6): Register tools declared in capability-object form.
		// This happens at the START of init(), before running initialize hooks,
		// so a plugin's initialize hook can already call bh.listTools() and expect
		// its own declared tools to be visible.
		for (const plugin of this.plugins) {
			const toolDefs = plugin.capabilities?.tools
			if (toolDefs && Array.isArray(toolDefs)) {
				// `runAs` so declared tools are attributed to their plugin exactly
				// like imperatively-registered ones. Without it, the `tools:` key
				// would be the one registration path producing ungatable tools.
				this.runAs(plugin.name, () => {
					for (const toolDef of toolDefs) {
						this.addTool(toolDef as BHZAIToolDefinition)
					}
				})
			}
		}

		for (const plugin of this.plugins) {
			const hook = plugin.capabilities?.initialize
			if (hook) {
				// Attribute everything this hook registers to its plugin. Unlike the
				// `setup()` window in `use()`, this one is exact even for an async
				// hook: hooks are awaited strictly sequentially here, so nothing else
				// can register while `attributionScope` is set.
				const previous = this.attributionScope
				this.attributionScope = plugin.name
				try {
					await hook({ bh: this })
				} finally {
					this.attributionScope = previous
				}
			}
		}

		// TASK_0006 (§ 7.4): validate + default plugin config HERE — after all
		// `initialize` hooks have run (a plugin's `initialize` hook might be
		// what calls `declareConfig()` for a form-1 factory plugin, so schemas
		// may not all be registered until this point) and BEFORE the
		// `initialize` framework event fires below. This matches § 8.5's
		// overall "hooks → resolution → event" sequencing pattern: config
		// resolution is a resolution step, so it sits with the other
		// resolution steps (modelSource/getMcps below) between hooks and the
		// event. Throws synchronously (rejecting the init() promise) on the
		// first schema violation, with a path-qualified message.
		this.resolveAllConfig()

		// TASK_0015 (§ 8.5 step 2): resolve `modelSource`/`getMcps` hooks
		// here, in registration order, merging results into the
		// tool/driver/MCP registries. Per § 8.5, this resolution happens
		// AFTER all `initialize` hooks have run and BEFORE the `initialize`
		// framework event fires below. `getMcps` hooks attach MCP servers
		// via `addMcp()` (emitting `mcp.attached` and one `tool.registered`
		// per discovered tool); `modelSource` hooks contribute `ModelInfo[]`
		// entries merged into `bh.listModels()` alongside the driver
		// registry's catalogue. Partial-failure: if any hook throws or any
		// `addMcp()` rejects, the whole `init()` rejects (consistent with
		// TASK_0009's `DriverRegistry.listModels()` partial-failure
		// assumption).
		const getMcpsHooks: ResolvedGetMcpsHook[] = []
		const modelSourceHooks: ResolvedModelSourceHook[] = []
		for (const plugin of this.plugins) {
			const caps = plugin.capabilities
			if (caps?.getMcps) {
				getMcpsHooks.push({
					getMcps: caps.getMcps as () => Promise<McpServerConfig[]>,
					owner: plugin.name,
				})
			}
			if (caps?.modelSource) {
				modelSourceHooks.push({
					modelSource: caps.modelSource as () => Promise<ModelInfo[]>,
					owner: plugin.name,
				})
			}
		}
		// Resolve modelSource hooks first so the merged catalogue is ready
		// before any getMcps-attached server's sampling routing might query
		// it (a sampling-capable server could be attached by a getMcps hook
		// and immediately issue a sampling/createMessage request — rare, but
		// ordering modelSource first is the safe choice).
		// The `onResolved`/`onAttached` callbacks record which plugin contributed
		// what, so a later `disablePlugin()` can drop those models and MCP tools.
		// Neither resolver interprets `owner` — they only hand it back.
		await resolveModelSourceHooks(modelSourceHooks, (hook, models) => {
			this.modelSourceContributions.push({ owner: hook.owner, models })
		})
		// Refresh the merged catalogue so model lifecycle events fire for
		// driver-reported models and `modelSource` contributions before the
		// `initialize` framework event is dispatched.
		await this.listModels()
		await resolveGetMcpsHooks(getMcpsHooks, this.mcpRegistry, undefined, (hook, handle) => {
			this.attributeMcp(hook.owner, handle)
		})

		// TASK_0029 (§ 11.4): Wire up conversation-store auto-save and initialize
		// the conversations accessor. This happens after all hook resolution so the
		// active store (if any) is known, and before the `initialize` event fires
		// so any handler can already call `bh.conversations.list()`.
		const activeConversationStore = resolveActiveConversationStore(this.plugins)
		wireAutoSave(this, activeConversationStore)
		this.conversationsAccessor = createConversationsAccessor(activeConversationStore)

		await this.bus.dispatch("initialize", { bh: this })
	}

	/**
	 * Create a new conversation (ARCHITECTURE.md § 11.1).
	 *
	 * Behavior per § 8.5 step 3:
	 * 1. Construct a new `BHZAIConversationImpl` (fresh `id`, empty `messages`,
	 *    `status: 'idle'`, `meta: {}`, `usage: { inputTokens: 0, outputTokens: 0 }`).
	 * 2. Determine whether a model is already known: if `options?.model` is set,
	 *    OR this `BHZAI` instance was constructed with a `defaultModel`, the
	 *    conversation has an explicit/default model and `model.resolve` must NOT
	 *    fire. Otherwise, fire `model.resolve` with payload
	 *    `{ catalogue, conversation }` (obtain `catalogue` via `listModels()`,
	 *    which is already implemented). Await the result — a handler may return
	 *    `{ model }` to pick one.
	 * 3. Fire `conversation.created` (via the shared mirroring mechanism) with
	 *    payload `{ conversation }`.
	 * 4. Return the conversation.
	 */
	async createConversation(options?: CreateConversationOptions): Promise<BHZAIConversation> {
		this.assertNotDisposed()
		// Step 1: Construct the conversation with fresh state
		const conversation = new BHZAIConversationImpl(this, options)

		// Step 2: Determine model and fire model.resolve if needed
		const explicitModel = options?.model ?? this.options.defaultModel
		if (!explicitModel) {
			// No explicit/default model — fire model.resolve
			const catalogue = await this.listModels()
			const modelResolveResult = await this.bus.dispatch("model.resolve", {
				catalogue,
				conversation,
			})
			// If a handler returned a model patch, apply it
			if (modelResolveResult.patch && "model" in modelResolveResult.patch) {
				conversation._setResolvedModel(modelResolveResult.patch.model as string | undefined)
			}
		} else {
			// Explicit or default model provided — set it directly
			conversation._setResolvedModel(explicitModel)
		}

		// Step 3: Fire conversation.created via the shared mirroring mechanism
		await conversation._fireCreated()

		// Step 4: Register in live conversation tracking (TASK_0035)
		this.liveConversations.add(conversation)

		// Step 5: Return the conversation
		return conversation
	}

	/**
	 * Load a conversation from a snapshot (ARCHITECTURE.md § 11.3).
	 *
	 * For this task only (full contract is TASK_0028's job): accept any value
	 * loosely matching the shape `{ v?, id: string, messages: unknown[], model?, params?, usage?, meta? }`.
	 * Do a minimal presence/type check and throw a plain Error if even that loose
	 * shape doesn't hold. Do NOT implement version-migration policy, full message-
	 * shape validation, or model-re-resolution-on-missing-driver here.
	 *
	 * Behavior per § 8.5:
	 * 1. Construct a `BHZAIConversationImpl` reusing the snapshot's `id` (not a
	 *    freshly generated one), `messages` (shallow-copied), `meta` (from
	 *    snapshot, defaulting to `{}`), `usage` (from snapshot, defaulting to
	 *    zeros), `status: 'idle'`.
	 * 2. Mark the conversation as already started so TASK_0024's `ensureStarted()`
	 *    never fires `start` for a loaded conversation.
	 * 3. Determine whether the snapshot's model is still available (minimal check:
	 *    is `snapshot.model` a non-empty string that appears in `listModels()`'s
	 *    output). If unavailable, fire `model.resolve`. If available, use directly.
	 * 4. Fire `conversation.loaded` (via the shared mirroring mechanism) with
	 *    payload `{ conversation, snapshot }` — NOT `conversation.created`.
	 * 5. Return the conversation.
	 */
	async loadConversation(
		snapshot: unknown,
		options?: CreateConversationOptions,
	): Promise<BHZAIConversation> {
		this.assertNotDisposed()
		// Delegate to fromSnapshot() for full versioned reconstruction contract.
		// This replaces the loose TASK_0023 shape check with the full TASK_0028
		// contract: version validation, shape checking, message restoration,
		// model re-resolution, and proper event firing.
		const { fromSnapshot } = await import("../conversation/snapshot.js")
		const conversation = await fromSnapshot(snapshot, this, options)
		// Register in live conversation tracking (TASK_0035)
		this.liveConversations.add(conversation)
		return conversation
	}

	/**
	 * Register a tool — object form (§ 6, § 9.1). Validates `def.name`, stores
	 * the definition, and fires `tool.registered` with `{ tool: def }`.
	 *
	 * Implemented by TASK_0008 as a thin delegation to the {@link ToolRegistry}.
	 */
	addTool(def: BHZAIToolDefinition): void
	/**
	 * Register a tool — sugar form (§ 9.1 notes). `parameters` is an alias for
	 * `inputSchema`; the stored record is
	 * `{ name, description: '', inputSchema: parameters, execute }`. See
	 * {@link ToolRegistry.addTool}'s sugar-overload doc for the
	 * `description: ''` assumption.
	 */
	addTool(name: string, parameters: JSONSchema, execute: ToolExecute): void
	addTool(
		defOrName: BHZAIToolDefinition | string,
		parameters?: JSONSchema,
		execute?: ToolExecute,
	): void {
		this.assertNotDisposed()
		if (typeof defOrName === "string") {
			this.toolRegistry.addTool(defOrName, parameters as JSONSchema, execute as ToolExecute)
			this.attribute(this.toolOwners, defOrName)
		} else {
			this.toolRegistry.addTool(defOrName)
			this.attribute(this.toolOwners, defOrName.name)
		}
	}

	/**
	 * Remove a tool by name (§ 6, § 9.1). Silent no-op if the name was never
	 * registered. Fires `tool.removed` with `{ tool }` when a removal actually
	 * occurs. Implemented by TASK_0008.
	 */
	removeTool(name: string): void {
		this.toolRegistry.removeTool(name)
		// Drop the attribution too: the name is free again, and a later
		// registration under it must not inherit the old owner's activation state.
		this.toolOwners.delete(name)
	}

	/**
	 * Snapshot of registered tool definitions (§ 6, § 9.2 — semantically
	 * `tools/list`). The `filter?` parameter's full § 9.5 semantics are owned
	 * by TASK_0017's `resolveAvailableTools`; this method implements only a
	 * minimal subset (identity + name allow/deny + tag include/exclude) for
	 * signature compatibility. See {@link ToolRegistry.listTools} for the
	 * scope boundary. Implemented by TASK_0008.
	 */
	listTools(filter?: ToolFilter): BHZAIToolDefinition[] {
		return this.toolRegistry.listTools(filter)
	}

	/**
	 * Register a model-provider driver (§ 6, § 10.1). Inserts (or replaces)
	 * the entry under `driver.id` and fires `driver.registered` with
	 * `{ driver }`. Implemented by TASK_0009.
	 *
	 * After registration, the driver's `listModels()` is fetched in the
	 * background and the merged catalogue is diffed, dispatching
	 * `model.added`/`model.changed`/`model.removed` and `models.changed` for
	 * any differences.
	 */
	addDriver(driver: BHZAIDriver): void {
		this.assertNotDisposed()
		this.driverRegistry.addDriver(driver)
		this.attribute(this.driverOwners, driver.id)
		// Refresh the catalogue asynchronously. A synchronous `addDriver` is
		// required by the plugin setup contract, so the fetch and events are
		// fire-and-forget; any error is routed to the `error` framework event.
		void this.listModels().catch((err) => {
			void this.bus.dispatch("error", { error: err, source: "addDriver" })
		})
	}

	/**
	 * Merged model catalogue from every registered driver AND every
	 * `modelSource` plugin hook (§ 6 line 189: "merged: drivers +
	 * modelSource hooks").
	 *
	 * TASK_0009 implemented the driver half; TASK_0015 adds the
	 * `modelSource` hook half. The hook results are resolved once during
	 * `bh.init()` (§ 8.5 step 2) and cached on the instance; this method
	 * concatenates the driver registry's `listModels()` output with the
	 * cached hook results. NO de-duplication is performed (consistent with
	 * `DriverRegistry.listModels()`'s no-de-duplication convention).
	 *
	 * If `bh.init()` has not yet run, `modelSource` hooks have not been
	 * resolved, so only the driver half is returned (no error — a host may
	 * legitimately call `listModels()` pre-init to inspect driver models).
	 *
	 * Every successful call diff's the new catalogue against the cached
	 * `modelSnapshot` and dispatches `model.added`, `model.changed`,
	 * `model.removed`, and `models.changed` for any differences.
	 */
	async listModels(): Promise<ModelInfo[]> {
		if (this.syncingModels) {
			return this.modelSnapshot
		}
		const next = await this.computeListModels()
		await this.syncModelEvents(next)
		return next
	}

	/**
	 * Compute the merged catalogue without side effects (no event dispatch).
	 */
	private async computeListModels(): Promise<ModelInfo[]> {
		// The driver half is already gated inside the registry by the predicate
		// installed in the constructor; the hook half is gated here, where the
		// per-plugin breakdown lives.
		const driverModels = await this.driverRegistry.listModels()
		const hookModels: ModelInfo[] = []
		for (const contribution of this.modelSourceContributions) {
			if (!this.isOwnerActive(contribution.owner)) continue
			hookModels.push(...contribution.models)
		}
		return [...driverModels, ...hookModels]
	}

	/**
	 * Refresh the merged catalogue in the background and route any error to
	 * the `error` framework event. Used by `addDriver` and plugin activation
	 * toggles, which cannot await without breaking their synchronous API.
	 */
	private refreshModels(): void {
		void this.listModels().catch((err) => {
			void this.bus.dispatch("error", { error: err, source: "model.refresh" })
		})
	}

	/**
	 * Diff `next` against `modelSnapshot` and dispatch lifecycle events.
	 *
	 * Models are keyed by their qualified `ref`. The snapshot is updated
	 * before events are dispatched so re-entrant `listModels()` calls see
	 * the new catalogue while `syncingModels` is true.
	 */
	private async syncModelEvents(next: ModelInfo[]): Promise<void> {
		if (this.syncingModels) return
		this.syncingModels = true
		try {
			const previous = this.modelSnapshot
			const prevByRef = this.indexByRef(previous)
			const nextByRef = this.indexByRef(next)

			const added: ModelInfo[] = []
			const removed: ModelInfo[] = []
			const changed: { model: ModelInfo; previous: ModelInfo }[] = []

			for (const [ref, model] of nextByRef) {
				const old = prevByRef.get(ref)
				if (!old) {
					added.push(model)
				} else if (!this.modelInfoEqual(model, old)) {
					changed.push({ model, previous: old })
				}
			}

			for (const [ref, model] of prevByRef) {
				if (!nextByRef.has(ref)) {
					removed.push(model)
				}
			}

			if (added.length === 0 && removed.length === 0 && changed.length === 0) {
				return
			}

			this.modelSnapshot = next

			for (const model of added) {
				await this.bus.dispatch("model.added", { driver: model.driver, model })
			}
			for (const change of changed) {
				await this.bus.dispatch("model.changed", {
					driver: change.model.driver,
					model: change.model,
					previous: change.previous,
				})
			}
			for (const model of removed) {
				await this.bus.dispatch("model.removed", { driver: model.driver, model })
			}
			await this.bus.dispatch("models.changed", { added, removed, changed })
		} finally {
			this.syncingModels = false
		}
	}

	/**
	 * Build a `ref → ModelInfo` map from a catalogue, keeping the first
	 * occurrence of any duplicate `ref` for event-diff purposes.
	 */
	private indexByRef(models: ModelInfo[]): Map<string, ModelInfo> {
		const map = new Map<string, ModelInfo>()
		for (const model of models) {
			if (!map.has(model.ref)) {
				map.set(model.ref, model)
			}
		}
		return map
	}

	/**
	 * Compare two `ModelInfo` values for catalogue-diff purposes.
	 */
	private modelInfoEqual(a: ModelInfo, b: ModelInfo): boolean {
		if (a.id !== b.id) return false
		if (a.driver !== b.driver) return false
		if (a.label !== b.label) return false
		if (a.availability !== b.availability) return false
		if (JSON.stringify(a.capabilities) !== JSON.stringify(b.capabilities)) return false
		if (JSON.stringify(a.meta) !== JSON.stringify(b.meta)) return false
		return true
	}

	/**
	 * Generic accessor for multi-plugin capability contributions (ARCHITECTURE.md § 11.8).
	 *
	 * Retrieves every plugin's contribution registered under a given capability-object key,
	 * in `use()`-registration order. This is a pure read-only projection over the already-stored
	 * per-plugin `capabilities` object preserved by `use()` — no new storage, no changes to
	 * `use()` itself.
	 *
	 * The mechanism is generic and reusable for any current or future capability key without
	 * adding new kernel API. Today's documented consumer is `retriever` (§ 11.8's RAG plugin),
	 * but the implementation accepts any string key, including keys not yet in the
	 * `BHZAIPluginCapabilities` type interface — runtime extensibility is the entire point
	 * (line 1460-1462 of § 11.8: "the same mechanism serves future contribution points
	 * without new kernel API").
	 *
	 * @template T The inferred type of contributions. Since contributions come from plugin
	 *   capability objects and this method is agnostic to their shape, the type is unchecked —
	 *   it is purely a call-site convenience (e.g., `bh.getContributions<Retriever>('retriever')`
	 *   documents intent to the reader, but does not validate the runtime value's shape).
	 * @param key The capability-object key to query. Even keys not in `BHZAIPluginCapabilities`'s
	 *   named field list work identically at runtime (e.g., a future capability key a plugin
	 *   ecosystem adds without modifying this kernel will still be retrievable).
	 * @returns An array of all contributions under that key, in registration order. Empty
	 *   array if zero plugins have defined a value for that key, or if that key is unknown.
	 *   Never returns `undefined` and never throws — unknown/unregistered keys degrade gracefully
	 *   to an empty result rather than an error.
	 */
	getContributions<T>(key: string): T[] {
		const results: T[] = []
		for (const plugin of this.plugins) {
			// Type escape hatch needed because `key` is a runtime string, but
			// `BHZAIPluginCapabilities` is a static interface with named optional fields.
			// The whole purpose of this method is to accept arbitrary (including future)
			// keys that may not yet be in the interface, so the cast is intentional and
			// narrow: it only escapes the type check for the one lookup operation, and
			// the result is narrowed back to `T` by the caller's generic parameter.
			const value = plugin.capabilities?.[key as keyof BHZAIPluginCapabilities]
			if (value !== undefined) {
				results.push(value as T)
			}
		}
		return results
	}

	/**
	 * One-shot LLM call detached from any conversation (ARCHITECTURE.md § 6).
	 *
	 * Resolves a model, sends messages, drains the response stream, returns text and usage.
	 * Fires zero conversation-bus events; only `request` lifecycle events are permitted.
	 * The substrate for plugins that need autonomous LLM calls (auto-title, summarization,
	 * memory extraction — see ARCHITECTURE.md § 11.7).
	 *
	 * Implemented by TASK_0032 as a thin delegation to the exported {@link complete}
	 * function in `src/core/complete.ts`, passing `this` (the BHZAI instance) and the
	 * host-level defaultModel as context.
	 */
	async complete(
		req: import("./complete.js").CompleteRequest,
	): Promise<import("./complete.js").CompleteResult> {
		this.assertNotDisposed()
		const { complete } = await import("./complete.js")
		return complete(this, req, this.options.defaultModel)
	}

	/**
	 * Embedding side channel — RAG substrate (ARCHITECTURE.md § 6, § 11.8).
	 *
	 * Resolves a model, checks that the driver declares `embeddings: true` capability,
	 * and delegates to `driver.embed()` to produce vectors. Fires zero conversation-bus
	 * events; intended as a portable, driver-agnostic indexing substrate for RAG plugins.
	 *
	 * Implemented by TASK_0033 as a thin delegation to the exported {@link embed}
	 * function in `src/core/embed.ts`, passing `this` (the BHZAI instance) and the
	 * host-level defaultModel as context.
	 */
	async embed(req: import("./embed.js").EmbedRequest): Promise<import("./embed.js").EmbedResult> {
		this.assertNotDisposed()
		const { embed } = await import("./embed.js")
		return embed(this, req, this.options.defaultModel)
	}

	/**
	 * Register a '/slash'-command (§ 6). Stores `def` under `name`; a duplicate
	 * `addCommand(name, def)` call silently replaces the earlier entry under
	 * that name (last-registration-wins, consistent with TASK_0008's tools and
	 * TASK_0009's drivers). No framework event is fired — § 8.1 defines no
	 * `command.registered`/`command.removed` event pair. Implemented by
	 * TASK_0010 as a thin delegation to the {@link CommandRegistry}.
	 *
	 * The stored {@link BHZAICommandDefinition} shape is identical whether it
	 * arrives via this imperative path or via the capability-object `commands:`
	 * key (§ 7.2 line 272) resolved during `use()`/`init()` — wiring that
	 * capability-object path is TASK_0003/0005's job, not TASK_0010's.
	 */
	addCommand(name: string, def: BHZAICommandDefinition): void {
		this.assertNotDisposed()
		this.commandRegistry.addCommand(name, def)
		this.attribute(this.commandOwners, name)
	}

	/**
	 * Snapshot of registered commands as `{ name, def }` entries (§ 6 —
	 * reasonable addition beyond the literal spec text, parallel to
	 * `listTools()`). Used by tests and by future host-integration tasks to
	 * enumerate available commands (e.g. to build a `/`-prefix autocomplete
	 * menu). Implemented by TASK_0010.
	 */
	listCommands(): Array<{ name: string; def: BHZAICommandDefinition }> {
		return this.commandRegistry.listCommands()
	}

	/**
	 * Declare a message field — the open message contract.
	 *
	 * Installs a named accessor on every {@link BHZAIMessage} this instance
	 * builds. The accessor reads and writes a single key inside the message's
	 * `meta` bag, so a plugin gets `message.myField` ergonomics while the value
	 * is stored (and persisted) through the existing `meta` channel that already
	 * round-trips via `toPlainMessage`/`fromSnapshot`.
	 *
	 * Accessors are non-enumerable, so they never leak into `JSON.stringify` or
	 * a conversation snapshot's wire shape.
	 *
	 * Pair this with a type-level declaration so the field typechecks:
	 *
	 * ```ts
	 * declare module "@bhzai/core" {
	 *   interface BHZAIMessageExtensions {
	 *     sentiment?: "positive" | "negative"
	 *   }
	 * }
	 *
	 * bh.defineMessageField("sentiment")
	 * ```
	 *
	 * Call it from a plugin's `setup()` or `initialize` hook. Fields registered
	 * after messages already exist do not retroactively appear on them.
	 *
	 * NOT SUBJECT TO PLUGIN ACTIVATION (the one registration path that isn't —
	 * deliberate, not an oversight). A message field is a *data-shape* contract,
	 * not a behavior: the accessor only exposes a key that already lives in
	 * `meta` and already round-trips through snapshots. Dropping the accessor
	 * when its plugin is disabled would make `message.myField` read `undefined`
	 * on messages whose `meta.myField` is populated — silently changing how
	 * already-persisted conversations deserialize, and breaking re-enabling as a
	 * pure no-op. This is the same reasoning that registers the built-in `think`
	 * field unconditionally (see the constructor). Gate the plugin's *handlers*
	 * instead; the field stays.
	 *
	 * @param name       Property name to expose on every message.
	 * @param definition Backing `meta` key and default-value overrides.
	 * @throws Error on a reserved name (`content`, `meta`, `append`, …) or a
	 *         duplicate registration.
	 */
	defineMessageField(name: string, definition?: MessageFieldDefinition): void {
		this.assertNotDisposed()
		this.messageFields.define(name, definition)
	}

	/**
	 * The message-field registry, for the conversation layer's message factory.
	 *
	 * @internal
	 */
	_getMessageFields(): MessageFieldRegistry {
		return this.messageFields
	}

	/**
	 * Register an `McpClient` constructor factory (TASK_0015). Called by the
	 * MCP plugin's `setup()` hook so the kernel can instantiate MCP clients
	 * without importing from `src/plugins/mcp/` (per the packaging rule
	 * "Core imports nothing optional"). Until this is called, `addMcp()`
	 * refuses with a clear error.
	 *
	 * NOT part of § 6's named method list — this is an internal seam the MCP
	 * plugin uses during `setup()`. Hosts do not call it directly.
	 */
	registerMcpClientFactory(factory: McpClientFactory): void {
		this.mcpRegistry.registerClientFactory(factory)
	}

	/**
	 * Attach an MCP server (§ 6 line 215, § 9.3). Constructs an `McpClient`
	 * via the factory registered by the MCP plugin, awaits `connect()`
	 * (handshake + discovery), and returns an {@link McpHandle} for advanced
	 * host access. Fires the `mcp.attached` framework event (§ 8.1) with
	 * `{ server, tools }`.
	 *
	 * Implemented by TASK_0015 as a thin delegation to {@link McpRegistry}.
	 *
	 * @param config   The server config (url, headers, name, deferred, trusted).
	 * @param options  Opaque options forwarded to the `McpClient` constructor
	 *                 (approval gate, capabilities, driver registry, event
	 *                 bus, callTimeoutMs). Typed as `unknown` so the kernel
	 *                 does not depend on the plugin's option types.
	 */
	async addMcp(config: McpServerConfig, options?: unknown): Promise<McpHandle> {
		this.assertNotDisposed()
		// Capture the scope BEFORE awaiting: `attributionScope` is a synchronous
		// ambient window and does not survive the await below.
		const owner = this.attributionScope
		const handle = await this.mcpRegistry.addMcp(config, options)
		this.attributeMcp(owner, handle)
		return handle
	}

	/**
	 * Attribute an attached MCP server — and every tool its discovery registered
	 * — to `owner`. A no-op when `owner` is `undefined` (a host-level attach).
	 *
	 * The tools are found by the `mcp__<server>__` name prefix (the convention
	 * established in TASK_0011) rather than by watching the registry, because the
	 * MCP client writes into the shared {@link ToolRegistry} directly and the
	 * kernel never sees those individual `addTool` calls.
	 */
	private attributeMcp(owner: string | undefined, handle: McpHandle): void {
		if (owner === undefined) return
		this.mcpOwners.set(handle.serverName, owner)
		const prefix = `mcp__${handle.serverName}__`
		for (const tool of this.toolRegistry.listTools()) {
			if (tool.name.startsWith(prefix)) {
				this.toolOwners.set(tool.name, owner)
			}
		}
	}

	// ---------------------------------------------------------------------------
	// Post-dispose guard (TASK_0035)
	// ---------------------------------------------------------------------------

	/**
	 * Guard that rejects further use after `dispose()` has completed (TASK_0035).
	 *
	 * Throws `Error('BHZAI instance has been disposed')` if `this.disposed` is true.
	 * Called at the top of methods where a post-dispose call would be wrong to allow silently.
	 *
	 * @throws Error if the instance has been disposed.
	 * @internal
	 */
	private assertNotDisposed(): void {
		if (this.disposed) {
			throw new Error("BHZAI instance has been disposed")
		}
	}

	/**
	 * Tear down the BHZAI instance — abort conversations, fire `dispose` event, run plugin
	 * dispose hooks, close MCP sessions, and guard against further use.
	 *
	 * ORDERING RECONCILIATION (TASK_0035, per ARCHITECTURE.md § 8.5 and § 6):
	 * This method implements the complete teardown sequence in a fixed order:
	 * 1. Abort every in-flight conversation (stops new activity, makes status terminal)
	 * 2. Fire the `dispose` framework event (per § 8.5: "plugins' dispose hooks run after it")
	 * 3. Run plugin `dispose` hooks in reverse `use()`-registration order
	 * 4. Close every attached MCP session (gives plugins one final chance to use MCP resources)
	 * 5. Set the `disposed` flag so post-dispose calls are rejected
	 *
	 * Explicit assumption (§ 11.1): calling `abort()` is synchronous but the conversation's
	 * status reaches its terminal state asynchronously. This method calls `waitForIdle()` on
	 * each conversation after abort to ensure all cleanups have settled before proceeding
	 * to step 2.
	 */
	async dispose(): Promise<void> {
		// Step 1: Abort every live conversation and wait for each to reach terminal state or idle.
		// Explicit assumption (§ 11.1): abort() is synchronous but conversation status settling
		// to terminal state may take a microtask/tick or two. Call waitForIdle() which resolves
		// when status is idle OR when all queues are empty. However, if abort() immediately
		// sets status to 'aborted', waitForIdle() will never emit 'idle', so we also race
		// against a microtask flush to avoid indefinite hangs.
		for (const conversation of this.liveConversations) {
			conversation.abort("BHZAI instance disposed")
			// Use Promise.race with queueMicrotask to avoid hanging if status is already terminal
			await Promise.race([
				conversation.waitForIdle(),
				new Promise<void>((resolve) => queueMicrotask(resolve)),
			])
		}

		// Step 2: Fire the `dispose` framework event (BEFORE hooks, per § 8.5).
		await this.bus.dispatch("dispose", { bh: this })

		// Step 3: Run plugin `dispose` hooks in reverse registration order (already built by TASK_0005).
		for (const plugin of [...this.plugins].reverse()) {
			const hook = plugin.capabilities?.dispose
			if (hook) {
				await hook({ bh: this })
			}
		}

		// Step 4: Close every attached MCP session (via Promise.allSettled).
		const closePromises = this.mcpRegistry
			.list()
			.map((handle) => Promise.resolve().then(() => handle.client.close?.()))
		const closeResults = await Promise.allSettled(closePromises)
		const closeErrors = closeResults
			.map((result, idx) => {
				if (result.status === "rejected") {
					return {
						index: idx,
						error: result.reason,
					}
				}
				return null
			})
			.filter((e) => e !== null)

		// Step 5: Set the `disposed` flag.
		this.disposed = true

		// If any MCP close calls rejected, aggregate and throw after all have been attempted.
		if (closeErrors.length > 0) {
			const errorMessages = closeErrors
				.map(({ error }) => (error instanceof Error ? error.message : String(error)))
				.join("; ")
			throw new Error(`BHZAI.dispose(): MCP session close failed: ${errorMessages}`)
		}
	}

	// ---------------------------------------------------------------------------
	// Plugin configuration (TASK_0006, § 7.4).
	//
	// The kernel stays storage-free: it standardizes only the *contract*
	// (declare a JSON Schema, supply values, validate+default at init() time,
	// read via getConfig, notify live edits via `config.changed`). Where
	// values persist (files, env, database, UI) is the host's concern.
	// ---------------------------------------------------------------------------

	/**
	 * Imperative alternative to the `configSchema` capability key, for
	 * factory-function (form 1) plugins which have no capability object to
	 * attach `configSchema` to. Calling this from inside a plugin's
	 * `setup()`/`initialize()` body registers the schema in the same internal
	 * map the capability-key path populates, so the init()-time validation
	 * step treats both declaration channels identically (§ 7.4).
	 *
	 * Calling this after `bh.init()` has completed is allowed (a plugin may
	 * declare its schema late); the newly-declared schema is validated
	 * immediately against any already-supplied values for that plugin name and
	 * the result is stored in `resolvedConfig`, so a post-init `declareConfig`
	 * followed by `getConfig` works without a second `init()` call (which
	 * would be a no-op anyway).
	 */
	declareConfig(pluginName: string, schema: JSONSchema): void {
		this.configSchemas.set(pluginName, schema)
		// If init() has already run, resolve this plugin's config immediately
		// against whatever values have been supplied so far, so getConfig()
		// works right away without requiring a (no-op) second init() call.
		if (this.initialized) {
			this.resolveConfig(pluginName, schema)
		}
	}

	/**
	 * Host-supplied config values for a plugin, keyed by plugin name (§ 7.4).
	 *
	 * MERGE SEMANTICS (explicit assumption — the spec does not say): this
	 * shallow-merges `values` into any previously-supplied values for that
	 * plugin name at the top level (`this.configValues[pluginName] = {
	 * ...this.configValues[pluginName], ...values }`), rather than replacing
	 * them wholesale. This matches the general shallow-merge convention used
	 * elsewhere in the spec (e.g. event patches, § 8.2 rule 2) and lets a host
	 * update one config key without re-supplying every other key.
	 *
	 * If called AFTER `bh.init()` has completed, the merged values are
	 * re-validated + re-defaulted against the plugin's declared schema and the
	 * `config.changed` framework event is fired (via the bus's internal
	 * `dispatch()`, since `config.*` is a reserved namespace prefix) with
	 * `{ pluginName, values }`. Pre-init calls merely accumulate values and
	 * do NOT fire `config.changed` — they are not "changes" to a live config,
	 * just initial-value accumulation before validation runs at init() time.
	 */
	setConfig(pluginName: string, values: Record<string, unknown>): void {
		const prev = this.configValues.get(pluginName) ?? {}
		this.configValues.set(pluginName, { ...prev, ...values })
		if (this.initialized) {
			const schema = this.configSchemas.get(pluginName)
			// Only re-validate + fire `config.changed` if the plugin declared a
			// schema. A plugin with no schema has no "config" to change in the
			// § 7.4 sense — its values are just unvalidated host state.
			if (schema) {
				this.resolveConfig(pluginName, schema)
				const resolved = this.resolvedConfig.get(pluginName) ?? {}
				// `config.*` is reserved (TASK_0004's RESERVED_PREFIXES), so
				// this must go through `dispatch()` (the kernel bypass), not
				// the public `emit()`. The dispatch is fire-and-forget: the
				// spec describes `config.changed` as a notification, and
				// `setConfig` is synchronous, so we do not await it.
				void this.bus.dispatch<ConfigChangedPayload>("config.changed", {
					pluginName,
					values: resolved,
				})
			}
		}
	}

	/**
	 * Validated (and defaulted) config for a plugin (§ 7.4). Returns the
	 * merged object of host-supplied values over schema `default` keywords,
	 * after validation at `init()` time.
	 *
	 * PRECONDITION: `bh.init()` must have completed. Throws if called before
	 * that, since values are not validated/defaulted until init() runs —
	 * returning unvalidated/undefaulted raw values would silently violate the
	 * "validated during init()" contract.
	 *
	 * RETURNS `undefined` if the plugin declared no `configSchema` (explicit
	 * assumption — the spec does not spell this out): there is no schema to
	 * validate/default against, so there is no principled "resolved config" to
	 * hand back. `undefined` signals "this plugin declared no config contract"
	 * distinctly from "this plugin's config is an empty object".
	 */
	getConfig<T = unknown>(pluginName: string): T {
		if (!this.initialized) {
			throw new Error(
				`getConfig('${pluginName}') called before bh.init() completed — config is not yet validated/defaulted.`,
			)
		}
		const schema = this.configSchemas.get(pluginName)
		if (!schema) {
			// No declared schema → no resolved config. See the TSDoc assumption.
			return undefined as T
		}
		return (this.resolvedConfig.get(pluginName) ?? {}) as T
	}

	/**
	 * Validate + default one plugin's config against its declared schema and
	 * store the result in `resolvedConfig`. Throws on the first schema
	 * violation with a path-qualified message of the form
	 * `"<pluginName>.config.<propertyPath>: expected <expectedType>, got <actualType>"`.
	 *
	 * Uses `ajv` with `useDefaults: true` so schema `default` keywords are
	 * applied to absent properties during validation (step 2 of the
	 * algorithm), then a small formatter translates `ajv`'s `ErrorObject`s
	 * into the spec's exact message shape.
	 */
	private resolveConfig(pluginName: string, schema: JSONSchema): void {
		const supplied = this.configValues.get(pluginName) ?? {}
		// `useDefaults: true` fills in absent properties from schema `default`
		// keywords during validation. We validate a shallow clone so the
		// original host-supplied values are not mutated.
		const data: Record<string, unknown> = { ...supplied }
		const validate = new Ajv({ useDefaults: true, allErrors: false })
		const validator = validate.compile(schema)
		const ok = validator(data)
		if (!ok) {
			const errs = validator.errors ?? []
			throw new Error(formatAjvError(pluginName, errs, data))
		}
		this.resolvedConfig.set(pluginName, data)
	}

	/**
	 * Run {@link resolveConfig} for every declared config schema, in schema
	 * declaration order (the order schemas were inserted into `configSchemas`,
	 * which is `use()`-registration order for capability-key schemas and
	 * call order for `declareConfig()`). Called once from `init()` after all
	 * `initialize` hooks have run. Schemas with no corresponding registered
	 * plugin are still validated — a form-1 factory plugin declares its schema
	 * under an arbitrary name of its choosing (not its auto-generated plugin
	 * name), so iterating the schema map rather than the plugin list is what
	 * makes `declareConfig('factory-plugin', ...)` + `getConfig('factory-plugin')`
	 * work. Plugins/schemas with no declared schema are skipped — nothing to
	 * validate, and `getConfig()` returns `undefined` for them.
	 */
	private resolveAllConfig(): void {
		for (const [pluginName, schema] of this.configSchemas) {
			this.resolveConfig(pluginName, schema)
		}
	}

	// ---------------------------------------------------------------------------
	// Test-only accessors. These exist so TASK_0003's tests can assert internal
	// invariants (plugin count, stored options) without exposing a wider
	// public API. They are intentionally minimal and not part of § 6.
	// ---------------------------------------------------------------------------

	/** @internal Number of normalized plugin records currently registered. */
	__testPluginCount(): number {
		return this.plugins.length
	}

	/** @internal Whether a plugin with the given explicit name is registered. */
	__testHasPlugin(name: string): boolean {
		return this.registeredNames.has(name)
	}

	/** @internal Read-only view of the stored host option for a key. */
	__testOption<K extends keyof BHZAIHostOptions>(key: K): BHZAIHostOptions[K] {
		return this.options[key]
	}

	/**
	 * Internal: dispatch an event on the framework bus via the unguarded `dispatch()` path.
	 *
	 * Used by `BHZAIConversationImpl` to fire reserved framework events
	 * (e.g. `conversation.message`, `conversation.context`) that skips the
	 * public `emit()`'s reserved-name check. This is the same internal bypass
	 * the kernel uses for its own reserved-name events.
	 *
	 * @internal
	 */
	_dispatch<Payload>(
		event: string,
		payload: Payload,
		options?: DispatchOptions,
	): Promise<EmitResult<Payload>> {
		return this.bus.dispatch(event, payload, options)
	}

	/**
	 * Internal: get a registered driver by ID.
	 *
	 * Returns the driver if registered, undefined otherwise. Used by TASK_0025's
	 * agent loop to resolve a conversation's model ref to an actual driver instance.
	 *
	 * @internal
	 */
	_getDriver(driverId: string): BHZAIDriver | undefined {
		return this.driverRegistry.get(driverId)
	}

	/**
	 * Internal: get a tool definition by name.
	 *
	 * Returns the registered `BHZAIToolDefinition` or `undefined` if not found.
	 * Used by TASK_0026's agent-loop tool-execution pipeline to look up tools
	 * for validation and execution.
	 *
	 * @internal
	 */
	_getTool(name: string): BHZAIToolDefinition | undefined {
		return this.toolRegistry.get(name)
	}

	/**
	 * Internal: get the host's default system prompt.
	 *
	 * Returns the system prompt provided in the `BHZAIHostOptions` at construction,
	 * or undefined if none was provided. Used by `BHZAIConversationImpl`'s constructor
	 * to compute layer 1-2 of the system-prompt assembly.
	 *
	 * @internal
	 */
	get _hostSystemPrompt(): string | undefined {
		return this.options.systemPrompt
	}

	// ---------------------------------------------------------------------------
	// Internal normalization.
	// ---------------------------------------------------------------------------

	/**
	 * Detect which supported form `plugin` is and normalize it to a
	 * {@link BHZAIPlugin}. Throws synchronously for anything else, including
	 * capability objects with unrecognized keys.
	 *
	 * Form 3 (decorated instance, TASK_0007) is checked FIRST among the
	 * object branches: a decorated instance is also `typeof plugin ===
	 * 'object'`, so it must be detected before the generic capability-object
	 * branch — otherwise it would be misinterpreted as a plain capability
	 * object and rejected by the key-allowlist check (decorated instances do
	 * not carry `initialize`/`tools`/etc. as own enumerable keys in the
	 * capability-object sense).
	 */
	private normalize(plugin: BHZAIPluginLike): BHZAIPlugin {
		if (typeof plugin === "function") {
			return this.normalizeFactory(plugin as BHZAIPluginFactory)
		}
		if (typeof plugin === "object" && plugin !== null) {
			// Form 3 check before form 2 — see method doc.
			const meta = getPluginMetadata(plugin)
			if (meta) {
				return this.normalizeDecorated(plugin, meta)
			}
			return this.normalizeCapabilities(plugin as BHZAIPluginCapabilities)
		}
		throw new Error(
			"bh.use(): plugin must be a function, a capability object, or a @Plugin-decorated instance",
		)
	}

	/**
	 * Form 3: a `@Plugin`-decorated class instance (§ 7.2 lines 282-316,
	 * TASK_0007). Builds a `setup(bh)` that subscribes each `@On`-decorated
	 * method via `bh.on(event, method.bind(instance))` and registers each
	 * `@Tool`-decorated method via `bh.toolRegistrar.register(...)`. The
	 * resulting `{ name, setup }` is the exact same canonical shape forms 1
	 * and 2 produce — there is no separate "decorated plugin" storage path.
	 *
	 * A `@On('initialize')` method is functionally indistinguishable from a
	 * capability-object `initialize` hook once normalized: `setup` calls
	 * `bh.on('initialize', ...)`, and `'initialize'` is a reserved framework
	 * event only the kernel's `dispatch()` fires (TASK_0004), so the method
	 * receives the `initialize` event exactly when `bh.init()` fires it — no
	 * special-casing in `init()` itself.
	 */
	private normalizeDecorated(
		instance: object,
		meta: {
			name: string
			onHandlers: Array<{ methodName: string; event: string }>
			tools: Array<{ methodName: string; name: string; schema: JSONSchema }>
		},
	): BHZAIPlugin {
		const record = instance as Record<string, unknown>
		const setup = (bh: BHZAI): void => {
			for (const { methodName, event } of meta.onHandlers) {
				const fn = record[methodName]
				if (typeof fn === "function") {
					bh.on(event, fn.bind(instance) as Handler<unknown>)
				}
			}
			for (const { methodName, name, schema } of meta.tools) {
				const fn = record[methodName]
				if (typeof fn === "function") {
					bh.toolRegistrar.register({
						name,
						schema,
						execute: fn.bind(instance) as (...args: unknown[]) => unknown,
					})
				}
			}
		}
		return { name: meta.name, setup }
	}

	/** Form 1: bare factory function. Auto-generates a unique name. */
	private normalizeFactory(fn: BHZAIPluginFactory): BHZAIPlugin {
		const name = `plugin-${this.unnamedCounter}-${crypto.randomUUID()}`
		this.unnamedCounter += 1
		// `setup` IS the factory — running setup means invoking the user's
		// function with the BHZAI instance (done in `use()` above).
		return { name, setup: fn }
	}

	/**
	 * Form 2: capability object. Validates the key allowlist first (fail-fast
	 * on typos), then derives a name and a no-op `setup`. The capability
	 * hooks (`initialize`/`dispose`/etc.) are NOT invoked here — they run at
	 * `bh.init()`/`bh.dispose()` time, which is TASK_0005's job.
	 */
	private normalizeCapabilities(cap: BHZAIPluginCapabilities): BHZAIPlugin {
		for (const key of Object.keys(cap)) {
			if (!ALLOWED_CAPABILITY_KEYS.has(key)) {
				throw new Error(`bh.use(): unrecognized plugin capability key "${key}"`)
			}
		}
		const name = cap.name ?? `plugin-${this.unnamedCounter}-${crypto.randomUUID()}`
		// Only bump the counter for unnamed capability objects, so the
		// auto-name suffix stays monotonic across both forms.
		if (cap.name === undefined) {
			this.unnamedCounter += 1
		}
		// No user-supplied setup for form 2; hooks are consumed by TASK_0005+.
		const setup = (_bh: BHZAI): void => {}
		return { name, setup, capabilities: cap }
	}
}

// ---------------------------------------------------------------------------
// ajv error → spec-message formatter (TASK_0006).
//
// `ajv`'s raw `ErrorObject`s don't match the exact message shape § 7.4's
// example implies (`"<pluginName>.config.<propertyPath>: expected <expectedType>,
// got <actualType>"`). This helper translates the first error into that shape.
// It is module-local (not exported) since it is an implementation detail of
// `resolveConfig`.
// ---------------------------------------------------------------------------

/**
 * Translate the first of `ajv`'s validation errors into a path-qualified
 * message of the form `"<pluginName>.config.<propertyPath>: expected
 * <expectedType>, got <actualType>"`. Falls back to a best-effort message
 * using `ajv`'s own `message` for keywords this formatter doesn't special-case.
 */
function formatAjvError(
	pluginName: string,
	errors: ErrorObject[],
	data: Record<string, unknown>,
): string {
	const err = errors[0]
	const propertyPath = ajvInstancePathToDotPath(err.instancePath)
	const qualifiedPath = propertyPath
		? `${pluginName}.config.${propertyPath}`
		: `${pluginName}.config`

	if (err.keyword === "type") {
		const expected = formatExpectedType(err.params)
		const actual = formatActualType(lookupByPath(data, propertyPath))
		return `${qualifiedPath}: expected ${expected}, got ${actual}`
	}
	if (err.keyword === "required") {
		// `params.missingProperty` is the unqualified property name.
		const missing = (err.params as { missingProperty?: string }).missingProperty ?? "<unknown>"
		return `${pluginName}.config.${missing}: expected present, got missing`
	}
	// Best-effort fallback for any other keyword (enum, minItems, etc.).
	return `${qualifiedPath}: ${err.message ?? "validation failed"}`
}

/** Convert an `ajv` `instancePath` like `"/topK"` or `""` into `"topK"` or `""`. */
function ajvInstancePathToDotPath(instancePath: string): string {
	if (!instancePath) return ""
	// ajv paths are JSON Pointer–ish: leading "/", properties separated by "/".
	return instancePath.replace(/^\//, "").replace(/\//g, ".")
}

/**
 * Look up the value at a dot-separated path inside `data`, returning it for
 * `typeof`-based actual-type reporting. Returns `undefined` if any segment is
 * absent (which itself reports as `"undefined"`).
 */
function lookupByPath(data: Record<string, unknown>, path: string): unknown {
	if (!path) return data
	let cur: unknown = data
	for (const segment of path.split(".")) {
		if (cur && typeof cur === "object" && segment in cur) {
			cur = (cur as Record<string, unknown>)[segment]
		} else {
			return undefined
		}
	}
	return cur
}

/** Format the expected type(s) from an ajv `type` keyword's `params`. */
function formatExpectedType(params: ErrorObject["params"]): string {
	const t = (params as { type?: string | string[] }).type
	if (Array.isArray(t)) return t.join("|")
	return t ?? "unknown"
}

/** Format the actual type of a value for the error message. */
function formatActualType(value: unknown): string {
	if (value === null) return "null"
	if (Array.isArray(value)) return "array"
	return typeof value
}
