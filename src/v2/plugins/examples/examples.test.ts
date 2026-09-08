import { describe, expect, it } from "vitest"
import type { BHZAIMessage } from "../../../types/message"
import { createHarness } from "../../kernel"
import type {
	PreStepContext,
	PreStepPayload,
	TurnEndPayload,
	TurnEndResult,
} from "../../loop/types"
import { toolsPlugin } from "../../tools/plugin"
import type { ToolService } from "../../tools/types"
import {
	type MemoryItem,
	type MemoryStore,
	type Retriever,
	type Task,
	createMemoryPlugin,
	createRagPlugin,
	taskPlugin,
} from "./index"

const WHITESPACE_REGEX = /\s+/

function makeUserMsg(content: string): BHZAIMessage {
	return {
		id: crypto.randomUUID(),
		role: "user",
		content,
		blocks: [{ type: "text", text: content }],
		time: Date.now(),
		meta: {},
		append: () => {},
		setContent: () => {},
	}
}

describe("taskPlugin", () => {
	it("updates tasks, injects context, and handles turn veto", async () => {
		const harness = await createHarness({
			plugins: [toolsPlugin, taskPlugin],
		})

		const tools = harness.ctx.tools as ToolService
		expect(tools.has("update_tasks")).toBe(true)

		const initialTasks: Task[] = [
			{ id: "t1", title: "Write tests", status: "in_progress" },
			{ id: "t2", title: "Refactor code", status: "pending" },
		]

		await tools.execute({
			callId: "call-1",
			toolName: "update_tasks",
			sessionId: "sess-1",
			arguments: { tasks: initialTasks },
		})

		// Test pre-step injection
		const preStepPayload: PreStepPayload = {
			stepIndex: 0,
			messages: [makeUserMsg("Proceed")],
			systemPrompt: "You are a helpful assistant.",
		}
		const preStepContext: PreStepContext = {
			sessionId: "sess-1",
			turnId: "turn-1",
			stepIndex: 0,
		}

		const transformed = await harness.ctx.events.runWaterfall<PreStepPayload, PreStepContext>(
			"pre-step",
			preStepPayload,
			preStepContext,
		)
		expect(transformed.systemPrompt).toContain("<tasks>")
		expect(transformed.systemPrompt).toContain("Write tests")

		// Test turn/end continuation while tasks are open
		const turnEndPayload: TurnEndPayload = {
			sessionId: "sess-1",
			turnId: "turn-1",
			steps: [],
			text: "Done with step 1",
		}
		const vetoResult = await harness.ctx.events.runBail<TurnEndPayload, TurnEndResult>(
			"turn/end",
			turnEndPayload,
		)
		expect(vetoResult).toBeDefined()
		expect(vetoResult?.followUp).toContain("Open tasks remain: Write tests, Refactor code")

		// Mark tasks as done
		await tools.execute({
			callId: "call-2",
			toolName: "update_tasks",
			sessionId: "sess-1",
			arguments: {
				tasks: [
					{ id: "t1", title: "Write tests", status: "done" },
					{ id: "t2", title: "Refactor code", status: "done" },
				],
			},
		})

		const completedVeto = await harness.ctx.events.runBail<TurnEndPayload, TurnEndResult>(
			"turn/end",
			turnEndPayload,
		)
		expect(completedVeto).toBeUndefined()

		await harness.dispose()
		expect(tools.has("update_tasks")).toBe(false)
	})
})

describe("createMemoryPlugin", () => {
	it("saves memory, injects recall, and captures compaction events", async () => {
		const stored: MemoryItem[] = []
		const memoryStore: MemoryStore = {
			save: async (item) => {
				const id = `mem-${stored.length + 1}`
				stored.push({ ...item, id })
				return id
			},
			search: async (query) => {
				const words = query.toLowerCase().split(WHITESPACE_REGEX)
				return stored.filter((m) =>
					words.some((w) => w.length > 3 && m.content.toLowerCase().includes(w)),
				)
			},
		}

		const harness = await createHarness({
			plugins: [toolsPlugin, createMemoryPlugin(memoryStore)],
		})

		const tools = harness.ctx.tools as ToolService
		expect(tools.has("save_memory")).toBe(true)

		// Execute save_memory
		const res = await tools.execute({
			callId: "c1",
			toolName: "save_memory",
			arguments: { kind: "preference", content: "User likes TypeScript" },
		})
		expect(res.content).toEqual([{ type: "text", text: "remembered (mem-1)" }])
		expect(stored).toHaveLength(1)

		// Pre-step recall
		const messages: BHZAIMessage[] = [makeUserMsg("Tell me about TypeScript best practices")]
		const transformed = await harness.ctx.events.runWaterfall<PreStepPayload, PreStepContext>(
			"pre-step",
			{ stepIndex: 0, messages },
			{ sessionId: "s1", turnId: "t1", stepIndex: 0 },
		)
		expect(transformed.systemPrompt).toContain("<memories>")
		expect(transformed.systemPrompt).toContain("User likes TypeScript")

		// Compaction event listener
		await harness.ctx.events.emit("compaction/start", {
			sessionId: "s1",
			eventsToCompact: [
				{
					id: "ev1",
					sessionId: "s1",
					timestamp: 100,
					type: "user_message",
					content: "Remember that I live in London",
				},
			],
		})

		expect(stored).toHaveLength(2)
		expect(stored[1].content).toBe("Remember that I live in London")

		await harness.dispose()
	})
})

describe("createRagPlugin", () => {
	it("provides search_knowledge tool and performs automatic context injection", async () => {
		const mockRetriever1: Retriever = {
			retrieve: async (query) => [
				{
					content: `Doc 1 matching ${query}`,
					source: "doc1.md",
					score: 0.9,
				},
			],
		}
		const mockRetriever2: Retriever = {
			retrieve: async (query) => [
				{
					content: `Doc 2 matching ${query}`,
					source: "doc2.md",
					score: 0.95,
				},
			],
		}

		const harness = await createHarness({
			plugins: [
				toolsPlugin,
				createRagPlugin({
					retrievers: [mockRetriever1, mockRetriever2],
					topK: 2,
				}),
			],
		})

		const tools = harness.ctx.tools as ToolService
		expect(tools.has("search_knowledge")).toBe(true)

		// Test search_knowledge tool
		const toolRes = await tools.execute({
			callId: "c-rag",
			toolName: "search_knowledge",
			arguments: { query: "architecture" },
		})
		expect(toolRes.content).toHaveLength(2)

		// Test automatic pre-step injection
		const transformed = await harness.ctx.events.runWaterfall<PreStepPayload, PreStepContext>(
			"pre-step",
			{
				stepIndex: 0,
				messages: [makeUserMsg("architecture design")],
			},
			{ sessionId: "s-rag", turnId: "t-rag", stepIndex: 0 },
		)

		expect(transformed.systemPrompt).toContain("<retrieved-context>")
		// doc2 has score 0.95, so it should be ranked first
		expect(transformed.systemPrompt).toContain("[doc2.md]")
		expect(transformed.systemPrompt).toContain("[doc1.md]")

		await harness.dispose()
	})
})
