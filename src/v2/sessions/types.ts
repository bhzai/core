import type { ContentBlock } from "../../types/content"
import type { BHZAIMessage, ToolCallRecord } from "../../types/message"

/**
 * Base properties shared across all session log events.
 */
export interface BaseSessionEvent {
	/** Unique identifier of the event. */
	id: string

	/** Identifier of the session to which this event belongs. */
	sessionId: string

	/** Epoch millisecond timestamp when the event was recorded. */
	timestamp: number
}

/**
 * Event representing user input.
 */
export interface UserMessageEvent extends BaseSessionEvent {
	type: "user_message"
	content: string | ContentBlock[]
}

/**
 * Event representing an assistant response.
 */
export interface AssistantMessageEvent extends BaseSessionEvent {
	type: "assistant_message"
	content: string
	reasoning?: string
	toolCalls?: ToolCallRecord[]
	usage?: {
		promptTokens?: number
		completionTokens?: number
		totalTokens?: number
	}
}

/**
 * Event representing a tool call requested by the model.
 */
export interface ToolCallEvent extends BaseSessionEvent {
	type: "tool_call"
	callId: string
	toolName: string
	arguments: Record<string, unknown> | string
}

/**
 * Event representing the output or error returned from a tool execution.
 */
export interface ToolResultEvent extends BaseSessionEvent {
	type: "tool_result"
	callId: string
	toolName: string
	result: unknown
	isError: boolean
}

/**
 * Event representing a compaction boundary summarizing older history.
 */
export interface CompactionBoundaryEvent extends BaseSessionEvent {
	type: "compaction_boundary"
	summary: string
	compactedThroughEventId: string
	tokensBefore?: number
	tokensAfter?: number
}

/**
 * Event recording a model selection change.
 */
export interface ModelChangeEvent extends BaseSessionEvent {
	type: "model_change"
	modelRef: string
}

/**
 * Event recording custom plugin-authored metadata.
 */
export interface CustomSessionEvent extends BaseSessionEvent {
	type: "custom"
	source: string
	name: string
	data: unknown
}

/**
 * Discriminated union of all possible session events in the append-only log.
 */
export type SessionEvent =
	| UserMessageEvent
	| AssistantMessageEvent
	| ToolCallEvent
	| ToolResultEvent
	| CompactionBoundaryEvent
	| ModelChangeEvent
	| CustomSessionEvent

/**
 * Metadata summary of a persisted session.
 */
export interface SessionSummary {
	/** Unique session identifier. */
	id: string

	/** Timestamp when the session was created. */
	createdAt: number

	/** Timestamp when the session was last updated. */
	updatedAt: number

	/** Total count of events stored in the session log. */
	eventCount: number

	/** Optional metadata associated with the session. */
	metadata?: Record<string, unknown>
}

/**
 * Versioned export representation of a session.
 */
export interface SessionExport {
	/** Serialization format version. */
	version: 1

	/** Unique session identifier. */
	sessionId: string

	/** Optional session metadata. */
	metadata?: Record<string, unknown>

	/** Complete append-only event log. */
	events: SessionEvent[]

	/** Epoch timestamp of export. */
	exportedAt: number
}

/**
 * Storage backend interface for persisting session event logs.
 */
export interface SessionPersistence {
	/**
	 * Creates a new session record.
	 * @param id Unique session identifier.
	 * @param metadata Optional metadata to attach to the session.
	 */
	create(id: string, metadata?: Record<string, unknown>): Promise<void>

	/**
	 * Opens an existing session and returns its complete event log.
	 * @param id Unique session identifier.
	 */
	open(id: string): Promise<SessionEvent[]>

	/**
	 * Appends new events to the session log.
	 * @param id Unique session identifier.
	 * @param events Array of new session events.
	 */
	append(id: string, events: SessionEvent[]): Promise<void>

	/**
	 * Lists metadata summaries of all persisted sessions.
	 */
	list(): Promise<SessionSummary[]>

	/**
	 * Deletes a persisted session and its event log.
	 * @param id Unique session identifier.
	 */
	delete(id: string): Promise<void>
}

/**
 * An active session instance providing access to its append-only log and message projection.
 */
export interface Session {
	/** Unique session identifier. */
	readonly id: string

	/** Session metadata. */
	readonly metadata: Record<string, unknown>

	/** Returns a read-only view of the current event log. */
	getEvents(): readonly SessionEvent[]

	/**
	 * Appends one or more events to the log and commits them to persistence.
	 * @param events Event or array of events to append.
	 */
	append(events: SessionEvent | SessionEvent[]): Promise<void>

	/**
	 * Projects the append-only event log into standard driver messages.
	 */
	deriveMessages(): BHZAIMessage[]

	/**
	 * Forks the session into a new session, optionally up to a specific event ID.
	 * @param newSessionId Unique identifier for the forked session.
	 * @param throughEventId Optional event ID up to which events are copied.
	 */
	fork(newSessionId: string, throughEventId?: string): Promise<Session>

	/**
	 * Exports the session into a versioned serialization format.
	 */
	export(): SessionExport
}

/**
 * Options for creating a new session.
 */
export interface CreateSessionOptions {
	/** Optional specific session identifier; defaults to a generated UUID. */
	id?: string

	/** Optional metadata. */
	metadata?: Record<string, unknown>

	/** Optional name of the persistence backend to use. */
	backend?: string
}

/**
 * Options for opening an existing session.
 */
export interface OpenSessionOptions {
	/** Optional name of the persistence backend to use. */
	backend?: string
}

/**
 * Options for listing persisted sessions.
 */
export interface ListSessionsOptions {
	/** Optional name of the persistence backend to query. */
	backend?: string
}

/**
 * Options for deleting a persisted session.
 */
export interface DeleteSessionOptions {
	/** Optional name of the persistence backend to use. */
	backend?: string
}

/**
 * Central session management service claimed by the session plugin on ctx.sessions.
 */
export interface SessionService {
	/**
	 * Creates a new session.
	 * @param options Session creation parameters.
	 */
	create(options?: CreateSessionOptions): Promise<Session>

	/**
	 * Opens an existing session and replays its log.
	 * @param id Unique session identifier.
	 * @param options Options for opening.
	 */
	open(id: string, options?: OpenSessionOptions): Promise<Session>

	/**
	 * Lists all persisted sessions.
	 * @param options Query options.
	 */
	list(options?: ListSessionsOptions): Promise<SessionSummary[]>

	/**
	 * Deletes a persisted session.
	 * @param id Unique session identifier.
	 * @param options Deletion options.
	 */
	delete(id: string, options?: DeleteSessionOptions): Promise<void>

	/**
	 * Imports an exported session into persistence and returns an active Session instance.
	 * @param data The versioned session export data.
	 * @param options Import options.
	 */
	import(data: SessionExport, options?: OpenSessionOptions): Promise<Session>

	/**
	 * Registers a persistence backend implementation.
	 * @param name Unique backend name.
	 * @param backend Persistence implementation.
	 * @returns Disposable to unregister.
	 */
	registerBackend(name: string, backend: SessionPersistence): () => void

	/**
	 * Retrieves a registered persistence backend by name.
	 * @param name Backend name, or default if omitted.
	 */
	getBackend(name?: string): SessionPersistence

	/**
	 * Pure projection from an event log to standard driver messages.
	 * @param events Array of session events.
	 */
	deriveMessages(events: SessionEvent[]): BHZAIMessage[]
}
