import type { BHZAIMessage } from "../types/message"
import { deriveMessages } from "./projection"
import type { Session, SessionEvent, SessionExport, SessionPersistence } from "./types"

/**
 * Implementation of the active Session instance.
 */
export class SessionImpl implements Session {
	readonly id: string
	readonly metadata: Record<string, unknown>
	private readonly events: SessionEvent[]
	private readonly persistence: SessionPersistence
	private readonly onAppend?: (events: SessionEvent[]) => void

	/**
	 * Creates a new SessionImpl instance.
	 * @param id Unique session identifier.
	 * @param metadata Session metadata object.
	 * @param events Initial events log.
	 * @param persistence Underlying storage backend.
	 * @param onAppend Optional listener called whenever events are appended.
	 */
	constructor(
		id: string,
		metadata: Record<string, unknown>,
		events: SessionEvent[],
		persistence: SessionPersistence,
		onAppend?: (events: SessionEvent[]) => void,
	) {
		this.id = id
		this.metadata = metadata
		this.events = [...events]
		this.persistence = persistence
		this.onAppend = onAppend
	}

	getEvents(): readonly SessionEvent[] {
		return this.events
	}

	async append(events: SessionEvent | SessionEvent[]): Promise<void> {
		const rawList = Array.isArray(events) ? events : [events]
		if (rawList.length === 0) return

		const now = Date.now()
		const normalized: SessionEvent[] = rawList.map((e) => ({
			...e,
			id: e.id || crypto.randomUUID(),
			sessionId: this.id,
			timestamp: e.timestamp || now,
		}))

		this.events.push(...normalized)
		await this.persistence.append(this.id, normalized)
		this.onAppend?.(normalized)
	}

	deriveMessages(): BHZAIMessage[] {
		return deriveMessages(this.events)
	}

	async fork(newSessionId: string, throughEventId?: string): Promise<Session> {
		let slice = this.events
		if (throughEventId) {
			const index = this.events.findIndex((e) => e.id === throughEventId)
			if (index !== -1) {
				slice = this.events.slice(0, index + 1)
			}
		}

		const clonedEvents: SessionEvent[] = slice.map((e) => ({
			...structuredClone(e),
			id: crypto.randomUUID(),
			sessionId: newSessionId,
		}))

		await this.persistence.create(newSessionId, { ...this.metadata })
		if (clonedEvents.length > 0) {
			await this.persistence.append(newSessionId, clonedEvents)
		}

		return new SessionImpl(
			newSessionId,
			{ ...this.metadata },
			clonedEvents,
			this.persistence,
			this.onAppend,
		)
	}

	export(): SessionExport {
		return {
			version: 1,
			sessionId: this.id,
			metadata: structuredClone(this.metadata),
			events: structuredClone(this.events),
			exportedAt: Date.now(),
		}
	}
}
