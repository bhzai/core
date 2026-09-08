// Public types barrel for BHZAI's cross-cutting shared types (TASK_0002).
//
// Re-exports every type declared under src/types/. Downstream tasks
// (TASK_0003 kernel, TASK_0008 tool registry, TASK_0009 drivers, TASK_0023
// conversation) import from here or from the root package barrel
// (`@bhzai/core`), which re-exports this file.
//
// This barrel is types only — no runtime logic lives anywhere under src/types/.
export type { CallToolResult, ContentBlock, JSONSchema } from "./content.js"
export type {
	BHZAIMessage,
	BHZAIMessageExtensions,
	ConversationStatus,
	ToolCallRecord,
} from "./message.js"
export type {
	DriverCapabilities,
	ModelInfo,
	Usage,
} from "./model.js"
export type { EmitResult, Unsubscribe } from "./events.js"
export type {
	BHZAIDriver,
	ChatRequest,
	DriverEvent,
	GenerationParams,
	ToolWireDefinition,
} from "./driver.js"
// Tool types were not landed by TASK_0002 before TASK_0008 started; TASK_0008
// added them in `./tool.js` on TASK_0002's behalf (see the coordination note
// at the top of that file). Re-exported here so the barrel stays the single
// import point for downstream tasks.
export type {
	BHZAIToolDefinition,
	Icon,
	ToolAnnotations,
	ToolExecute,
	ToolFilter,
	ToolInvocation,
} from "./tool.js"
// Command types were not landed by TASK_0002 before TASK_0010 started; TASK_0010
// added them in `./command.js` on TASK_0002's behalf (see the coordination note
// at the top of that file). Re-exported here so the barrel stays the single
// import point for downstream tasks.
export type {
	BHZAICommandContext,
	BHZAICommandDefinition,
} from "./command.js"
// MCP types were not landed by TASK_0002 before TASK_0011 started; TASK_0011
// added `McpServerConfig` in `./mcp.js` on TASK_0002's behalf (see the
// coordination note at the top of that file). Re-exported here so the barrel
// stays the single import point for downstream tasks. TASK_0015 (the public
// `bh.addMcp()` entry point) consumes this type.
export type { McpServerConfig } from "./mcp.js"
// Storage types were added by TASK_0029: ConversationStore, MemoryStore,
// SkillResolver interfaces plus their supporting shapes (ConversationSummary,
// MemoryRecord, SkillInfo). These are re-exported from the types barrel for
// uniform access by plugins and hosts.
export type {
	ConversationStore,
	ConversationSummary,
	MemoryStore,
	MemoryRecord,
	SkillResolver,
	SkillInfo,
} from "./storage.js"
