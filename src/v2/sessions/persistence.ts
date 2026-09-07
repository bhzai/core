import type { SessionEvent, SessionPersistence, SessionSummary } from "./types"

interface StoredSessionRecord {
	metadata: Record<string, unknown>
	events: SessionEvent[]
	createdAt: number
	updatedAt: number
}

/**
 * An in-memory implementation of SessionPersistence using an internal Map.
 */
class MemorySessionPersistence implements SessionPersistence {
	private readonly records = new Map<string, StoredSessionRecord>()

	async create(id: string, metadata: Record<string, unknown> = {}): Promise<void> {
		const now = Date.now()
		this.records.set(id, {
			metadata: { ...metadata },
			events: [],
			createdAt: now,
			updatedAt: now,
		})
	}

	async open(id: string): Promise<SessionEvent[]> {
		const record = this.records.get(id)
		if (!record) {
			throw new Error(`Session "${id}" does not exist in persistence.`)
		}
		return [...record.events]
	}

	async append(id: string, events: SessionEvent[]): Promise<void> {
		const record = this.records.get(id)
		if (!record) {
			throw new Error(`Cannot append to non-existent session "${id}".`)
		}
		record.events.push(...events)
		record.updatedAt = Date.now()
	}

	async list(): Promise<SessionSummary[]> {
		const summaries: SessionSummary[] = []
		for (const [id, record] of this.records) {
			summaries.push({
				id,
				createdAt: record.createdAt,
				updatedAt: record.updatedAt,
				eventCount: record.events.length,
				metadata: { ...record.metadata },
			})
		}
		return summaries.sort((a, b) => b.updatedAt - a.updatedAt)
	}

	async delete(id: string): Promise<void> {
		this.records.delete(id)
	}
}

/**
 * Key-value storage interface consumed by KeyValueSessionPersistence.
 */
export interface SimpleKeyValueStore {
	get(key: string): Promise<string | null> | string | null
	set(key: string, value: string): Promise<void> | void
	delete(key: string): Promise<void> | void
	keys(): Promise<string[]> | string[]
}

/**
 * A second SessionPersistence implementation backed by a string key-value store (e.g. storage / IDB-kv).
 */
class KeyValueSessionPersistence implements SessionPersistence {
	private readonly store: SimpleKeyValueStore
	private readonly prefix: string

	constructor(store: SimpleKeyValueStore, prefix = "bhzai:session:") {
		this.store = store
		this.prefix = prefix
	}

	private key(id: string): string {
		return `${this.prefix}${id}`
	}

	async create(id: string, metadata: Record<string, unknown> = {}): Promise<void> {
		const now = Date.now()
		const record: StoredSessionRecord = {
			metadata: { ...metadata },
			events: [],
			createdAt: now,
			updatedAt: now,
		}
		await this.store.set(this.key(id), JSON.stringify(record))
	}

	async open(id: string): Promise<SessionEvent[]> {
		const raw = await this.store.get(this.key(id))
		if (!raw) {
			throw new Error(`Session "${id}" does not exist in key-value persistence.`)
		}
		const record = JSON.parse(raw) as StoredSessionRecord
		return record.events
	}

	async append(id: string, events: SessionEvent[]): Promise<void> {
		const raw = await this.store.get(this.key(id))
		if (!raw) {
			throw new Error(`Cannot append to non-existent session "${id}".`)
		}
		const record = JSON.parse(raw) as StoredSessionRecord
		record.events.push(...events)
		record.updatedAt = Date.now()
		await this.store.set(this.key(id), JSON.stringify(record))
	}

	async list(): Promise<SessionSummary[]> {
		const allKeys = await this.store.keys()
		const sessionKeys = allKeys.filter((k) => k.startsWith(this.prefix))
		const summaries: SessionSummary[] = []

		for (const k of sessionKeys) {
			const id = k.slice(this.prefix.length)
			const raw = await this.store.get(k)
			if (raw) {
				const record = JSON.parse(raw) as StoredSessionRecord
				summaries.push({
					id,
					createdAt: record.createdAt,
					updatedAt: record.updatedAt,
					eventCount: record.events.length,
					metadata: record.metadata,
				})
			}
		}

		return summaries.sort((a, b) => b.updatedAt - a.updatedAt)
	}

	async delete(id: string): Promise<void> {
		await this.store.delete(this.key(id))
	}
}

/**
 * Creates an in-memory SessionPersistence instance.
 * @returns A new MemorySessionPersistence backend.
 */
export function createMemoryPersistence(): SessionPersistence {
	return new MemorySessionPersistence()
}

/**
 * Creates a key-value backed SessionPersistence instance.
 * @param store The underlying SimpleKeyValueStore.
 * @param prefix Optional key namespace prefix.
 * @returns A new KeyValueSessionPersistence backend.
 */
export function createKeyValuePersistence(
	store: SimpleKeyValueStore,
	prefix?: string,
): SessionPersistence {
	return new KeyValueSessionPersistence(store, prefix)
}
