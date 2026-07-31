// Root superset barrel: re-exports the core kernel and every plugin.
// Consumers who want a minimal surface should import from '@bhzai/core/core'
// or a specific '@bhzai/core/plugins/*' entry instead.
// Tree-shaking (`sideEffects: false`) drops any re-exports a consumer does not use,
// so importing only `{ BHZAI }` from root does not pull plugin code into the bundle.
//
// Adding a new plugin means appending one `export * from './plugins/<name>/index.js';`
// line here, plus the matching `package.json` exports entry and `tsup.config.ts` entry.
export * from "./types/index.js"
export * from "./core/index.js"
export * from "./plugins/webllm/index.js"
export * from "./plugins/ollama/index.js"
export * from "./plugins/lmstudio/index.js"
export * from "./plugins/mcp/index.js"
export * from "./plugins/interop/pi/index.js"
export * from "./plugins/interop/opencode/index.js"

// Conversation primitives. Not a plugin subpath — these ship only from the root
// entry, so they are re-exported explicitly rather than via a `plugins/*` barrel.
//
// `conversation/event-bus.ts` also names its class `EventBus`, which collides
// with the framework bus re-exported from `./core` above. The core bus owns the
// unqualified name (it is the kernel-wide dispatch mechanism of ARCHITECTURE.md
// § 8); the conversation bus — a narrower emit/fold primitive backing the
// system-prompt fold — is re-exported under an explicit alias.
export { EventBus as ConversationEventBus } from "./conversation/event-bus.js"
export type { EmitHandler, FoldHandler } from "./conversation/event-bus.js"
export { Conversation } from "./conversation/system-prompt.js"
export type {
	ConversationOptions,
	ConversationPluginStatus,
	PluginActivationSource,
	ResolvedSystemPrompt,
	StartEventPatch,
	StartHandler,
} from "./conversation/system-prompt.js"
