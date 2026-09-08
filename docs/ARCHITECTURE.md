# bhzai v0.2 Architecture Specification

## Executive Summary

bhzai v0.2 is a greenfield core rewrite of the `@bhzai/core` framework built around an **"everything is a plugin"** design inspired by modern harnesses such as `deepseek-ai/deepseek-harness`.

In v0.1, the core framework grew to over 12,000 source lines characterized by architectural bloat: 53 public kernel members, multi-tier nested event buses, two distinct `Conversation` classes, an overly complex 11-layer agent loop where streaming tokens were blocked by dual event bus drains, and speculative extension points without active production consumers.

v0.2 replaces this architecture with:
1. **A minimal, privileged kernel** that only manages plugin lifecycle, dependency topology, exclusive service claiming, and reversible effects.
2. **First-class plugins** for all runtime capabilities: the agent loop, tools pipeline, LLM driver seam, session logging, context tracking, and compaction.
3. **An append-only session event log** as the single source of truth for conversation state, from which driver messages are derived as a pure projection.
4. **Usage-based context accounting** utilizing driver-reported prompt tokens as ground truth instead of character heuristics.

---

## Core Principles

The v0.2 architecture adheres to ten non-negotiable principles:

1. **One loop, one termination rule**: The agent loop has a single deterministic termination condition: when the model produces a response without requesting tool calls, the turn concludes.
2. **Minimal privileged kernel**: The kernel contains zero business logic for chat, models, or tools. It only provides plugin lifecycle, dependency ordering, service claiming, and reversible effect scopes.
3. **Everything else is a plugin**: LLM access, tools, commands, session logs, the agent loop, context accounting, and compaction are ordinary plugins.
4. **Append-only source of truth**: Session history is stored as an immutable, append-only log of typed events. Model context is a pure projection of this log. If it is visible to the model, it is logged.
5. **Single plugin authoring form**: All plugins conform to a single shape with a standard setup function, dependency declarations, and JSON-Schema configuration validation.
6. **Exclusive service claiming with pluggable backends**: A plugin claims an exclusive context key (such as `ctx.tools` or `ctx.llm`). Multiple implementations (e.g. storage engines, tokenizers) register into a claimed service rather than competing for claims.
7. **Reversible effects**: Every registration and subscription returns a disposal function. When a plugin unloads, its entire effect footprint unwinds cleanly in reverse order.
8. **Non-awaited streaming deltas**: Streaming token events are fire-and-forget notifications (`emit`), never blocking the token throughput pipeline.
9. **Usage-based context accounting**: Context occupancy is anchored to driver-reported token usage, bounding estimation drift to a single step.
10. **No speculative extension points**: Extension points exist only where an active, shipped consumer requires them.

---

## Section 1: The Context (`ctx`) and Service Claims

### The Harness Context

The kernel initializes a shared `HarnessContext` (`ctx`) instance passed to every loaded plugin during initialization. The context acts as the central registry and communication hub:

```typescript
export interface HarnessContext {
  /** The single unified event bus. */
  readonly events: EventBus;
  /** Service access registry. */
  readonly services: ServiceRegistry;
  /** Direct property accessors for claimed services. */
  readonly [key: string]: unknown;
}
```

### Claiming Services

Plugins claim top-level service namespaces on `ctx` (e.g., `ctx.tools`, `ctx.llm`, `ctx.sessions`, `ctx.agentLoop`, `ctx.commands`).

```typescript
export interface PluginContext extends HarnessContext {
  /** Claim an exclusive service namespace on the context. */
  claim<TService>(name: string, service: TService): Disposable;
}
```

#### Service Claim Invariants
1. **Exclusivity**: Claiming a service key is strictly exclusive. If plugin B attempts to claim a key already claimed by plugin A, the kernel throws `ServiceAlreadyClaimedError`.
2. **Backend Registration Pattern**: When multiple implementations must coexist (such as persistence engines for `ctx.sessions` or tokenizers for `ctx.tokenizer`), they register *into* the claimed service rather than re-claiming the top-level key:
   ```typescript
   // Allowed: registering an implementation into a claimed service
   ctx.sessions.registerBackend("indexeddb", idbBackend);
   ```
3. **TypeScript Typing via Module Augmentation**: Services extend `HarnessServices` via TypeScript declaration merging, ensuring full compile-time type safety:
   ```typescript
   declare module "@bhzai/core" {
     interface HarnessServices {
       tools: ToolService;
       llm: LlmService;
       sessions: SessionService;
       agentLoop: AgentLoopService;
       commands: CommandService;
     }
   }
   ```

### Dependency Declaration and Topological Ordering

Plugins declare dependencies by name. The kernel resolves dependencies using a directed acyclic graph (DAG) topological sort:

```typescript
export interface PluginDefinition<TConfig = unknown> {
  name: string;
  dependencies?: string[];
  configSchema?: Record<string, unknown>;
  setup(ctx: PluginContext, config?: TConfig): Promise<void | PluginTeardown> | void | PluginTeardown;
}
```

- If a declared dependency is missing, loading fails immediately with `MissingPluginDependencyError`.
- If a circular dependency is detected, loading fails immediately with `CircularPluginDependencyError`.
- Plugins load strictly in topological order and unload in exact reverse order.

### Reversible Effects and Unload Guarantees

Every mutation performed by a plugin—claiming services, registering event listeners, adding tools or commands—is tracked within a `PluginEffectScope`.

When a plugin is unloaded:
1. Custom teardown functions returned by `setup()` are executed.
2. All disposables registered via `ctx.claim()` or `ctx.events.on()` are executed in reverse order of registration.
3. The service keys claimed by the plugin are removed from `ctx`.
4. Dependent plugins that rely on the unloaded plugin are unloaded first.

---

## Section 2: The Unified Event System

v0.2 consolidates all framework communication onto a single event bus (`ctx.events`) supporting four explicit dispatch modes:

### Dispatch Modes

| Mode | Semantics | Typical Use Cases |
| :--- | :--- | :--- |
| `emit` | Non-awaited fire-and-forget broadcast. Handlers run concurrently or sequentially without delaying the caller. | Streaming token deltas, progress updates, telemetry metrics, session change notifications. |
| `waterfall` | Sequential around-middleware pipeline. Each handler receives `(value, next)` and can transform the input, wrap execution, or rewrite the output. | Request rewriting, tool argument validation, tool output filtering, prompt transformation. |
| `serial` | Sequential awaited pipeline. Handlers execute and are awaited one by one in registration order. | Turn initialization (`turn/start`), step completion, persistence flush. |
| `bail` | Sequential pipeline stopping at the first handler returning a non-undefined result. | Turn-end continuation (`continueWith`), tool approval interception, early aborts. |

### Event Bus Contract

```typescript
export interface EventBus {
  /** Subscribe a notification listener (for emit/serial). */
  on<T>(event: string, handler: (payload: T) => Promise<void> | void): Disposable;

  /** Subscribe a waterfall middleware handler. */
  waterfall<T, TCtx = unknown>(
    event: string,
    handler: (value: T, ctx: TCtx, next: (nextValue: T) => Promise<T>) => Promise<T>
  ): Disposable;

  /** Subscribe a bail handler. */
  bail<T, TResult>(
    event: string,
    handler: (payload: T) => Promise<TResult | undefined> | TResult | undefined
  ): Disposable;

  /** Dispatch a fire-and-forget notification. */
  emit<T>(event: string, payload: T): void;

  /** Dispatch a waterfall through all middleware. */
  runWaterfall<T, TCtx = unknown>(event: string, initialValue: T, context: TCtx): Promise<T>;

  /** Dispatch sequentially awaiting each handler. */
  runSerial<T>(event: string, payload: T): Promise<void>;

  /** Dispatch bail handlers until one returns a defined result. */
  runBail<T, TResult>(event: string, payload: T): Promise<TResult | undefined>;
}
```

### No Reserved-Namespace Enforcement
v0.1 enforced restrictive namespace naming rules that required artificial exemptions (such as for `compact`). v0.2 eliminates reserved-namespace enforcement. Event names follow slash-separated conventions (`turn/start`, `step/pre`, `tool/pre-execute`, `stream/delta`).

---

## Section 3: The Session Log & Message Projection

### The Invariant: "Model-Visible Means Logged"

Nothing reaches the model that is not recorded in the append-only session log. Conversely, prompt messages are never mutated directly; they are derived on demand as a pure projection from the log.

### The `SessionEvent` Union

```typescript
export type SessionEvent =
  | UserMessageEvent
  | AssistantMessageEvent
  | ToolCallEvent
  | ToolResultEvent
  | CompactionBoundaryEvent
  | ModelChangeEvent
  | CustomSessionEvent;

export interface BaseSessionEvent {
  id: string;
  sessionId: string;
  timestamp: number;
}

export interface UserMessageEvent extends BaseSessionEvent {
  type: "user_message";
  content: string | ContentPart[];
}

export interface AssistantMessageEvent extends BaseSessionEvent {
  type: "assistant_message";
  content: string;
  reasoning?: string;
  toolCalls?: ToolCallDescriptor[];
  usage?: TokenUsage;
}

export interface ToolCallEvent extends BaseSessionEvent {
  type: "tool_call";
  callId: string;
  toolName: string;
  arguments: Record<string, unknown>;
}

export interface ToolResultEvent extends BaseSessionEvent {
  type: "tool_result";
  callId: string;
  toolName: string;
  result: unknown;
  isError: boolean;
}

export interface CompactionBoundaryEvent extends BaseSessionEvent {
  type: "compaction_boundary";
  summary: string;
  compactedThroughEventId: string;
  tokensBefore: number;
  tokensAfter: number;
}

export interface ModelChangeEvent extends BaseSessionEvent {
  type: "model_change";
  modelRef: string;
}

export interface CustomSessionEvent extends BaseSessionEvent {
  type: "custom";
  source: string;
  name: string;
  data: unknown;
}
```

### Pure Projection: `deriveMessages(log)`

The projection function converts an append-only log into the standard `DriverMessage[]` vocabulary expected by model drivers:

1. **Compaction Boundaries**: If a `compaction_boundary` event exists, events prior to and including `compactedThroughEventId` are omitted from the projection. The boundary itself projects as a synthetic system message containing the history summary.
2. **Tool Pairing & Dangling Calls**: If a turn ends mid-step (due to an abort signal or failure) leaving a `tool_call` without an associated `tool_result`, `deriveMessages()` synthesizes an aborted tool result error message. This maintains API structural validity without corrupting the raw log.
3. **Reasoning Stripping**: Reasoning content is preserved in the log for telemetry and replay, but filtered or formatted according to driver capabilities during projection.

### Persistence Interface

The session service delegates storage to a pluggable `SessionPersistence` backend:

```typescript
export interface SessionPersistence {
  create(id: string, metadata?: Record<string, unknown>): Promise<void>;
  open(id: string): Promise<SessionEvent[]>;
  append(id: string, events: SessionEvent[]): Promise<void>;
  list(): Promise<SessionSummary[]>;
  delete(id: string): Promise<void>;
}
```

Two backends are provided:
- **In-memory backend**: Default, dependency-free backend for tests and ephemeral sessions.
- **IndexedDB backend**: Browser persistence ported from `idb-conversations`.

### Fork and Resume
- **Resume**: Opens the session ID, loads all events, and continues appending new events.
- **Fork**: Copies all events from an existing session log up to a specified event ID into a new session ID. Both branches continue independently.

---

## Section 4: The Turn & Step Lifecycle

Execution proceeds through two distinct scopes: **Turns** (initiated by user input) and **Steps** (model round-trips within a turn).

```
User Input
    │
    ▼
[turn/start] (serial)
    │
    ├─────────────────────────────┐
    ▼                             │ (next step)
[pre-step] (waterfall)            │
    │                             │
    ▼                             │
[request] (waterfall)             │
    │                             │
    ▼                             │
Driver Stream ──► [stream/delta] (emit, non-awaited)
    │
    ▼
Assistant Message Appended to Log
    │
    ├─ No tool calls? ──► [turn/end] (bail) ──► Turn Complete
    │                          │
    ▼ (Tool calls present)     └─ Handler returns follow-up? ──► Loop continues
For each tool call:
    [tool/pre-execute] (waterfall: approvals, validation)
    Execute Tool (timeout, abort signal)
    [tool/post-execute] (waterfall: filtering)
    Tool Result Appended to Log
    │
    └─────────────────────────────┘
```

### Lifecycle Event Specifications

1. `turn/start` (`serial`): Initializes turn telemetry, sets status to busy, logs `user_message`.
2. `pre-step` (`waterfall`):
   - Injects contributed system prompt sections.
   - Evaluates proactive compaction pressure.
   - Computes current context budget.
3. `request` (`waterfall`): Rewrites driver request parameters, headers, or active tools.
4. `stream/delta`, `stream/reasoning`, `stream/tool-call` (`emit`): Non-awaited streaming events. Dispatched synchronously to consumers without blocking stream consumption.
5. **Termination Decision**:
   - If assistant response contains **no tool calls**, turn loop terminates.
   - If assistant response contains **tool calls**, each is processed through the tool execution pipeline.
6. `tool/pre-execute` (`waterfall`): Validates parameters against JSON schema; triggers approval gates. If blocked or denied, short-circuits execution and produces a tool result error.
7. `tool/post-execute` (`waterfall`): Sanitizes, truncates, or formats tool outputs.
8. `turn/end` (`bail`): Executes turn-end checkpoints. A plugin can return a continuation input (e.g. task continuation), resuming the turn into a new step.

---

## Section 5: The Plugin Contract

v0.2 standardizes on a single authoring form. All legacy factory patterns, capability objects, and experimental TC39 stage-3 decorators are eliminated.

### The Plugin Definition

```typescript
export interface PluginDefinition<TConfig = Record<string, unknown>> {
  /** Unique plugin name. */
  name: string;

  /** Optional list of plugin names that must be loaded prior to this plugin. */
  dependencies?: string[];

  /** Optional JSON-Schema describing valid configuration options. */
  configSchema?: Record<string, unknown>;

  /**
   * Initializes the plugin.
   * @param ctx The scoped plugin context.
   * @param config Validated configuration matching configSchema.
   * @returns Optional teardown function executed upon unload.
   */
  setup(
    ctx: PluginContext,
    config?: TConfig
  ): Promise<void | PluginTeardown> | void | PluginTeardown;
}

export type PluginTeardown = () => Promise<void> | void;
```

### Configuration Validation
If `configSchema` is provided, the kernel validates user-supplied options using `ajv` before calling `setup()`. Schema validation errors throw `InvalidPluginConfigError`.

---

## Section 6: Explicitly Out of Scope for v0.2

To preserve simplicity and prevent architectural drift, the following features are explicitly out of scope:

1. **Steering and Follow-up Queues**: Concurrent inputs while the agent loop is busy are rejected with an error or queued as separate future turns.
2. **Prompt-Compaction Single-Message Summarizer**: The recursive chunked summarizer (`prompt-compaction.ts`) is dropped in favor of the single-path history compaction plugin.
3. **Legacy Interop Adapters**: Pi and OpenCode adapters (`src/plugins/interop/`) are removed from the core.
4. **Plugin Activation Toggles**: Plugins are either loaded or unloaded; dynamic mid-turn enable/disable states are removed.
5. **Complex Multi-Tier Credentials**: Replaced by direct driver options or lightweight environment resolution.
6. **Kernel `embed()` Side Channel**: The kernel complete/embed abstractions are removed. Drivers continue to expose native embedding APIs where supported.
7. **Decorators**: No `@Plugin`, `@Tool`, or `@Driver` annotations.
8. **Subagents and Multi-Agent Orchestration**: Multi-agent routing is explicitly deferred.

---

## Section 7: Compatibility Surface & Type Vocabulary

### Carried Forward from `src/types/`
The clean, web-standard core types from v0.1 remain largely intact:
- `DriverMessage`, `ContentPart`, `TextContentPart`, `ImageContentPart`
- `BHZAIDriver`, `DriverEvent`, `DriverOptions`
- `ModelRef`, `ModelDescriptor`
- `ToolWireDefinition`

All five drivers (`webllm`, `ollama`, `lmstudio`, `openai`, `vllm`) continue to implement `BHZAIDriver` without requiring wire-level changes.

### Removed from v0.1
- The `BHZAI` monolithic kernel class and second `Conversation` class.
- The dual event bus architecture (`core/event-bus.ts` and `conversation/event-bus.ts`).
- Decorators, ambient credentials resolution, and custom message fields.
- `ToolRegistry` global mutable state.

---

## Section 8: Context Tracking & Accounting

### Ground-Truth Usage Accounting

v0.1's `chars/4` heuristic is replaced with accounting anchored to model provider reports:

1. **Ground Truth**: When a driver yields a `usage` event, `usage.prompt_tokens` is stored on the session step as the authoritative context size.
2. **Reconciled Estimates**: Newly appended log entries are estimated using a standard heuristic. When the next driver `usage` event arrives, the difference between the estimated and reported tokens is reconciled across the step's entries. Estimation drift is strictly bounded to a single step.
3. **Pluggable Tokenizers**: Drivers or plugins can register high-precision tokenizers into `ctx.tokenizer` (e.g. WebLLM exposes its WASM tokenizer). If unregistered, the heuristic fallback is used.
4. **Canonical `ContextOverflowError`**: Model provider context window overflow errors are normalized into a single typed `ContextOverflowError`, enabling compaction plugins to react deterministically.

---

## Section 9: Host & Embedding API

Applications and UI wrappers embed the harness through a clean facade:

```typescript
export interface HarnessOptions {
  plugins: PluginDefinition[];
  config?: Record<string, Record<string, unknown>>;
}

export function createHarness(options: HarnessOptions): Promise<Harness>;

export interface Harness {
  readonly ctx: HarnessContext;
  createSession(options?: CreateSessionOptions): Promise<HarnessSession>;
  dispose(): Promise<void>;
}

export interface HarnessSession {
  readonly id: string;
  readonly model: string;
  setModel(modelRef: string): Promise<void>;
  send(input: string | ContentPart[], options?: SendOptions): Promise<TurnResult>;
  abort(): void;
  on(event: string, handler: (payload: unknown) => void): Disposable;
  export(): Promise<SessionExport>;
}
```

UI layers (such as the WebLLM browser demo) interact exclusively with `HarnessSession`, never manipulating plugin internals.

---

## Section 10: System-Prompt Assembly

System prompt assembly is structured as an ordered composition pipeline:

1. **Base Prompt**: The session or host specifies the initial base system instructions.
2. **Contributed Sections**: Plugins register dynamic prompt sections with an assigned priority:
   ```typescript
   ctx.prompt.contribute({
     id: "workspace-context",
     priority: 100,
     resolve: async (sessionCtx) => "Active workspace: /home/repo",
   });
   ```
3. **Deterministic Assembly**: During the `pre-step` waterfall, all active contributions are resolved, sorted by priority (lowest priority first, base instructions at root), and joined with double newlines into the final system prompt message.
