// Core kernel barrel — populated by later tasks (kernel types, BHZAI class,
// Conversation, event bus, decorators; see ARCHITECTURE.md §§ 6-11).
//
// ENVIRONMENT BOUNDARY (§ 5): files under src/core/** depend only on web-standard
// APIs (fetch, AbortController, ReadableStream/async iterables, crypto.randomUUID,
// structuredClone). No Node built-ins, no DOM, no imports from src/plugins/**.
export {
	BHZAI,
	type BHZAIHostOptions,
	type BHZAIPlugin,
	type BHZAIPluginCapabilities,
	type BHZAIPluginFactory,
	type BHZAIPluginLike,
	type ConfigChangedPayload,
	type ModelAddedPayload,
	type ModelChangedPayload,
	type ModelRemovedPayload,
	type ModelsChangedPayload,
	type PluginContributions,
	type PluginStatus,
} from "./bhzai.js"
export { CommandRegistry } from "./commands.js"
// Open message-field contract — plugin-declared accessors over `message.meta`.
export {
	applyMessageFields,
	MessageFieldRegistry,
	type MessageFieldDefinition,
	type ResolvedMessageField,
} from "./message-fields.js"
export {
	EventBus,
	type BlockSignal,
	type DispatchOptions,
	type Handler,
} from "./event-bus.js"
export {
	BHZAI_PLUGIN_META,
	Plugin,
	On,
	Tool,
	type BHPlugin,
	type PluginMetadata,
	type ToolRegistrar,
} from "./decorators.js"
// TASK_0015: MCP integration — `bh.addMcp()` + getMcps/modelSource hooks.
export {
	McpRegistry,
	type McpAttachedPayload,
	type McpClientFactory,
	type McpClientLike,
	type McpHandle,
	type ResolvedGetMcpsHook,
	type ResolvedModelSourceHook,
	resolveGetMcpsHooks,
	resolveModelSourceHooks,
} from "./mcp-integration.js"
// TASK_0023: Conversation surface — the primary object hosts and plugins interact with.
// Note: BHZAIConversation interface is exported from types/index.ts (via types/tool.ts);
// only the implementation class is exported here.
export {
	BHZAIConversationImpl,
	type CreateConversationOptions,
	type ConversationSnapshot,
} from "../conversation/conversation.js"
// TASK_0030: Steering — deliverAs queue modes and ConversationBusyError.
export { ConversationBusyError } from "../conversation/agent-loop.js"
// TASK_0028: Conversation serialization contract — versioned snapshots and round-trip semantics.
// Snapshot shape, version policy, and reconstruction from storage.
export {
	type PlainMessage,
	toPlainMessage,
	toSnapshot,
	fromSnapshot,
} from "../conversation/snapshot.js"
// The canonical message factory — every BHZAIMessage in the system is built here.
export {
	createMessage,
	withMessageFields,
	type CreateMessageInit,
	type CreateMessageOptions,
} from "../conversation/message.js"
// Streaming `<think>` tag splitter, backing `CreateConversationOptions.parseThink`.
export {
	createThinkSplitter,
	type ThinkDelta,
	type ThinkSplitter,
} from "../conversation/think-stream.js"
// TASK_0024: System-prompt layering and start-event firing.
export {
	computePreContextSystemPrompt,
	ensureStarted,
	type MessageInit,
} from "../conversation/system-prompt.js"
// TASK_0029: Storage interfaces and kernel wiring — conversation persistence,
// agent memory, and skill resolution. Auto-save on message(sent) + bh.conversations.list().
export {
	type ConversationsAccessor,
	createConversationsAccessor,
	resolveActiveConversationStore,
	wireAutoSave,
} from "./storage.js"
// TASK_0031: Compaction pipeline — context-window summarization and folding.
export {
	type CompactOptions,
	type CompactEventPayload,
	runCompactionPipeline,
	type CompleteFn,
} from "../conversation/compaction.js"
// TASK_0032: One-shot LLM utility — `bh.complete()` for plugins needing autonomous calls.
export {
	complete,
	type CompleteRequest,
	type CompleteResult,
} from "./complete.js"
// TASK_0033: Embedding side channel — `bh.embed()` for RAG plugins.
export {
	embed,
	type EmbedRequest,
	type EmbedResult,
} from "./embed.js"
// TASK_0022: Model selection & switching — catalogue merge, resolution order, ambiguity handling.
export {
	AmbiguousModelError,
	ModelNotFoundError,
	NoModelError,
	ModelUnavailableError,
	parseModelRef,
	resolveModelRef,
	listModels,
	resolveConversationModel,
	setModel,
	type ResolveConversationModelOptions,
	type ConversationModelState,
	type SetModelResult,
	type ModelSelectedPayload,
} from "./models.js"
