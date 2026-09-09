/** @file Storage interfaces (TASK_0029) — conversation persistence, agent memory, and skill resolution */

/** Snapshot shape for conversation serialization. */
export interface ConversationSnapshot {
	id: string
	sessionId?: string
	model?: string
	events?: unknown[]
	messages?: unknown[]
	meta?: Record<string, unknown>
	createdAt?: number
	updatedAt?: number
}

/**
 * Summary information for a stored conversation, suitable for list/browsing UIs.
 *
 * This shape is inferred from § 11.4's description ("minimal information a 'list
 * conversations' UI needs without loading the full snapshot") and is not explicitly
 * spelled out in the ARCHITECTURE.md code block. It is open to refinement by
 * whichever future task actually ships a concrete store implementation.
 *
 * - `title`: derived from `snapshot.meta.title` by the host/store layer if present;
 *   the kernel does not compute or store it.
 * - `updatedAt`: most recent message timestamp or store-assigned time.
 * - `messageCount`: number of messages in the conversation.
 */
export interface ConversationSummary {
	/** Unique conversation identity (same as `snapshot.id`). */
	id: string

	/** Optional title derived from snapshot metadata (host-managed convention). */
	title?: string

	/** Timestamp (ms since epoch) of last update. */
	updatedAt: number

	/** Number of messages in the conversation. */
	messageCount: number
}

/**
 * Persistent agent memory record — fact, preference, or instruction retained
 * across conversations (§ 11.4, related to #1938 agent-memory shape).
 *
 * This shape is inferred from § 11.4's `MemoryStore.save()` and `.list()` return
 * type and is not explicitly spelled out in the code block. It is open to
 * refinement by whichever future task actually ships a concrete memory store.
 */
export interface MemoryRecord {
	/** Unique identifier assigned by the store on creation. */
	id: string

	/** Classification: 'fact' (learned knowledge), 'preference' (user/agent preference), or 'instruction' (directive). */
	kind: "fact" | "preference" | "instruction"

	/** The actual memory content. */
	content: string

	/** Timestamp (ms since epoch) when this record was created. */
	createdAt: number
}

/**
 * Metadata for a registered skill/prompt (used by the `skillResolver` capability).
 *
 * This shape is inferred from § 11.4's `SkillResolver.list()` return type and is
 * not explicitly spelled out in the code block. It is open to refinement by
 * whichever future task actually ships a concrete skill resolver.
 */
export interface SkillInfo {
	/** Unique skill name (e.g., 'explain', 'summarize', 'translate'). */
	name: string

	/** Optional description of what the skill does. */
	description?: string
}

/**
 * Conversation persistence interface (§ 11.4).
 *
 * When a plugin contributes a `conversationStore` capability, the kernel
 * auto-saves on every `message(sent)` event and exposes `bh.conversations.list()`.
 * No concrete implementations ship in v1 — this is interface + kernel wiring only.
 */
export interface ConversationStore {
	/**
	 * Persist a conversation snapshot (called on every `message(sent)` event).
	 *
	 * Each call saves the FULL current snapshot, not an incremental diff. Multiple
	 * calls per turn are possible (e.g., multiple message-sent events).
	 *
	 * @param snapshot The versioned snapshot to persist.
	 * @throws On storage failure or invalid snapshot format.
	 */
	save(snapshot: ConversationSnapshot): Promise<void>

	/**
	 * Load a conversation by ID.
	 *
	 * @param id The conversation's unique identifier.
	 * @returns The snapshot if found, `undefined` if not found.
	 */
	load(id: string): Promise<ConversationSnapshot | undefined>

	/**
	 * List stored conversations, optionally filtered.
	 *
	 * @param query Optional filtering/pagination: `limit` (max results), `before` (cursor for older results).
	 * @returns Array of {@link ConversationSummary} objects, newest-first by default.
	 */
	list(query?: { limit?: number; before?: number }): Promise<ConversationSummary[]>

	/**
	 * Delete a stored conversation by ID.
	 *
	 * @param id The conversation's unique identifier.
	 * @throws On storage failure or if ID not found (host may treat as a no-op).
	 */
	delete(id: string): Promise<void>
}

/**
 * Agent memory persistence interface (§ 11.4, related to #1938).
 *
 * Stores durable memory facts, preferences, and instructions retained across
 * conversations. No concrete implementations ship in v1.
 */
export interface MemoryStore {
	/**
	 * Persist a memory fact/preference/instruction.
	 *
	 * @param memory The memory to store: `kind` ('fact'|'preference'|'instruction') and `content` (text).
	 * @returns The assigned unique ID for the stored memory record.
	 * @throws On storage failure.
	 */
	save(memory: { kind: "fact" | "preference" | "instruction"; content: string }): Promise<string>

	/**
	 * Search memory records by text query.
	 *
	 * @param query The search term.
	 * @param limit Optional max number of results to return.
	 * @returns Array of {@link MemoryRecord} objects matching the query.
	 */
	search(query: string, limit?: number): Promise<MemoryRecord[]>

	/**
	 * List all memory records.
	 *
	 * @returns Array of all {@link MemoryRecord} objects in storage.
	 */
	list(): Promise<MemoryRecord[]>

	/**
	 * Delete a memory record by ID.
	 *
	 * @param id The memory record's unique identifier.
	 * @throws On storage failure or if ID not found (host may treat as a no-op).
	 */
	delete(id: string): Promise<void>
}

/**
 * Skill/prompt resolution interface (§ 11.4).
 *
 * Resolves '/slash' skill names to their prompt text or other content, allowing
 * hosts to implement skill/prompt libraries. No concrete implementations ship in v1.
 */
export interface SkillResolver {
	/**
	 * Resolve a skill by name.
	 *
	 * @param name The skill name (e.g., 'explain', 'summarize').
	 * @returns The resolved skill text/content if found, `undefined` if not found.
	 */
	resolve(name: string): Promise<string | undefined>

	/**
	 * List all available skills.
	 *
	 * @returns Array of {@link SkillInfo} objects for all registered skills.
	 */
	list(): Promise<SkillInfo[]>
}
