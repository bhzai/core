// Conversation-message type declarations (§ 11.1).
// Types only — no runtime logic. See TASK_0002 for the scope contract.

import type { ContentBlock } from "./content.js"

/**
 * The open extension point of the message contract.
 *
 * Plugins declare a field at runtime with `bh.defineMessageField(name)` — which
 * installs a non-enumerable accessor over `message.meta` — and declare its type
 * here by module augmentation, so `message.myField` typechecks without a cast:
 *
 * ```ts
 * declare module "@bhzai/core" {
 *   interface BHZAIMessageExtensions {
 *     sentiment?: "positive" | "negative"
 *   }
 * }
 * ```
 *
 * Augmenting the package specifier works even though `dist/index.d.ts` only
 * re-exports this interface from a bundled chunk: TypeScript resolves the
 * augmented name through the barrel's re-export alias and merges into the
 * original declaration.
 *
 * In-repo code cannot use that specifier, because `@bhzai/core` only
 * resolves once `dist/` has been built — so the repository's own tests augment
 * the declaring module (`"./message.js"`) directly instead.
 *
 * Every member must be optional: a message carries a field only once the owning
 * plugin has registered it, and messages restored from a snapshot written before
 * the plugin existed will have nothing behind the accessor.
 */
export interface BHZAIMessageExtensions {
	/**
	 * Reasoning text extracted from `<think>` tags in the model's own output
	 * stream, populated when a conversation is created with
	 * `parseThink: true`. Backed by `meta.think`.
	 *
	 * Distinct from `meta.reasoning`, which carries a driver's *native*
	 * `reasoning-delta` channel. A model that emits inline `<think>` tags in its
	 * text stream fills this one.
	 */
	think?: string
}

/**
 * The normalized internal message shape drivers and the conversation manager
 * operate on (§ 11.1). `content` is a convenience view of the text blocks;
 * `blocks` is the structured payload.
 *
 * Extends {@link BHZAIMessageExtensions}, which is open for module augmentation
 * so plugins can add typed per-message fields.
 *
 * `append`/`setContent` are method signatures on the interface — this is a
 * type declaration (an interface describing an object's shape), not runtime
 * logic. The implementing class is TASK_0023's responsibility. Per § 11.1
 * prose, `append`/`setContent` are legal only while the message's lifecycle
 * state is `'before'`; the mutation-legality rule itself is enforced by
 * TASK_0023's implementation, not by this type.
 */
export interface BHZAIMessage extends BHZAIMessageExtensions {
	id: string
	role: "user" | "assistant" | "system" | "tool"
	content: string
	blocks: ContentBlock[]
	time: number
	meta: Record<string, unknown>
	append(text: string): void
	setContent(content: string | ContentBlock[]): void
}

/**
 * Conversation lifecycle status (§ 11.1). Extracted as its own named export
 * because multiple downstream tasks (TASK_0023, TASK_0031 compaction, event-bus
 * consumers) reference it without importing the full `BHZAIConversation`
 * interface (which TASK_0023 owns).
 */
export type ConversationStatus =
	| "idle"
	| "streaming"
	| "waiting-tool"
	| "compacting"
	| "aborted"
	| "error"
