import { describe, expect, it } from "vitest"
import type { BHZAIDriver } from "../../types/driver"
import { createHarness } from "./kernel"
import type { PluginDefinition } from "./types"

describe("HarnessSession & Session Facade", () => {
	it("manages session lifecycle, turn execution, and event streaming via HarnessSession", async () => {
		interface MockSession {
			id: string
			metadata: Record<string, unknown>
			events: unknown[]
			append: (e: unknown) => Promise<void>
			setMetadata: (m: Record<string, unknown>) => Promise<void>
			getEvents: () => readonly unknown[]
			export: () => Promise<{
				version: 1
				sessionId: string
				metadata: Record<string, unknown>
				events: unknown[]
			}>
		}

		const mockSessionPlugin: PluginDefinition = {
			name: "sessions",
			setup(ctx) {
				const memorySessions = new Map<string, MockSession>()
				ctx.claim("sessions", {
					create: async (opts?: { id?: string; metadata?: Record<string, unknown> }) => {
						const id = opts?.id ?? "sess-facade"
						const sess: MockSession = {
							id,
							metadata: { ...opts?.metadata },
							events: [],
							append: async (e: unknown) => {
								sess.events.push(e)
							},
							setMetadata: async (m: Record<string, unknown>) => {
								sess.metadata = m
							},
							getEvents: () => [...sess.events],
							export: async () => ({
								version: 1 as const,
								sessionId: id,
								metadata: sess.metadata,
								events: sess.events,
							}),
						}
						memorySessions.set(id, sess)
						return sess
					},
					open: async (id: string) => {
						const sess = memorySessions.get(id)
						if (!sess) throw new Error("not found")
						return sess
					},
					list: async () => [],
					delete: async (id: string) => {
						memorySessions.delete(id)
					},
				})
			},
		}

		const mockLoopPlugin: PluginDefinition = {
			name: "agentLoop",
			setup(ctx) {
				let busy = false
				ctx.claim("agentLoop", {
					isBusy: () => busy,
					runTurn: async (sessionId: string, _input: unknown, _opts: unknown) => {
						busy = true
						ctx.events.emit("stream/delta", {
							sessionId,
							turnId: "t1",
							stepIndex: 0,
							text: "chunk1",
						})
						ctx.events.emit("stream/reasoning", {
							sessionId,
							turnId: "t1",
							stepIndex: 0,
							text: "think1",
						})
						busy = false
						return {
							turnId: "t1",
							sessionId,
							text: "full response",
							steps: [
								{
									stepIndex: 0,
									assistantText: "full response",
									usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
								},
							],
						}
					},
				})
			},
		}

		const harness = await createHarness({
			plugins: [mockSessionPlugin, mockLoopPlugin],
		})

		const session = await harness.createSession({
			metadata: { model: "test-model", title: "Facade Test" },
		})

		expect(session.id).toBe("sess-facade")
		expect(session.model).toBe("test-model")
		expect(session.status).toBe("idle")

		await session.setModel("updated-model")
		expect(session.model).toBe("updated-model")

		const deltas: unknown[] = []
		session.on("message.delta", (d) => deltas.push(d))

		const turnRes = await session.sendMessage("hello world")
		expect(turnRes.text).toBe("full response")
		expect(session.usage.totalTokens).toBe(30)
		expect(deltas).toEqual([
			{ delta: "chunk1", kind: "text" },
			{ delta: "think1", kind: "reasoning" },
		])

		session.abort() // verify abort does not throw

		const exported = await session.export()
		expect(exported.sessionId).toBe("sess-facade")

		const json = session.toJSON()
		expect(json.id).toBe("sess-facade")
		expect(json.model).toBe("updated-model")

		expect(session.getEvents().length).toBeGreaterThan(0)

		const customEvents: unknown[] = []
		const unsubCustom = session.on("custom.event", (payload) => {
			customEvents.push(payload)
		})
		harness.emit("custom.event", { sessionId: "other-session", data: 123 })
		harness.emit("custom.event", { sessionId: "sess-facade", data: 456 })
		harness.emit("custom.event", { data: 789 })
		expect(customEvents).toEqual([{ sessionId: "sess-facade", data: 456 }, { data: 789 }])
		unsubCustom()

		const busEvents: unknown[] = []
		const unsubBus = harness.on("bus.test", (p) => {
			busEvents.push(p)
		})
		harness.emit("bus.test", "hello bus")
		expect(busEvents).toEqual(["hello bus"])
		unsubBus()

		expect(session.contextUsage).toBeDefined()

		const conv1 = await harness.createConversation({ metadata: { model: "m1" } })
		expect(conv1.model).toBe("m1")

		const loadedByStr = await harness.loadConversation("sess-facade")
		expect(loadedByStr.id).toBe("sess-facade")

		const loadedByObj = await harness.loadConversation({ id: "sess-facade" })
		expect(loadedByObj.id).toBe("sess-facade")

		const loadedByExport = await harness.loadConversation({ sessionId: "sess-facade" })
		expect(loadedByExport.id).toBe("sess-facade")

		await expect(harness.loadConversation({} as unknown as { id: string })).rejects.toThrow(
			"Invalid conversation snapshot",
		)

		// Test harness.conversations accessor
		const list = await harness.conversations.list()
		expect(list).toEqual([])
		const loadedExport = await harness.conversations.load("sess-facade")
		expect(loadedExport?.sessionId).toBe("sess-facade")
		const opened = await harness.openSession("sess-facade")
		expect(opened.id).toBe("sess-facade")

		await harness.conversations.delete("sess-facade")

		// Test driver management on harness
		expect(await harness.listModels()).toEqual([])
		expect(() =>
			harness.addDriver({
				id: "test",
				capabilities: () => ({ streaming: true, toolCalls: false, reasoning: false }),
				chat: async function* () {},
			} as unknown as BHZAIDriver),
		).toThrow("llm service is not registered")

		await harness.dispose()
	})

	it("throws errors when required services are missing from harness methods", async () => {
		const emptyHarness = await createHarness()
		await expect(emptyHarness.createSession()).rejects.toThrow("requires the sessions service")
		await expect(emptyHarness.openSession("any")).rejects.toThrow("requires the sessions service")
		await emptyHarness.dispose()

		const sessionPluginOnly: PluginDefinition = {
			name: "sessions",
			setup(ctx) {
				ctx.claim("sessions", {
					create: async () => ({
						id: "s1",
						metadata: {},
						events: [],
						getEvents: () => [],
						export: async () => ({
							version: 1 as const,
							sessionId: "s1",
							events: [],
						}),
					}),
					open: async () => {
						throw new Error("not found")
					},
				})
			},
		}
		const h = await createHarness({ plugins: [sessionPluginOnly] })
		const s = await h.createSession()
		await expect(s.sendMessage("hi")).rejects.toThrow("agentLoop service is not registered")
		await h.dispose()
	})
})
