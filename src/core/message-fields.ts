// Open message-field contract — plugin-declared accessors over `message.meta`.
//
// ENVIRONMENT BOUNDARY (§ 5): web-standard APIs only. No Node built-ins, no DOM,
// no imports from src/plugins/**.

import type { BHZAIMessage } from "../types/message.js"

/**
 * Declaration for a plugin-contributed message field.
 *
 * A field is a named accessor installed on every {@link BHZAIMessage} that reads
 * and writes a single key inside the message's `meta` bag. Nothing new is
 * stored on the message itself, which is what makes the contract safe: `meta`
 * already round-trips through `toPlainMessage`/`fromSnapshot`, so a field's
 * value survives persistence without the serializer knowing the field exists.
 */
export interface MessageFieldDefinition {
	/**
	 * `meta` key backing this field. Defaults to the field name. Set it when the
	 * public field name and the stored key need to differ (e.g. namespacing a
	 * plugin's keys as `acme:sentiment` while exposing `message.sentiment`).
	 */
	metaKey?: string
	/** Value the getter returns while the backing `meta` key is absent. */
	default?: unknown
}

/** A {@link MessageFieldDefinition} with its defaults resolved. @internal */
export interface ResolvedMessageField {
	name: string
	metaKey: string
	default: unknown
}

/**
 * Field names that would shadow the structural members of {@link BHZAIMessage}.
 * Registering one is always a mistake — the accessor would hide `content`,
 * `meta`, or a mutation method and silently break the agent loop.
 */
const RESERVED_FIELD_NAMES: ReadonlySet<string> = new Set([
	"id",
	"role",
	"content",
	"blocks",
	"time",
	"meta",
	"append",
	"setContent",
])

/**
 * Registration-ordered registry of plugin-declared message fields.
 *
 * Owned by the kernel (one per `BHZAI` instance) and read by the conversation
 * layer's message factory. Registration order is preserved so `defineProperty`
 * runs in a deterministic sequence.
 */
export class MessageFieldRegistry {
	private readonly fields: Map<string, ResolvedMessageField> = new Map()

	/**
	 * Declare a field. Throws on a reserved name or a duplicate registration —
	 * silently replacing a field would let one plugin hijack another's storage.
	 *
	 * @param name       The property name to expose on every message.
	 * @param definition Backing-key and default overrides.
	 */
	define(name: string, definition: MessageFieldDefinition = {}): void {
		if (name.length === 0) {
			throw new Error("bh.defineMessageField(): field name must be a non-empty string")
		}
		if (RESERVED_FIELD_NAMES.has(name)) {
			throw new Error(
				`bh.defineMessageField(): "${name}" is a reserved BHZAIMessage member and cannot be redefined`,
			)
		}
		if (this.fields.has(name)) {
			throw new Error(`bh.defineMessageField(): field "${name}" is already defined`)
		}
		this.fields.set(name, {
			name,
			metaKey: definition.metaKey ?? name,
			default: definition.default,
		})
	}

	/** Registered fields, in registration order. */
	list(): ResolvedMessageField[] {
		return [...this.fields.values()]
	}

	/** Whether `name` has been registered. */
	has(name: string): boolean {
		return this.fields.has(name)
	}

	/**
	 * Install every registered field as an accessor on `message`.
	 *
	 * Accessors are **non-enumerable** by design. That keeps them out of
	 * `Object.keys`, `JSON.stringify`, and object spread, so serialization
	 * (`toPlainMessage`) keeps emitting exactly the declared wire fields while
	 * the value itself rides along inside `meta`. It also means a spread copy of
	 * a message drops the accessors — call {@link applyMessageFields} again on
	 * any copy (see `withMessageFields`).
	 *
	 * @returns The same `message`, for chaining.
	 */
	applyTo<T extends BHZAIMessage>(message: T): T {
		return applyMessageFields(message, this.list())
	}
}

/**
 * Install `fields` as non-enumerable accessors over `message.meta`.
 *
 * Split out from {@link MessageFieldRegistry} so the conversation layer can
 * re-apply a captured field list to a message copy without holding the kernel.
 *
 * @returns The same `message`, for chaining.
 */
export function applyMessageFields<T extends BHZAIMessage>(
	message: T,
	fields: readonly ResolvedMessageField[],
): T {
	for (const field of fields) {
		const { metaKey } = field
		const fallback = field.default
		Object.defineProperty(message, field.name, {
			get(this: BHZAIMessage): unknown {
				const value = this.meta[metaKey]
				return value === undefined ? fallback : value
			},
			set(this: BHZAIMessage, value: unknown) {
				this.meta[metaKey] = value
			},
			enumerable: false,
			configurable: true,
		})
	}
	return message
}
