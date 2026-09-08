import { describe, expect, it } from "vitest"
import {
	type SimpleKeyValueStore,
	createKeyValuePersistence,
	createMemoryPersistence,
} from "./persistence"
import type { SessionEvent } from "./types"

class InMemoryStore implements SimpleKeyValueStore {
	private map = new Map<string, string>()

	get(key: string): string | null {
		return this.map.get(key) ?? null
	}

	set(key: string, value: string): void {
		this.map.set(key, value)
	}

	delete(key: string): void {
		this.map.delete(key)
	}

	keys(): string[] {
		return Array.from(this.map.keys())
	}
}

describe("MemorySessionPersistence", () => {
	it("creates and opens an empty session", async () => {
		const persistence = createMemoryPersistence()
		await persistence.create("sess-1", { title: "Test" })

		const events = await persistence.open("sess-1")
		expect(events).toEqual([])
	})

	it("throws when opening a non-existent session", async () => {
		const persistence = createMemoryPersistence()
		await expect(persistence.open("missing")).rejects.toThrow(
			'Session "missing" does not exist in persistence.',
		)
	})

	it("appends events and retrieves them", async () => {
		const persistence = createMemoryPersistence()
		await persistence.create("sess-2")

		const event1: SessionEvent = {
			id: "e1",
			sessionId: "sess-2",
			timestamp: 1000,
			type: "user_message",
			content: "hello",
		}
		const event2: SessionEvent = {
			id: "e2",
			sessionId: "sess-2",
			timestamp: 1100,
			type: "assistant_message",
			content: "hi there",
		}

		await persistence.append("sess-2", [event1])
		await persistence.append("sess-2", [event2])

		const events = await persistence.open("sess-2")
		expect(events).toEqual([event1, event2])
	})

	it("throws when appending to a non-existent session", async () => {
		const persistence = createMemoryPersistence()
		const event: SessionEvent = {
			id: "e1",
			sessionId: "missing",
			timestamp: 1000,
			type: "user_message",
			content: "hi",
		}
		await expect(persistence.append("missing", [event])).rejects.toThrow(
			'Cannot append to non-existent session "missing".',
		)
	})

	it("lists session summaries sorted by updatedAt descending", async () => {
		const persistence = createMemoryPersistence()
		await persistence.create("s1", { name: "first" })
		await persistence.create("s2", { name: "second" })

		const e: SessionEvent = {
			id: "e1",
			sessionId: "s1",
			timestamp: 2000,
			type: "user_message",
			content: "msg",
		}
		// Appending to s1 updates its updatedAt
		await persistence.append("s1", [e])

		const summaries = await persistence.list()
		expect(summaries).toHaveLength(2)
		expect(summaries[0].id).toBe("s1")
		expect(summaries[0].eventCount).toBe(1)
		expect(summaries[0].metadata).toEqual({ name: "first" })
		expect(summaries[1].id).toBe("s2")
		expect(summaries[1].eventCount).toBe(0)
	})

	it("deletes a session", async () => {
		const persistence = createMemoryPersistence()
		await persistence.create("to-delete")
		await persistence.delete("to-delete")

		await expect(persistence.open("to-delete")).rejects.toThrow()
		const list = await persistence.list()
		expect(list.find((s) => s.id === "to-delete")).toBeUndefined()
	})
})

describe("KeyValueSessionPersistence", () => {
	it("creates, appends, opens, and lists sessions", async () => {
		const store = new InMemoryStore()
		const persistence = createKeyValuePersistence(store)

		await persistence.create("kv-1", { author: "alice" })
		const initialEvents = await persistence.open("kv-1")
		expect(initialEvents).toEqual([])

		const ev: SessionEvent = {
			id: "ev1",
			sessionId: "kv-1",
			timestamp: 500,
			type: "user_message",
			content: "ping",
		}
		await persistence.append("kv-1", [ev])

		const loaded = await persistence.open("kv-1")
		expect(loaded).toEqual([ev])

		const summaries = await persistence.list()
		expect(summaries).toHaveLength(1)
		expect(summaries[0].id).toBe("kv-1")
		expect(summaries[0].metadata).toEqual({ author: "alice" })
		expect(summaries[0].eventCount).toBe(1)
	})

	it("throws on open or append with non-existent session", async () => {
		const store = new InMemoryStore()
		const persistence = createKeyValuePersistence(store)

		await expect(persistence.open("ghost")).rejects.toThrow(
			'Session "ghost" does not exist in key-value persistence.',
		)
		const ev: SessionEvent = {
			id: "ev1",
			sessionId: "ghost",
			timestamp: 500,
			type: "user_message",
			content: "ping",
		}
		await expect(persistence.append("ghost", [ev])).rejects.toThrow(
			'Cannot append to non-existent session "ghost".',
		)
	})

	it("supports custom prefix and delete", async () => {
		const store = new InMemoryStore()
		const persistence = createKeyValuePersistence(store, "custom:prefix:")

		await persistence.create("p-1")
		expect(store.get("custom:prefix:p-1")).not.toBeNull()

		await persistence.delete("p-1")
		expect(store.get("custom:prefix:p-1")).toBeNull()

		const list = await persistence.list()
		expect(list).toHaveLength(0)
	})
})
