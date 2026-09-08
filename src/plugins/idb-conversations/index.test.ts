/** @file Tests for the IndexedDB-backed ConversationStore plugin.
 *
 * Uses `fake-indexeddb` as the `indexedDB` global polyfill (a dev dependency,
 * not a runtime dep of the plugin). The plugin itself only uses the
 * `indexedDB` global — it never imports a polyfill directly.
 */

import fakeIndexedDB from "fake-indexeddb"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { sendMessage } from "../../conversation/agent-loop.js"
import type { BHZAIConversationImpl } from "../../conversation/conversation.js"
import { BHZAI } from "../../core/bhzai.js"
import type { BHZAIDriver, ChatRequest, DriverEvent } from "../../types/driver.js"
import { IdbConversationEvents, createIdbConversationStorePlugin } from "./index.js"

/**
 * Monotonic counter for unique DB names per test. `fake-indexeddb` is a single
 * in-memory factory, so data persists across tests unless each test uses a
 * distinct database name. This counter guarantees isolation without needing
 * to enumerate and delete databases between tests.
 */
let dbCounter = 0

/** A fresh, unique DB name for one test. */
function uniqueDbName(): string {
	dbCounter += 1
	return `bhzai-test-${dbCounter}`
}

/** Create the plugin with an isolated DB for this test. */
function plugin(opts?: Parameters<typeof createIdbConversationStorePlugin>[0]) {
	return createIdbConversationStorePlugin({ dbName: uniqueDbName(), ...opts })
}

/**
 * Let fire-and-forget async operations (auto-save's `void store.save()` and
 * the plugin's `void bh.emit()`) settle before asserting on event spies.
 * Two macro-tasks are enough: one for the save promise, one for the emit
 * dispatch.
 */
function settle(ms = 25): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms))
}

// The original `indexedDB` value (if any) so `afterEach` can restore it
// without using the `delete` operator (biome: noDelete).
const g = globalThis as unknown as { indexedDB?: IDBFactory }
const originalIndexedDB: IDBFactory | undefined = g.indexedDB

// Install the fake IndexedDB global before any test runs. `fake-indexeddb`
// exports a full `IDBFactory` as its default; assigning it to `globalThis`
// makes the plugin's `typeof indexedDB` check pass and its `indexedDB.open`
// calls resolve against the in-memory fake.
beforeEach(() => {
	g.indexedDB = fakeIndexedDB
})

afterEach(() => {
	if (originalIndexedDB === undefined) {
		g.indexedDB = undefined
	} else {
		g.indexedDB = originalIndexedDB
	}
})

/**
 * Helper: create a mock driver that yields a scripted response.
 */
function makeMockDriver(
	scriptEvents: DriverEvent[],
): BHZAIDriver & { chat: ReturnType<typeof vi.fn> } {
	return {
		id: "mock-driver",
		listModels: async () => [
			{
				ref: "mock-driver/mock-model",
				id: "mock-model",
				driver: "mock-driver",
				availability: "ready" as const,
				capabilities: { toolCalls: true, streaming: true, reasoning: false },
			},
		],
		capabilities: () => ({ toolCalls: true, streaming: true, reasoning: false }),
		chat: vi.fn(async function* (_request: ChatRequest) {
			for (const event of scriptEvents) yield event
		}),
		embed: undefined,
	}
}

describe("idb-conversations plugin: store CRUD", () => {
	let bh: BHZAI

	beforeEach(() => {
		bh = new BHZAI()
	})

	it("registers and initializes without throwing, and list() returns [] on an empty DB", async () => {
		bh.use(plugin())
		await bh.init()
		const list = await bh.conversations.list()
		expect(list).toEqual([])
	})

	it("save() then list() returns one summary with correct messageCount and updatedAt", async () => {
		bh.use(plugin())
		await bh.init()

		// The kernel does not expose store.save() directly, so we exercise
		// persistence end-to-end via a real conversation + sendMessage and
		// rely on the plugin's auto-save wiring.
		const mockDriver = makeMockDriver([
			{ type: "delta", text: "Hello" },
			{ type: "done", stopReason: "stop" },
		])
		bh.addDriver(mockDriver)

		const conversation = (await bh.createConversation({
			model: "mock-driver/mock-model",
		})) as BHZAIConversationImpl

		await sendMessage(conversation, "Hello")
		await settle()

		const list = await bh.conversations.list()
		expect(list).toHaveLength(1)
		expect(list[0].id).toBe(conversation.id)
		expect(list[0].messageCount).toBeGreaterThanOrEqual(2) // user + assistant
		expect(typeof list[0].updatedAt).toBe("number")
	})

	it("load(id) returns the snapshot; load(missing) returns undefined", async () => {
		bh.use(plugin())
		await bh.init()

		const mockDriver = makeMockDriver([
			{ type: "delta", text: "Hi" },
			{ type: "done", stopReason: "stop" },
		])
		bh.addDriver(mockDriver)

		const conversation = (await bh.createConversation({
			model: "mock-driver/mock-model",
		})) as BHZAIConversationImpl

		await sendMessage(conversation, "Hi")
		await settle()

		const loaded = await bh.conversations.load(conversation.id)
		expect(loaded).toBeDefined()
		expect(loaded?.id).toBe(conversation.id)
		expect(loaded?.v).toBe(1)

		const missing = await bh.conversations.load("no-such-id")
		expect(missing).toBeUndefined()
	})

	it("delete(id) removes the conversation; list() is empty afterwards", async () => {
		bh.use(plugin())
		await bh.init()

		const mockDriver = makeMockDriver([
			{ type: "delta", text: "Hey" },
			{ type: "done", stopReason: "stop" },
		])
		bh.addDriver(mockDriver)

		const conversation = (await bh.createConversation({
			model: "mock-driver/mock-model",
		})) as BHZAIConversationImpl

		await sendMessage(conversation, "Hey")
		await settle()

		expect(await bh.conversations.list()).toHaveLength(1)
		await bh.conversations.delete(conversation.id)
		expect(await bh.conversations.list()).toEqual([])
	})

	it("dispose() closes the DB without error", async () => {
		bh.use(plugin())
		await bh.init()
		await bh.dispose()
		// No error thrown is the assertion; calling dispose twice should also be safe.
		await bh.dispose()
	})
})

describe("idb-conversations plugin: emitted events", () => {
	let bh: BHZAI

	beforeEach(() => {
		bh = new BHZAI()
	})

	it("emits upgradeneeded on first init() with oldVersion 0", async () => {
		const spy = vi.fn()
		bh.on(IdbConversationEvents.upgradeneeded, spy)
		bh.use(plugin())
		await bh.init()
		expect(spy).toHaveBeenCalledTimes(1)
		expect(spy.mock.calls[0][0]).toMatchObject({ oldVersion: 0 })
	})

	it("emits success with operation 'open' on init()", async () => {
		const spy = vi.fn()
		bh.on(IdbConversationEvents.success, spy)
		bh.use(plugin())
		await bh.init()
		const openCall = spy.mock.calls.find((c) => c[0]?.operation === "open")
		expect(openCall).toBeDefined()
	})

	it("emits success with operation 'save' on store.save()", async () => {
		const spy = vi.fn()
		bh.on(IdbConversationEvents.success, spy)
		bh.use(plugin())
		await bh.init()

		const mockDriver = makeMockDriver([
			{ type: "delta", text: "Hello" },
			{ type: "done", stopReason: "stop" },
		])
		bh.addDriver(mockDriver)
		const conversation = (await bh.createConversation({
			model: "mock-driver/mock-model",
		})) as BHZAIConversationImpl

		await sendMessage(conversation, "Hello")
		await settle()

		const saveCall = spy.mock.calls.find((c) => c[0]?.operation === "save")
		expect(saveCall).toBeDefined()
		expect(saveCall?.[0]?.id).toBe(conversation.id)
	})

	it("emits conversation.loaded on store.load(id) with the snapshot", async () => {
		const spy = vi.fn()
		bh.on(IdbConversationEvents.conversationLoaded, spy)
		bh.use(plugin())
		await bh.init()

		const mockDriver = makeMockDriver([
			{ type: "delta", text: "Hi" },
			{ type: "done", stopReason: "stop" },
		])
		bh.addDriver(mockDriver)
		const conversation = (await bh.createConversation({
			model: "mock-driver/mock-model",
		})) as BHZAIConversationImpl

		await sendMessage(conversation, "Hi")
		await settle()
		await bh.conversations.load(conversation.id)

		expect(spy).toHaveBeenCalledTimes(1)
		expect(spy.mock.calls[0][0]?.id).toBe(conversation.id)
		expect(spy.mock.calls[0][0]?.snapshot?.v).toBe(1)
	})

	it("emits conversation.deleted on store.delete(id)", async () => {
		const spy = vi.fn()
		bh.on(IdbConversationEvents.conversationDeleted, spy)
		bh.use(plugin())
		await bh.init()

		const mockDriver = makeMockDriver([
			{ type: "delta", text: "Hey" },
			{ type: "done", stopReason: "stop" },
		])
		bh.addDriver(mockDriver)
		const conversation = (await bh.createConversation({
			model: "mock-driver/mock-model",
		})) as BHZAIConversationImpl

		await sendMessage(conversation, "Hey")
		await settle()
		await bh.conversations.delete(conversation.id)

		expect(spy).toHaveBeenCalledTimes(1)
		expect(spy.mock.calls[0][0]?.id).toBe(conversation.id)
	})

	it("emits count.success with the correct total after saves", async () => {
		const spy = vi.fn()
		bh.on(IdbConversationEvents.countSuccess, spy)
		bh.use(plugin({ conversationsLimit: 5 }))
		await bh.init()

		const mockDriver = makeMockDriver([
			{ type: "delta", text: "A" },
			{ type: "done", stopReason: "stop" },
		])
		bh.addDriver(mockDriver)

		// Create and save 2 conversations.
		for (const text of ["one", "two"]) {
			const conv = (await bh.createConversation({
				model: "mock-driver/mock-model",
			})) as BHZAIConversationImpl
			await sendMessage(conv, text)
			await settle()
		}

		// list() triggers a count internally.
		await bh.conversations.list()
		const lastCall = spy.mock.calls[spy.mock.calls.length - 1]
		expect(lastCall?.[0]?.total).toBe(2)
	})

	it("emits load.success from list() with correct offset/limit/hasMore", async () => {
		const spy = vi.fn()
		bh.on(IdbConversationEvents.loadSuccess, spy)
		bh.use(plugin({ conversationsLimit: 10 }))
		await bh.init()

		const mockDriver = makeMockDriver([
			{ type: "delta", text: "X" },
			{ type: "done", stopReason: "stop" },
		])
		bh.addDriver(mockDriver)
		const conv = (await bh.createConversation({
			model: "mock-driver/mock-model",
		})) as BHZAIConversationImpl
		await sendMessage(conv, "X")
		await settle()

		await bh.conversations.list()

		expect(spy).toHaveBeenCalledTimes(1)
		const payload = spy.mock.calls[0][0]
		expect(payload.offset).toBe(0)
		expect(payload.limit).toBe(10)
		expect(payload.total).toBe(1)
		expect(payload.hasMore).toBe(false)
		expect(payload.conversations).toHaveLength(1)
	})
})

describe("idb-conversations plugin: pagination", () => {
	let bh: BHZAI

	beforeEach(() => {
		bh = new BHZAI()
	})

	it("load-page event returns a page of the requested size with hasMore", async () => {
		const spy = vi.fn()
		bh.on(IdbConversationEvents.loadSuccess, spy)
		bh.use(plugin({ conversationsLimit: 100 }))
		await bh.init()

		// Insert 25 snapshots by creating and sending messages. Each
		// conversation gets one user+assistant turn → auto-save fires.
		const mockDriver = makeMockDriver([
			{ type: "delta", text: "r" },
			{ type: "done", stopReason: "stop" },
		])
		bh.addDriver(mockDriver)
		for (let i = 0; i < 25; i++) {
			const conv = (await bh.createConversation({
				model: "mock-driver/mock-model",
			})) as BHZAIConversationImpl
			await sendMessage(conv, `msg ${i}`)
			await settle()
		}

		// Page 1: offset 0, limit 10 → 10 items, hasMore true.
		spy.mockClear()
		await bh.emit(IdbConversationEvents.loadPage, { offset: 0, limit: 10 })
		// The load-page handler is async; let the microtask settle.
		await new Promise((r) => setTimeout(r, 0))
		expect(spy).toHaveBeenCalledTimes(1)
		const page1 = spy.mock.calls[0][0]
		expect(page1.conversations).toHaveLength(10)
		expect(page1.hasMore).toBe(true)
		expect(page1.total).toBe(25)

		// Page 3: offset 20, limit 10 → 5 items, hasMore false.
		spy.mockClear()
		await bh.emit(IdbConversationEvents.loadPage, { offset: 20, limit: 10 })
		await new Promise((r) => setTimeout(r, 0))
		expect(spy).toHaveBeenCalledTimes(1)
		const page3 = spy.mock.calls[0][0]
		expect(page3.conversations).toHaveLength(5)
		expect(page3.hasMore).toBe(false)
	})

	it("load-page with no limit uses the default conversationsLimit", async () => {
		const spy = vi.fn()
		bh.on(IdbConversationEvents.loadSuccess, spy)
		bh.use(plugin({ conversationsLimit: 3 }))
		await bh.init()

		const mockDriver = makeMockDriver([
			{ type: "delta", text: "r" },
			{ type: "done", stopReason: "stop" },
		])
		bh.addDriver(mockDriver)
		for (let i = 0; i < 5; i++) {
			const conv = (await bh.createConversation({
				model: "mock-driver/mock-model",
			})) as BHZAIConversationImpl
			await sendMessage(conv, `msg ${i}`)
			await settle()
		}

		spy.mockClear()
		await bh.emit(IdbConversationEvents.loadPage, { offset: 0 })
		await new Promise((r) => setTimeout(r, 0))
		expect(spy).toHaveBeenCalledTimes(1)
		const page = spy.mock.calls[0][0]
		expect(page.conversations).toHaveLength(3)
		expect(page.limit).toBe(3)
		expect(page.hasMore).toBe(true)
	})
})

describe("idb-conversations plugin: auto-save wiring", () => {
	it("kernel auto-save + the store interoperate: list() grows after a message(sent)", async () => {
		const bh = new BHZAI()
		bh.use(plugin())
		await bh.init()

		const mockDriver = makeMockDriver([
			{ type: "delta", text: "Hello" },
			{ type: "done", stopReason: "stop" },
		])
		bh.addDriver(mockDriver)

		expect(await bh.conversations.list()).toEqual([])

		const conversation = (await bh.createConversation({
			model: "mock-driver/mock-model",
		})) as BHZAIConversationImpl

		await sendMessage(conversation, "Hello")
		await settle()

		const list = await bh.conversations.list()
		expect(list).toHaveLength(1)
		expect(list[0].id).toBe(conversation.id)
	})
})

describe("idb-conversations plugin: options", () => {
	it("customizes dbName and storeName", async () => {
		const bh = new BHZAI()
		bh.use(
			createIdbConversationStorePlugin({
				dbName: "custom-test-db",
				storeName: "custom-store",
			}),
		)
		await bh.init()

		const mockDriver = makeMockDriver([
			{ type: "delta", text: "Hi" },
			{ type: "done", stopReason: "stop" },
		])
		bh.addDriver(mockDriver)
		const conv = (await bh.createConversation({
			model: "mock-driver/mock-model",
		})) as BHZAIConversationImpl
		await sendMessage(conv, "Hi")
		await settle()

		// The data was saved to the custom DB/store name, not the default.
		const list = await bh.conversations.list()
		expect(list).toHaveLength(1)
	})

	it("throws a clear error if indexedDB is undefined", async () => {
		;(globalThis as unknown as { indexedDB?: IDBFactory }).indexedDB = undefined
		const bh = new BHZAI()
		bh.use(plugin())
		await expect(bh.init()).rejects.toThrow(/IndexedDB is unavailable/i)
	})
})
