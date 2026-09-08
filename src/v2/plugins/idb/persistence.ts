import type { SessionEvent, SessionPersistence, SessionSummary } from "../../sessions/types"

const DEFAULT_DB_NAME = "bhzai-sessions-v2"
const DB_VERSION = 1
const SESSIONS_STORE = "sessions"
const EVENTS_STORE = "events"

/**
 * Configuration options for IndexedDB persistence.
 */
export interface IndexedDbPersistenceOptions {
	/** Custom IndexedDB database name. */
	dbName?: string
}

interface StoredSessionMetadata {
	id: string
	metadata: Record<string, unknown>
	createdAt: number
	updatedAt: number
	eventCount: number
}

function getIndexedDbFactory(): IDBFactory {
	const g = globalThis as unknown as { indexedDB?: IDBFactory }
	if (!g.indexedDB) {
		throw new Error(
			"IndexedDB is not available in the current environment. IndexedDB persistence requires a browser or polyfill.",
		)
	}
	return g.indexedDB
}

function openDatabase(dbName: string): Promise<IDBDatabase> {
	const factory = getIndexedDbFactory()
	return new Promise((resolve, reject) => {
		const request = factory.open(dbName, DB_VERSION)

		request.onupgradeneeded = () => {
			const db = request.result
			if (!db.objectStoreNames.contains(SESSIONS_STORE)) {
				db.createObjectStore(SESSIONS_STORE, { keyPath: "id" })
			}
			if (!db.objectStoreNames.contains(EVENTS_STORE)) {
				const store = db.createObjectStore(EVENTS_STORE, { keyPath: "id" })
				store.createIndex("sessionId", "sessionId", { unique: false })
			}
		}

		request.onsuccess = () => resolve(request.result)
		request.onerror = () => reject(request.error)
	})
}

class IndexedDbPersistenceImpl implements SessionPersistence {
	private readonly dbName: string

	constructor(dbName: string) {
		this.dbName = dbName
	}

	async create(id: string, metadata: Record<string, unknown> = {}): Promise<void> {
		const db = await openDatabase(this.dbName)
		return new Promise((resolve, reject) => {
			const tx = db.transaction([SESSIONS_STORE], "readwrite")
			const store = tx.objectStore(SESSIONS_STORE)
			const now = Date.now()
			const record: StoredSessionMetadata = {
				id,
				metadata: { ...metadata },
				createdAt: now,
				updatedAt: now,
				eventCount: 0,
			}
			const req = store.put(record)
			req.onsuccess = () => resolve()
			req.onerror = () => reject(req.error)
		})
	}

	async open(id: string): Promise<SessionEvent[]> {
		const db = await openDatabase(this.dbName)
		return new Promise((resolve, reject) => {
			const tx = db.transaction([EVENTS_STORE], "readonly")
			const store = tx.objectStore(EVENTS_STORE)
			const index = store.index("sessionId")
			const req = index.getAll(id)
			req.onsuccess = () => {
				const events = (req.result as SessionEvent[]) || []
				events.sort((a, b) => a.timestamp - b.timestamp)
				resolve(events)
			}
			req.onerror = () => reject(req.error)
		})
	}

	async append(id: string, events: SessionEvent[]): Promise<void> {
		if (events.length === 0) return
		const db = await openDatabase(this.dbName)
		return new Promise((resolve, reject) => {
			const tx = db.transaction([SESSIONS_STORE, EVENTS_STORE], "readwrite")
			const sessStore = tx.objectStore(SESSIONS_STORE)
			const evtStore = tx.objectStore(EVENTS_STORE)

			for (const event of events) {
				evtStore.put(event)
			}

			const getReq = sessStore.get(id)
			getReq.onsuccess = () => {
				const existing = getReq.result as StoredSessionMetadata | undefined
				const now = Date.now()
				const record: StoredSessionMetadata = existing
					? {
							...existing,
							updatedAt: now,
							eventCount: existing.eventCount + events.length,
						}
					: {
							id,
							metadata: {},
							createdAt: now,
							updatedAt: now,
							eventCount: events.length,
						}
				sessStore.put(record)
			}

			tx.oncomplete = () => resolve()
			tx.onerror = () => reject(tx.error)
		})
	}

	async list(): Promise<SessionSummary[]> {
		const db = await openDatabase(this.dbName)
		return new Promise((resolve, reject) => {
			const tx = db.transaction([SESSIONS_STORE], "readonly")
			const store = tx.objectStore(SESSIONS_STORE)
			const req = store.getAll()

			req.onsuccess = () => {
				const records = (req.result as StoredSessionMetadata[]) || []
				const summaries: SessionSummary[] = records.map((r) => ({
					id: r.id,
					createdAt: r.createdAt,
					updatedAt: r.updatedAt,
					eventCount: r.eventCount,
					metadata: r.metadata,
				}))
				summaries.sort((a, b) => b.updatedAt - a.updatedAt)
				resolve(summaries)
			}
			req.onerror = () => reject(req.error)
		})
	}

	async delete(id: string): Promise<void> {
		const db = await openDatabase(this.dbName)
		return new Promise((resolve, reject) => {
			const tx = db.transaction([SESSIONS_STORE, EVENTS_STORE], "readwrite")
			const sessStore = tx.objectStore(SESSIONS_STORE)
			const evtStore = tx.objectStore(EVENTS_STORE)
			const index = evtStore.index("sessionId")

			sessStore.delete(id)

			const cursorReq = index.openCursor(id)
			cursorReq.onsuccess = () => {
				const cursor = cursorReq.result
				if (cursor) {
					cursor.delete()
					cursor.continue()
				}
			}

			tx.oncomplete = () => resolve()
			tx.onerror = () => reject(tx.error)
		})
	}
}

/**
 * Creates an IndexedDB-backed SessionPersistence implementation for the v0.2 session log.
 * @param options Database options including custom database name.
 */
export function createIndexedDbPersistence(
	options: IndexedDbPersistenceOptions = {},
): SessionPersistence {
	const dbName = options.dbName || DEFAULT_DB_NAME
	return new IndexedDbPersistenceImpl(dbName)
}
