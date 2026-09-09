import fakeIndexedDB from "fake-indexeddb"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { createHarness } from "../../kernel"
import type { PluginContext } from "../../kernel/types"
import { sessionPlugin } from "../../sessions/plugin"
import type { SessionEvent, SessionService } from "../../sessions/types"
import { createIndexedDbPersistence } from "./persistence"
import { idbConversationsPlugin } from "./plugin"

let dbCounter = 0
function uniqueDbName(): string {
	dbCounter += 1
	return `bhzai-test-db-${dbCounter}`
}

const g = globalThis as unknown as { indexedDB?: IDBFactory }
const originalIndexedDb = g.indexedDB

beforeEach(() => {
	g.indexedDB = fakeIndexedDB
})

afterEach(() => {
	g.indexedDB = originalIndexedDb
})

describe("IndexedDB Persistence", () => {
	it("throws if indexedDB is not available in environment", async () => {
		const prev = g.indexedDB
		g.indexedDB = undefined
		try {
			const persistence = createIndexedDbPersistence({ dbName: uniqueDbName() })
			await expect(persistence.create("test-1")).rejects.toThrow(
				"IndexedDB is not available in the current environment",
			)
		} finally {
			g.indexedDB = prev
		}
	})

	it("creates, opens, appends, and reads session events", async () => {
		const persistence = createIndexedDbPersistence({ dbName: uniqueDbName() })
		await persistence.create("session-1", { title: "Test 1" })

		const initialEvents = await persistence.open("session-1")
		expect(initialEvents).toEqual([])

		const events: SessionEvent[] = [
			{
				id: "ev-1",
				sessionId: "session-1",
				type: "user_message",
				timestamp: 1000,
				content: "hello",
			},
			{
				id: "ev-2",
				sessionId: "session-1",
				type: "user_message",
				timestamp: 2000,
				content: "world",
			},
		]

		await persistence.append("session-1", events)
		const retrieved = await persistence.open("session-1")
		expect(retrieved).toHaveLength(2)
		expect(retrieved[0].id).toBe("ev-1")
		expect(retrieved[1].id).toBe("ev-2")
	})

	it("handles empty append gracefully", async () => {
		const persistence = createIndexedDbPersistence({ dbName: uniqueDbName() })
		await persistence.create("session-empty")
		await persistence.append("session-empty", [])
		const events = await persistence.open("session-empty")
		expect(events).toEqual([])
	})

	it("appends to uncreated session and updates metadata", async () => {
		const persistence = createIndexedDbPersistence({ dbName: uniqueDbName() })
		const events: SessionEvent[] = [
			{
				id: "ev-auto",
				sessionId: "auto-session",
				type: "user_message",
				timestamp: 1500,
				content: "auto",
			},
		]
		await persistence.append("auto-session", events)
		const list = await persistence.list()
		expect(list.some((s) => s.id === "auto-session")).toBe(true)
	})

	it("lists sessions newest first and deletes cleanly", async () => {
		const persistence = createIndexedDbPersistence({ dbName: uniqueDbName() })
		await persistence.create("sess-a", { order: 1 })
		// Slight delay to ensure distinct updatedAt timestamps
		await new Promise((resolve) => setTimeout(resolve, 10))
		await persistence.create("sess-b", { order: 2 })

		const list = await persistence.list()
		expect(list).toHaveLength(2)
		expect(list[0].id).toBe("sess-b")
		expect(list[1].id).toBe("sess-a")

		await persistence.delete("sess-a")
		const afterDeleteList = await persistence.list()
		expect(afterDeleteList).toHaveLength(1)
		expect(afterDeleteList[0].id).toBe("sess-b")

		const deletedEvents = await persistence.open("sess-a")
		expect(deletedEvents).toEqual([])
	})
})

describe("idbConversationsPlugin", () => {
	it("throws if sessions service is not available", async () => {
		await expect(createHarness({ plugins: [idbConversationsPlugin] })).rejects.toThrow(
			'Plugin "idb-conversations" requires missing dependency "sessions".',
		)
	})

	it("throws if setup is invoked without claimed sessions service", () => {
		const fakeCtx = { sessions: undefined } as unknown as PluginContext
		expect(() => idbConversationsPlugin.setup(fakeCtx)).toThrow(
			"Sessions service must be claimed before loading idb-conversations.",
		)
	})

	it("registers backend into sessions service and cleans up on teardown", async () => {
		const harness = await createHarness({
			plugins: [
				sessionPlugin,
				{
					...idbConversationsPlugin,
					setup(ctx) {
						return idbConversationsPlugin.setup(ctx, {
							dbName: uniqueDbName(),
							backendName: "idb-custom",
						})
					},
				},
			],
		})

		const sessions = harness.ctx.sessions as SessionService
		expect(sessions).toBeDefined()

		const session = await sessions.create({
			backend: "idb-custom",
			metadata: { title: "IDB Test" },
		})
		expect(session.id).toBeDefined()

		await session.append({
			type: "user_message",
			content: "hi via idb",
		} as unknown as SessionEvent)

		const events = await session.getEvents()
		expect(events).toHaveLength(1)

		await harness.dispose()
	})
})
