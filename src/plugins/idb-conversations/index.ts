/** @file IndexedDB-backed ConversationStore plugin (§ 11.4).
 *
 * A browser-targeted plugin that implements the kernel's `ConversationStore`
 * interface over IndexedDB. The kernel wires it automatically: registering
 * this plugin via `bh.use()` makes `bh.conversations.list()` /
 * `bh.conversations.load(id)` / `bh.conversations.delete(id)` work, and the
 * kernel's auto-save subscription persists a snapshot on every
 * `conversation.message(sent)` event.
 *
 * ENVIRONMENT BOUNDARY (§ 5): this plugin uses IndexedDB, a web-standard API
 * available in browsers (and in Node via `happy-dom`/test shims). It is NOT
 * part of the core kernel — the core stays storage-agnostic. `initialize()`
 * throws a clear error if `indexedDB` is undefined, so a non-browser host
 * that accidentally registers it fails loudly instead of silently no-oping.
 *
 * PLUGIN EVENTS (§ 8.4): the plugin emits namespaced events on the framework
 * bus at IndexedDB lifecycle moments. All event names are prefixed with the
 * plugin name `idb-conversations`, so they never collide with the reserved
 * `conversation.*` namespace (the bus's reserved-prefix check is
 * `event.startsWith("conversation.")`, and `"idb-conversations.…"` does not
 * match). See {@link IdbConversationEvents} for the full table.
 *
 * PAGINATION: consumers can request the next page of conversations by
 * emitting `idb-conversations.load-page { offset, limit? }`; the plugin
 * responds with `idb-conversations.load.success` (or `.load.error`). The
 * `offset` is zero-based (records skipped from the newest). The
 * `conversationsLimit` option sets the default page size.
 */

import type { ConversationSnapshot } from "../../conversation/snapshot.js"
import type { BHZAI } from "../../core/bhzai.js"
import type { BHZAIPluginCapabilities } from "../../core/bhzai.js"
import type { ConversationStore, ConversationSummary } from "../../types/storage.js"

// ─── Plugin event payload types ─────────────────────────────────────────────

/** Payload of {@link IdbConversationEvents.upgradeneeded}. */
export interface IdbUpgradeneededPayload {
	/** The previous database version (0 for a brand-new DB). */
	oldVersion: number
	/** The new database version. */
	newVersion: number
}

/** Payload of {@link IdbConversationEvents.success}. */
export interface IdbSuccessPayload {
	/** Which IDB operation succeeded. */
	operation: "open" | "save" | "delete"
	/** The conversation id the operation touched, when applicable. */
	id?: string
}

/** Payload of {@link IdbConversationEvents.error}. */
export interface IdbErrorPayload {
	/** Which IDB operation failed. */
	operation: string
	/** The underlying error. */
	error: Error
}

/** Payload of {@link IdbConversationEvents.countSuccess}. */
export interface IdbCountSuccessPayload {
	/** Total number of stored conversations. */
	total: number
}

/** Payload of {@link IdbConversationEvents.countError}. */
export interface IdbCountErrorPayload {
	/** The underlying error. */
	error: Error
}

/** Payload of {@link IdbConversationEvents.loadSuccess}. */
export interface IdbLoadSuccessPayload {
	/** The conversation summaries in this page, newest-first. */
	conversations: ConversationSummary[]
	/** The zero-based offset this page starts at. */
	offset: number
	/** The page size used for this load. */
	limit: number
	/** Total number of stored conversations. */
	total: number
	/** Whether more pages are available beyond this one. */
	hasMore: boolean
}

/** Payload of {@link IdbConversationEvents.loadError}. */
export interface IdbLoadErrorPayload {
	/** The offset that was requested. */
	offset: number
	/** The limit that was requested. */
	limit: number
	/** The underlying error. */
	error: Error
}

/** Payload of {@link IdbConversationEvents.conversationLoaded}. */
export interface IdbConversationLoadedPayload {
	/** The conversation id that was loaded. */
	id: string
	/** The full snapshot returned by the store. */
	snapshot: ConversationSnapshot
}

/** Payload of {@link IdbConversationEvents.conversationDeleted}. */
export interface IdbConversationDeletedPayload {
	/** The conversation id that was deleted. */
	id: string
}

/** Inbound payload for {@link IdbConversationEvents.loadPage}. */
export interface IdbLoadPagePayload {
	/** Zero-based offset (records to skip from the newest). */
	offset: number
	/** Page size; defaults to the plugin's `conversationsLimit` option. */
	limit?: number
}

/**
 * Plugin event names, all prefixed with the plugin name `idb-conversations`.
 *
 * Emitted events (plugin → consumers):
 * - `idb-conversations.upgradeneeded` — DB created or version bumped.
 * - `idb-conversations.success` — a generic IDB request succeeded.
 * - `idb-conversations.error` — a generic IDB request failed (catch-all).
 * - `idb-conversations.count.success` — a count request succeeded.
 * - `idb-conversations.count.error` — a count request failed.
 * - `idb-conversations.load.success` — a page load succeeded.
 * - `idb-conversations.load.error` — a page load failed.
 * - `idb-conversations.conversation.loaded` — `store.load(id)` returned a snapshot.
 * - `idb-conversations.conversation.deleted` — `store.delete(id)` completed.
 *
 * Inbound event (consumer → plugin):
 * - `idb-conversations.load-page` — request the next page of conversations.
 */
export const IdbConversationEvents = {
	/** DB created or version bumped. */
	upgradeneeded: "idb-conversations.upgradeneeded",
	/** A generic IDB request succeeded. */
	success: "idb-conversations.success",
	/** A generic IDB request failed (catch-all). */
	error: "idb-conversations.error",
	/** A count request succeeded. */
	countSuccess: "idb-conversations.count.success",
	/** A count request failed. */
	countError: "idb-conversations.count.error",
	/** A page load succeeded. */
	loadSuccess: "idb-conversations.load.success",
	/** A page load failed. */
	loadError: "idb-conversations.load.error",
	/** `store.load(id)` returned a snapshot. */
	conversationLoaded: "idb-conversations.conversation.loaded",
	/** `store.delete(id)` completed. */
	conversationDeleted: "idb-conversations.conversation.deleted",
	/** Inbound: request the next page of conversations. */
	loadPage: "idb-conversations.load-page",
} as const

// ─── Options ────────────────────────────────────────────────────────────────

/**
 * Host-supplied constructor options for
 * {@link createIdbConversationStorePlugin}.
 */
export interface IdbConversationStoreOptions {
	/** IndexedDB database name. Default: `"bhzai-conversations"`. */
	dbName?: string
	/** Object store name. Default: `"conversations"`. */
	storeName?: string
	/** Database version. Default: `1`. */
	version?: number
	/**
	 * Page size: how many conversations to load per `list()` / `load-page`
	 * request. Default: `20`.
	 */
	conversationsLimit?: number
}

// ─── IndexedDB helpers (no external dep) ────────────────────────────────────

/**
 * Stored record shape: the full snapshot plus the derived fields the
 * `updatedAt` index and `list()` summaries need, so a cursor read does not
 * have to deserialize the whole snapshot to produce a summary.
 */
interface StoredRecord {
	/** keyPath — the conversation id. */
	id: string
	/** The full versioned snapshot. */
	snapshot: ConversationSnapshot
	/** Last-update timestamp (ms since epoch), indexed for newest-first listing. */
	updatedAt: number
	/** Number of messages in the snapshot. */
	messageCount: number
	/** Optional title from `snapshot.meta.title`. */
	title?: string
}

/**
 * Open (or create/upgrade) an IndexedDB database with a single object store.
 *
 * The store uses `keyPath: "id"` and an index on `updatedAt` named
 * `"by-updated-at"` for newest-first cursor traversal. `onupgradeneeded` is
 * the only place schema creation is legal per the IndexedDB spec.
 *
 * @param dbName Database name.
 * @param version Database version.
 * @param storeName Object store name.
 * @param onUpgradeneeded Callback fired with `(oldVersion, newVersion)` when
 *   an upgrade happens — used by the plugin to emit its `upgradeneeded` event.
 * @returns The open `IDBDatabase`.
 * @throws If `indexedDB` is undefined (non-browser, no shim).
 * @throws If the open request errors or is blocked.
 */
function openDB(
	dbName: string,
	version: number,
	storeName: string,
	onUpgradeneeded: (oldVersion: number, newVersion: number) => void,
): Promise<IDBDatabase> {
	if (typeof indexedDB === "undefined") {
		throw new Error(
			"idb-conversations: IndexedDB is unavailable in this environment. " +
				"This plugin requires a browser (or a test shim like happy-dom).",
		)
	}
	return new Promise<IDBDatabase>((resolve, reject) => {
		const req = indexedDB.open(dbName, version)
		req.onupgradeneeded = (event) => {
			const db = req.result
			if (!db.objectStoreNames.contains(storeName)) {
				const store = db.createObjectStore(storeName, { keyPath: "id" })
				store.createIndex("by-updated-at", "updatedAt", { unique: false })
			}
			// `newVersion` is null only when the DB is being deleted; for an
			// open-with-higher-version it is always a number.
			onUpgradeneeded(event.oldVersion, event.newVersion ?? version)
		}
		req.onsuccess = () => resolve(req.result)
		req.onerror = () => reject(req.error ?? new Error("idb-conversations: open failed"))
		req.onblocked = () =>
			reject(new Error("idb-conversations: open blocked by another tab/connection"))
	})
}

/** Promisify a single `IDBRequest`. */
function reqToPromise<T>(req: IDBRequest<T>): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		req.onsuccess = () => resolve(req.result)
		req.onerror = () => reject(req.error ?? new Error("idb-conversations: request failed"))
	})
}

/** Promisify a `IDBTransaction` (resolves on `oncomplete`, rejects on `onerror`/`onabort`). */
function txToPromise(tx: IDBTransaction): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		tx.oncomplete = () => resolve()
		tx.onerror = () => reject(tx.error ?? new Error("idb-conversations: transaction failed"))
		tx.onabort = () => reject(tx.error ?? new Error("idb-conversations: transaction aborted"))
	})
}

// ─── Plugin factory ─────────────────────────────────────────────────────────

/**
 * Create an IndexedDB-backed `ConversationStore` plugin.
 *
 * @param options - Optional configuration: `dbName`, `storeName`, `version`,
 *   `conversationsLimit`.
 * @returns A capability object ready to pass to `bh.use()`.
 *
 * The returned plugin:
 * - Registers a `conversationStore` capability (the kernel auto-saves on
 *   `conversation.message(sent)` and exposes `bh.conversations`).
 * - Opens the IndexedDB database in `initialize()`.
 * - Emits `idb-conversations.*` events at IDB lifecycle moments.
 * - Subscribes to `idb-conversations.load-page` for offset-based pagination.
 * - Closes the DB connection in `dispose()`.
 */
export function createIdbConversationStorePlugin(
	options?: IdbConversationStoreOptions,
): BHZAIPluginCapabilities {
	const dbName = options?.dbName ?? "bhzai-conversations"
	const storeName = options?.storeName ?? "conversations"
	const version = options?.version ?? 1
	const conversationsLimit = options?.conversationsLimit ?? 20

	/** The open DB handle, set in `initialize()`. */
	let db: IDBDatabase | null = null
	/** Unsubscribe the `load-page` handler, set in `initialize()`. */
	let unsubLoadPage: (() => void) | null = null

	/**
	 * Derive `updatedAt` from the snapshot: the latest message's `time`, or
	 * `Date.now()` as a fallback for empty conversations.
	 */
	function deriveUpdatedAt(snapshot: ConversationSnapshot): number {
		const last = snapshot.messages[snapshot.messages.length - 1]
		return last?.time ?? Date.now()
	}

	/** Build a `ConversationSummary` from a stored record. */
	function toSummary(record: StoredRecord): ConversationSummary {
		return {
			id: record.id,
			title: record.title,
			updatedAt: record.updatedAt,
			messageCount: record.messageCount,
		}
	}

	/** Run a count request on the store and emit the result events. */
	async function countTotal(bh: BHZAI): Promise<number> {
		if (!db) throw new Error("idb-conversations: database not initialized")
		const tx = db.transaction(storeName, "readonly")
		const store = tx.objectStore(storeName)
		try {
			const total = await reqToPromise(store.count())
			bh.emit(IdbConversationEvents.countSuccess, { total })
			return total
		} catch (error) {
			const err = error instanceof Error ? error : new Error(String(error))
			bh.emit(IdbConversationEvents.countError, { error: err })
			throw err
		}
	}

	/**
	 * Load a page of conversation summaries via a cursor on the `updatedAt`
	 * index, newest-first. Emits `load.success` / `load.error`.
	 */
	async function loadPage(
		bh: BHZAI,
		offset: number,
		limit: number,
	): Promise<{ summaries: ConversationSummary[]; total: number; hasMore: boolean }> {
		if (!db) throw new Error("idb-conversations: database not initialized")
		const database = db
		const summaries: ConversationSummary[] = []
		let skipped = 0
		let collected = 0

		const total = await countTotal(bh)

		await new Promise<void>((resolve, reject) => {
			const tx = database.transaction(storeName, "readonly")
			const index = tx.objectStore(storeName).index("by-updated-at")
			// "prev" direction → newest-first by `updatedAt`.
			const req = index.openCursor(null, "prev")
			req.onsuccess = () => {
				const cursor = req.result
				if (!cursor || collected >= limit) {
					resolve()
					return
				}
				if (skipped < offset) {
					skipped++
					cursor.continue()
					return
				}
				summaries.push(toSummary(cursor.value as StoredRecord))
				collected++
				cursor.continue()
			}
			req.onerror = () => reject(req.error ?? new Error("idb-conversations: cursor failed"))
		})

		const hasMore = offset + collected < total
		bh.emit(IdbConversationEvents.loadSuccess, {
			conversations: summaries,
			offset,
			limit,
			total,
			hasMore,
		})
		return { summaries, total, hasMore }
	}

	// ── The ConversationStore implementation ──────────────────────────────
	//
	// `bhRef` is assigned in `initialize()`. The store methods below reference
	// it for event emission, but they are only ever called by the kernel AFTER
	// `init()` has completed (the kernel resolves the active store during
	// `init()` and wires auto-save afterwards), so `bhRef` is always set by
	// the time any store method runs. The `db` guard still throws first if
	// somehow a store method is called before `initialize` ran.
	let bhRef: BHZAI | null = null

	/** Emit a plugin event if `bh` is available; no-op before `initialize`. */
	const emit = (event: string, payload: unknown): void => {
		if (bhRef) void bhRef.emit(event, payload)
	}

	const store: ConversationStore = {
		async save(snapshot) {
			if (!db) throw new Error("idb-conversations: database not initialized")
			const record: StoredRecord = {
				id: snapshot.id,
				snapshot,
				updatedAt: deriveUpdatedAt(snapshot),
				messageCount: snapshot.messages.length,
				title: typeof snapshot.meta?.title === "string" ? snapshot.meta.title : undefined,
			}
			const tx = db.transaction(storeName, "readwrite")
			tx.objectStore(storeName).put(record)
			await txToPromise(tx)
			emit(IdbConversationEvents.success, { operation: "save", id: snapshot.id })
		},

		async load(id) {
			if (!db) throw new Error("idb-conversations: database not initialized")
			const tx = db.transaction(storeName, "readonly")
			const req = tx.objectStore(storeName).get(id)
			const record = (await reqToPromise(req)) as StoredRecord | undefined
			if (!record) return undefined
			emit(IdbConversationEvents.conversationLoaded, { id, snapshot: record.snapshot })
			return record.snapshot
		},

		async list(query) {
			if (!db) throw new Error("idb-conversations: database not initialized")
			const database = db
			const limit = query?.limit ?? conversationsLimit
			// Cursor-based `before` pagination: skip until updatedAt < before.
			if (query?.before !== undefined) {
				const before = query.before
				const summaries: ConversationSummary[] = []
				let collected = 0
				await new Promise<void>((resolve, reject) => {
					const tx = database.transaction(storeName, "readonly")
					const index = tx.objectStore(storeName).index("by-updated-at")
					const req = index.openCursor(null, "prev")
					req.onsuccess = () => {
						const cursor = req.result
						if (!cursor || collected >= limit) {
							resolve()
							return
						}
						const record = cursor.value as StoredRecord
						if (record.updatedAt < before) {
							summaries.push(toSummary(record))
							collected++
						}
						cursor.continue()
					}
					req.onerror = () => reject(req.error ?? new Error("idb-conversations: cursor failed"))
				})
				return summaries
			}
			// Offset-based path (no `before`): delegate to loadPage, which emits
			// the load.success event. The caller of `list()` still gets the
			// summaries back directly. `bhRef` is set in `initialize()` which
			// runs before any store method is called by the kernel.
			if (!bhRef) throw new Error("idb-conversations: not initialized")
			const { summaries } = await loadPage(bhRef, 0, limit)
			return summaries
		},

		async delete(id) {
			if (!db) throw new Error("idb-conversations: database not initialized")
			const tx = db.transaction(storeName, "readwrite")
			tx.objectStore(storeName).delete(id)
			await txToPromise(tx)
			emit(IdbConversationEvents.conversationDeleted, { id })
			emit(IdbConversationEvents.success, { operation: "delete", id })
		},
	}

	return {
		name: "idb-conversations",
		conversationStore: store,

		async initialize({ bh }) {
			bhRef = bh
			db = await openDB(dbName, version, storeName, (oldVersion, newVersion) => {
				void bh.emit(IdbConversationEvents.upgradeneeded, { oldVersion, newVersion })
			})
			void bh.emit(IdbConversationEvents.success, { operation: "open" })

			// Inbound pagination: consumers emit load-page → we respond with
			// load.success / load.error.
			unsubLoadPage = bh.on(IdbConversationEvents.loadPage, async (payload: unknown) => {
				const p = payload as Partial<IdbLoadPagePayload>
				const offset = p.offset ?? 0
				const limit = p.limit ?? conversationsLimit
				try {
					await loadPage(bh, offset, limit)
				} catch (error) {
					const err = error instanceof Error ? error : new Error(String(error))
					void bh.emit(IdbConversationEvents.loadError, { offset, limit, error: err })
				}
			})
		},

		async dispose() {
			unsubLoadPage?.()
			unsubLoadPage = null
			db?.close()
			db = null
			bhRef = null
		},
	}
}
