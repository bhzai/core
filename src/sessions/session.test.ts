import { describe, expect, it, vi } from "vitest"
import { createHarness } from "../kernel"
import { createMemoryPersistence } from "./persistence"
import { sessionPlugin } from "./plugin"
import { SessionImpl } from "./session"
import type { SessionEvent, SessionExport, SessionPersistence, SessionService } from "./types"

describe("SessionImpl", () => {
	it("initializes with provided events and returns a read-only view", () => {
		const persistence = createMemoryPersistence()
		const initial: SessionEvent[] = [
			{
				id: "e1",
				sessionId: "sess-1",
				timestamp: 1000,
				type: "user_message",
				content: "Hello",
			},
		]
		const session = new SessionImpl("sess-1", { title: "Chat" }, initial, persistence)

		expect(session.id).toBe("sess-1")
		expect(session.metadata).toEqual({ title: "Chat" })
		expect(session.getEvents()).toHaveLength(1)
		expect(session.getEvents()[0].id).toBe("e1")
	})

	it("appends single and multiple events, filling in missing id/timestamp/sessionId", async () => {
		const persistence = createMemoryPersistence()
		await persistence.create("sess-1")
		const appendSpy = vi.fn()
		const session = new SessionImpl("sess-1", {}, [], persistence, appendSpy)

		// Append single event without id and timestamp
		await session.append({
			type: "user_message",
			content: "Test single",
		} as unknown as SessionEvent)

		expect(session.getEvents()).toHaveLength(1)
		const first = session.getEvents()[0]
		expect(first.id).toBeDefined()
		expect(first.sessionId).toBe("sess-1")
		expect(first.timestamp).toBeGreaterThan(0)
		expect(appendSpy).toHaveBeenCalledTimes(1)

		// Append multiple events
		await session.append([
			{
				id: "fixed-id",
				sessionId: "different",
				timestamp: 5000,
				type: "assistant_message",
				content: "Response",
			},
		])

		expect(session.getEvents()).toHaveLength(2)
		const second = session.getEvents()[1]
		expect(second.id).toBe("fixed-id")
		expect(second.sessionId).toBe("sess-1")
		expect(second.timestamp).toBe(5000)
		expect(appendSpy).toHaveBeenCalledTimes(2)

		// Empty append is a no-op
		await session.append([])
		expect(appendSpy).toHaveBeenCalledTimes(2)
	})

	it("derives messages via projection", async () => {
		const persistence = createMemoryPersistence()
		await persistence.create("sess-1")
		const session = new SessionImpl("sess-1", {}, [], persistence)
		await session.append({
			type: "user_message",
			content: "Project me",
		} as unknown as SessionEvent)

		const messages = session.deriveMessages()
		expect(messages).toHaveLength(1)
		expect(messages[0].role).toBe("user")
		expect(messages[0].content).toBe("Project me")
	})

	it("forks session completely without throughEventId", async () => {
		const persistence = createMemoryPersistence()
		await persistence.create("orig")
		const session = new SessionImpl("orig", { env: "prod" }, [], persistence)

		await session.append([
			{ type: "user_message", content: "m1" } as unknown as SessionEvent,
			{ type: "assistant_message", content: "m2" } as unknown as SessionEvent,
		])

		const forked = await session.fork("fork-1")
		expect(forked.id).toBe("fork-1")
		expect(forked.metadata).toEqual({ env: "prod" })
		expect(forked.getEvents()).toHaveLength(2)

		// Ensure event IDs are newly generated and sessionId updated
		const forkedEvents = forked.getEvents()
		const origEvents = session.getEvents()
		expect(forkedEvents[0].id).not.toBe(origEvents[0].id)
		expect(forkedEvents[0].sessionId).toBe("fork-1")
		expect(forkedEvents[1].id).not.toBe(origEvents[1].id)
		expect(forkedEvents[1].sessionId).toBe("fork-1")

		// Verify persistence contains the forked session
		const loadedFromStorage = await persistence.open("fork-1")
		expect(loadedFromStorage).toHaveLength(2)
	})

	it("forks session up to a specific throughEventId", async () => {
		const persistence = createMemoryPersistence()
		await persistence.create("orig-2")
		const session = new SessionImpl("orig-2", {}, [], persistence)

		await session.append({
			id: "ev-target",
			type: "user_message",
			content: "step 1",
		} as unknown as SessionEvent)
		await session.append({
			id: "ev-after",
			type: "assistant_message",
			content: "step 2",
		} as unknown as SessionEvent)

		const forked = await session.fork("fork-sliced", "ev-target")
		expect(forked.getEvents()).toHaveLength(1)
		expect((forked.getEvents()[0] as { content: string }).content).toBe("step 1")
	})

	it("forks with unknown throughEventId falls back to copying all events", async () => {
		const persistence = createMemoryPersistence()
		await persistence.create("orig-3")
		const session = new SessionImpl("orig-3", {}, [], persistence)

		await session.append({
			id: "ev-only",
			type: "user_message",
			content: "step 1",
		} as unknown as SessionEvent)

		const forked = await session.fork("fork-fallback", "unknown-id")
		expect(forked.getEvents()).toHaveLength(1)
	})

	it("exports session to versioned JSON representation", async () => {
		const persistence = createMemoryPersistence()
		await persistence.create("exp-1", { author: "bob" })
		const session = new SessionImpl("exp-1", { author: "bob" }, [], persistence)
		await session.append({
			id: "exp-event-1",
			type: "user_message",
			content: "Export test",
		} as unknown as SessionEvent)

		const exported = session.export()
		expect(exported.version).toBe(1)
		expect(exported.sessionId).toBe("exp-1")
		expect(exported.metadata).toEqual({ author: "bob" })
		expect(exported.events).toHaveLength(1)
		expect(exported.exportedAt).toBeGreaterThan(0)
	})
})

describe("sessionPlugin and SessionService integration", () => {
	it("registers session service on ctx.sessions and manages session lifecycle", async () => {
		const harness = await createHarness({ plugins: [sessionPlugin] })

		const sessions = harness.ctx.sessions as SessionService
		expect(sessions).toBeDefined()

		// Event listener spies
		const createdEvents: unknown[] = []
		const appendedEvents: unknown[] = []
		const deletedEvents: unknown[] = []

		harness.ctx.events.on("session/created", (p) => {
			createdEvents.push(p)
		})
		harness.ctx.events.on("session/event", (p) => {
			appendedEvents.push(p)
		})
		harness.ctx.events.on("session/deleted", (p) => {
			deletedEvents.push(p)
		})

		// Create session
		const session = await sessions.create({ metadata: { topic: "testing" } })
		expect(session.id).toBeDefined()
		expect(createdEvents).toHaveLength(1)

		// Append event
		await session.append({
			type: "user_message",
			content: "Hello harness",
		} as unknown as SessionEvent)

		expect(appendedEvents).toHaveLength(1)

		// Open session
		const opened = await sessions.open(session.id)
		expect(opened.id).toBe(session.id)
		expect(opened.metadata).toEqual({ topic: "testing" })
		expect(opened.getEvents()).toHaveLength(1)

		// List sessions
		const list = await sessions.list()
		expect(list.some((s) => s.id === session.id)).toBe(true)

		// Delete session
		await sessions.delete(session.id)
		expect(deletedEvents).toHaveLength(1)
		const postDeleteList = await sessions.list()
		expect(postDeleteList.some((s) => s.id === session.id)).toBe(false)

		await harness.dispose()
	})

	it("imports exported session and emits session/imported event", async () => {
		const harness = await createHarness({ plugins: [sessionPlugin] })

		const sessions = harness.ctx.sessions as SessionService
		const importedEvents: unknown[] = []
		harness.ctx.events.on("session/imported", (p) => {
			importedEvents.push(p)
		})

		const exportData: SessionExport = {
			version: 1,
			sessionId: "imported-session-1",
			metadata: { imported: true },
			events: [
				{
					id: "imp-e1",
					sessionId: "imported-session-1",
					timestamp: 1000,
					type: "user_message",
					content: "Imported message",
				},
			],
			exportedAt: Date.now(),
		}

		const session = await sessions.import(exportData)
		expect(session.id).toBe("imported-session-1")
		expect(session.metadata).toEqual({ imported: true })
		expect(session.getEvents()).toHaveLength(1)
		expect(importedEvents).toHaveLength(1)

		await harness.dispose()
	})

	it("throws when importing an unsupported export version", async () => {
		const harness = await createHarness({ plugins: [sessionPlugin] })

		const sessions = harness.ctx.sessions as SessionService
		const invalidExport = {
			version: 2,
			sessionId: "inv",
			events: [],
			exportedAt: Date.now(),
		} as unknown as SessionExport

		await expect(sessions.import(invalidExport)).rejects.toThrow(
			"Unsupported session export version: 2",
		)

		await harness.dispose()
	})

	it("registers and retrieves custom persistence backends", async () => {
		const harness = await createHarness({ plugins: [sessionPlugin] })

		const sessions = harness.ctx.sessions as SessionService
		const customBackend: SessionPersistence = createMemoryPersistence()

		const unregister = sessions.registerBackend("custom-mem", customBackend)
		expect(sessions.getBackend("custom-mem")).toBe(customBackend)

		// Unregistering backend removes it
		unregister()
		expect(() => sessions.getBackend("custom-mem")).toThrow(
			'Persistence backend "custom-mem" is not registered.',
		)

		await harness.dispose()
	})

	it("provides pure deriveMessages projection on service", async () => {
		const harness = await createHarness({ plugins: [sessionPlugin] })

		const sessions = harness.ctx.sessions as SessionService
		const msgs = sessions.deriveMessages([
			{
				id: "u1",
				sessionId: "s1",
				timestamp: 100,
				type: "user_message",
				content: "direct projection",
			},
		])

		expect(msgs).toHaveLength(1)
		expect(msgs[0].content).toBe("direct projection")

		await harness.dispose()
	})

	it("preserves projection identity across export and import round-trip", async () => {
		const harness = await createHarness({ plugins: [sessionPlugin] })

		const sessions = harness.ctx.sessions as SessionService
		const originalSession = await sessions.create()

		await originalSession.append([
			{
				id: "e1",
				sessionId: originalSession.id,
				timestamp: 1000,
				type: "user_message",
				content: "Compute 1 + 1",
			},
			{
				id: "e2",
				sessionId: originalSession.id,
				timestamp: 1100,
				type: "assistant_message",
				content: "I will calculate that.",
				toolCalls: [{ id: "c1", name: "calc", arguments: '{"expr":"1+1"}' }],
			},
			{
				id: "e3",
				sessionId: originalSession.id,
				timestamp: 1200,
				type: "tool_result",
				callId: "c1",
				toolName: "calc",
				result: 2,
				isError: false,
			},
			{
				id: "e4",
				sessionId: originalSession.id,
				timestamp: 1300,
				type: "assistant_message",
				content: "The answer is 2.",
			},
		])

		const originalMessages = originalSession.deriveMessages()
		const exported = originalSession.export()

		// Import into another session ID
		const roundTripSession = await sessions.import({
			...exported,
			sessionId: "imported-round-trip",
			events: exported.events.map((e) => ({ ...e, sessionId: "imported-round-trip" })),
		})

		const roundTripMessages = roundTripSession.deriveMessages()

		expect(roundTripMessages).toHaveLength(originalMessages.length)
		for (let i = 0; i < originalMessages.length; i++) {
			expect(roundTripMessages[i].role).toBe(originalMessages[i].role)
			expect(roundTripMessages[i].content).toBe(originalMessages[i].content)
		}

		await harness.dispose()
	})

	it("handles sessions without metadata on open and import", async () => {
		const harness = await createHarness({ plugins: [sessionPlugin] })
		const sessions = harness.ctx.sessions as SessionService

		// Create without metadata
		const created = await sessions.create()
		const opened = await sessions.open(created.id)
		expect(opened.metadata).toEqual({})

		// Import without metadata field
		const noMetaExport: SessionExport = {
			version: 1,
			sessionId: "no-meta-sess",
			events: [],
			exportedAt: Date.now(),
		}
		const imported = await sessions.import(noMetaExport)
		expect(imported.metadata).toEqual({})

		await harness.dispose()
	})
})
