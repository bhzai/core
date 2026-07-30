// The canonical BHZAIMessage factory.
//
// Every message in the system is built here so that plugin-declared message
// fields (`bh.defineMessageField()`) are installed uniformly. Before this
// module existed, four call sites hand-rolled the object literal with subtly
// divergent `append`/`setContent` implementations:
//
//   - agent-loop.ts   `constructMessage`        (live)
//   - system-prompt.ts `initToMessage`          (live)
//   - compaction.ts    summary-message literal  (frozen)
//   - snapshot.ts      `createMessageFromPlain` (frozen)
//
// ENVIRONMENT BOUNDARY (§ 5): web-standard APIs only (`crypto.randomUUID`).

import { type MessageFieldRegistry, applyMessageFields } from "../core/message-fields.js"
import type { ContentBlock } from "../types/content.js"
import type { BHZAIMessage } from "../types/message.js"

/** Fields accepted by {@link createMessage}. */
export interface CreateMessageInit {
	role: BHZAIMessage["role"]
	/** Plain string or structured blocks. The other view is derived. */
	content: string | ContentBlock[]
	/**
	 * Explicit blocks, bypassing derivation from `content`. Set only when both
	 * views are already known and must be preserved verbatim — snapshot restore,
	 * where re-deriving one from the other could silently rewrite persisted data.
	 * Requires `content` to be a string.
	 */
	blocks?: ContentBlock[]
	/** Seed metadata. Copied, not aliased. */
	meta?: Record<string, unknown>
	/** Override the generated UUID (snapshot restore). */
	id?: string
	/** Override the generated timestamp (snapshot restore). */
	time?: number
}

/** Behavioral knobs for {@link createMessage}. */
export interface CreateMessageOptions {
	/**
	 * When `false`, `append`/`setContent` throw instead of mutating. Used for
	 * messages that are finalized by construction — compaction summaries and
	 * messages restored from a snapshot — matching § 11.1's "mutation is legal
	 * only while state === 'before'" rule. Defaults to `true`.
	 */
	mutable?: boolean
	/**
	 * Message body of the error thrown by an immutable message's mutators.
	 * `{method}` is replaced with the method name. Ignored when `mutable`.
	 */
	frozenReason?: string
}

const DEFAULT_FROZEN_REASON =
	"BHZAIMessage.{method}(): cannot mutate a reloaded/finalized message — mutation is legal only while state === 'before'"

/** Derive the `{ content, blocks }` pair from either input form. */
function deriveContent(content: string | ContentBlock[]): {
	content: string
	blocks: ContentBlock[]
} {
	if (typeof content === "string") {
		return { content, blocks: [{ type: "text", text: content }] }
	}
	return {
		content: content
			.filter((b) => b.type === "text")
			.map((b) => (b as ContentBlock & { type: "text" }).text)
			.join(""),
		blocks: content,
	}
}

/**
 * Build a {@link BHZAIMessage} and install every registered message field on it.
 *
 * `append` targets the message's **last** block when that block is text, and
 * otherwise pushes a new text block. (One of the two former live factories
 * instead appended to the last text block *anywhere* in the array, which
 * reordered output whenever a non-text block trailed it.)
 *
 * @param init    Role, content, and optional id/time/meta overrides.
 * @param fields  The kernel's field registry. `undefined` installs no fields —
 *                tolerated so the factory stays usable without a kernel.
 * @param options Mutability controls.
 */
export function createMessage(
	init: CreateMessageInit,
	fields?: MessageFieldRegistry,
	options?: CreateMessageOptions,
): BHZAIMessage {
	const { content, blocks } =
		init.blocks !== undefined
			? { content: init.content as string, blocks: init.blocks }
			: deriveContent(init.content)
	const mutable = options?.mutable ?? true
	const frozenReason = options?.frozenReason ?? DEFAULT_FROZEN_REASON

	const message: BHZAIMessage = {
		id: init.id ?? crypto.randomUUID(),
		role: init.role,
		time: init.time ?? Date.now(),
		content,
		blocks,
		meta: { ...init.meta },
		append: mutable
			? function (this: BHZAIMessage, text: string) {
					this.content += text
					const lastBlock = this.blocks[this.blocks.length - 1]
					if (lastBlock && lastBlock.type === "text") {
						lastBlock.text += text
					} else {
						this.blocks.push({ type: "text", text })
					}
				}
			: () => {
					throw new Error(frozenReason.replace("{method}", "append"))
				},
		setContent: mutable
			? function (this: BHZAIMessage, newContent: string | ContentBlock[]) {
					const derived = deriveContent(newContent)
					this.content = derived.content
					this.blocks = derived.blocks
				}
			: () => {
					throw new Error(frozenReason.replace("{method}", "setContent"))
				},
	}

	return fields ? fields.applyTo(message) : message
}

/**
 * Merge `patch` into `message`, returning a copy that still carries its fields.
 *
 * A plain spread drops every message field: the accessors are non-enumerable
 * (deliberately — see `applyMessageFields`), so `{ ...message }` copies neither
 * them nor their values. The agent loop spreads the user message to apply a
 * `message(before)` handler's patch, which without this helper would silently
 * strip every plugin field from the message that actually lands in history.
 *
 * The copy shares `meta` by reference with the original, so field values
 * written before the patch remain readable through the new accessors.
 */
export function withMessageFields<T extends BHZAIMessage>(
	message: T,
	patch: Partial<T>,
	fields?: MessageFieldRegistry,
): T {
	const copy = { ...message, ...patch }
	return fields ? applyMessageFields(copy, fields.list()) : copy
}
