/** @file Tests for TASK_0036: Task-management plugin reference example */

import { beforeEach, describe, expect, it, vi } from "vitest"
import { BHZAI } from "../src/core/bhzai.js"
import type { BHZAIDriver, ChatRequest, DriverEvent } from "../src/types/index.js"
import { type Task, taskPlugin } from "./task-plugin.js"

/**
 * Create a minimal mock driver for testing conversation creation.
 * The driver is not actually called in these tests; it exists only to satisfy
 * conversation creation's model resolution.
 */
function makeMockDriver(): BHZAIDriver {
	return {
		id: "test-driver",
		listModels: async () => [
			{
				ref: "test-driver/test-model",
				id: "test-model",
				driver: "test-driver",
				availability: "ready" as const,
				capabilities: {
					toolCalls: true,
					streaming: true,
					reasoning: false,
				},
			},
		],
		capabilities: () => ({
			toolCalls: true,
			streaming: true,
			reasoning: false,
		}),
		chat: async function* (_request: ChatRequest): AsyncIterable<DriverEvent> {
			yield { type: "done", stopReason: "stop" }
		},
		embed: undefined,
	}
}

describe("TASK_0036: Task-management plugin", () => {
	let bh: BHZAI

	beforeEach(async () => {
		bh = new BHZAI()
		bh.use(taskPlugin)
		bh.addDriver(makeMockDriver())
		await bh.init()
	})

	/**
	 * Test 1: update_tasks updates meta and fires meta.changed
	 *
	 * Verifies that invoking the update_tasks tool:
	 * 1. Updates conversation.meta.tasks with the provided array
	 * 2. Fires the meta.changed event
	 */
	it("update_tasks updates meta and fires meta.changed", async () => {
		const conversation = await bh.createConversation({ model: "test-driver/test-model" })

		const metaChangedSpy = vi.fn()
		conversation.on("meta.changed", metaChangedSpy)

		// Retrieve the update_tasks tool and invoke it directly.
		const tool = bh._getTool("update_tasks")
		expect(tool).toBeDefined()

		const testTasks: Task[] = [
			{ id: "1", title: "Write report", status: "in_progress" },
			{ id: "2", title: "Review changes", status: "pending" },
		]

		// Invoke the tool's execute function with test parameters.
		await tool?.execute({
			conversation,
			params: { tasks: testTasks },
			toolCallId: "test-1",
			signal: new AbortController().signal,
			progress: () => {
				/* noop */
			},
		})

		// Assert that meta was updated with the exact array.
		expect(conversation.meta.tasks).toEqual(testTasks)

		// Assert that meta.changed fired.
		expect(metaChangedSpy).toHaveBeenCalledTimes(1)
		expect(metaChangedSpy).toHaveBeenCalledWith({
			meta: expect.objectContaining({ tasks: testTasks }),
			patch: { tasks: testTasks },
		})
	})

	/**
	 * Test 2: context injects task list when non-empty
	 *
	 * Verifies that the context handler injects a <tasks> block containing
	 * the JSON-serialized task list when tasks are present.
	 */
	it("context injects task list when non-empty", async () => {
		const conversation = await bh.createConversation({ model: "test-driver/test-model" })

		const testTasks: Task[] = [
			{ id: "1", title: "Write report", status: "in_progress" },
			{ id: "2", title: "Review changes", status: "pending" },
		]

		// Manually set the task list in meta.
		await conversation.setMeta({ tasks: testTasks })

		// Fire the context event and capture the result.
		// Cast to the internal _dispatchConversationEvent method for testing.
		// biome-ignore lint/suspicious/noExplicitAny: accessing internal test seam
		const contextResult = await (conversation as any)._dispatchConversationEvent("context", {
			conversation,
			messages: [],
			systemPrompt: "",
			tools: [],
		})

		// Assert that the patch includes appendSystemPrompt with the <tasks> block.
		expect(contextResult.patch).toBeDefined()
		const appendSystemPrompt = contextResult.patch?.appendSystemPrompt as string | undefined
		expect(appendSystemPrompt).toBeDefined()
		expect(appendSystemPrompt).toContain("<tasks>")
		expect(appendSystemPrompt).toContain(JSON.stringify(testTasks))
		expect(appendSystemPrompt).toContain("</tasks>") // Verify closing tag structure
	})

	/**
	 * Test 3: context injects nothing when tasks are empty/absent
	 *
	 * Verifies that the context handler returns no patch (or an empty patch)
	 * when the task list is absent or empty.
	 */
	it("context injects nothing when tasks are empty/absent", async () => {
		const conversation = await bh.createConversation({ model: "test-driver/test-model" })

		// Do NOT set any tasks in meta (fresh conversation).

		// Fire the context event.
		// biome-ignore lint/suspicious/noExplicitAny: accessing internal test seam
		const contextResult = await (conversation as any)._dispatchConversationEvent("context", {
			conversation,
			messages: [],
			systemPrompt: "",
			tools: [],
		})

		// Assert that appendSystemPrompt is not in the patch (or is undefined).
		expect(contextResult.patch?.appendSystemPrompt).toBeUndefined()
	})

	/**
	 * Test 4: turn(end) vetoes when a task is open
	 *
	 * Verifies that the turn handler returns a continueWith veto when
	 * any task has status !== 'done'.
	 */
	it("turn(end) vetoes when a task is open", async () => {
		const conversation = await bh.createConversation({ model: "test-driver/test-model" })

		const testTasks: Task[] = [{ id: "1", title: "Write report", status: "in_progress" }]

		await conversation.setMeta({ tasks: testTasks })

		// Fire the turn(end) event.
		// biome-ignore lint/suspicious/noExplicitAny: accessing internal test seam
		const turnResult = await (conversation as any)._dispatchConversationEvent("turn", {
			state: "end",
			turn: 0,
			messages: [],
			toolResults: [],
			conversation,
		})

		// Assert that continueWith is present and contains the open task's title.
		expect(turnResult.patch?.continueWith).toBeDefined()
		const continueWith = turnResult.patch?.continueWith as string | undefined
		expect(continueWith).toContain("Write report")
		expect(continueWith).toContain("Open tasks remain")
	})

	/**
	 * Test 5: turn(end) allows a natural stop when all tasks are done
	 *
	 * Verifies that the turn handler returns no veto when all tasks
	 * have status === 'done'.
	 */
	it("turn(end) allows a natural stop when all tasks are done", async () => {
		const conversation = await bh.createConversation({ model: "test-driver/test-model" })

		const testTasks: Task[] = [{ id: "1", title: "Write report", status: "done" }]

		await conversation.setMeta({ tasks: testTasks })

		// Fire the turn(end) event.
		// biome-ignore lint/suspicious/noExplicitAny: accessing internal test seam
		const turnResult = await (conversation as any)._dispatchConversationEvent("turn", {
			state: "end",
			turn: 0,
			messages: [],
			toolResults: [],
			conversation,
		})

		// Assert that continueWith is NOT present (no veto).
		expect(turnResult.patch?.continueWith).toBeUndefined()
	})

	/**
	 * Additional edge case: turn(start) or turn with state !== 'end' does not veto
	 *
	 * Verifies that the turn handler does not produce a veto for states other than 'end',
	 * even if tasks are open.
	 */
	it("turn(start) does not veto even when tasks are open", async () => {
		const conversation = await bh.createConversation({ model: "test-driver/test-model" })

		const testTasks: Task[] = [{ id: "1", title: "Write report", status: "in_progress" }]

		await conversation.setMeta({ tasks: testTasks })

		// Fire the turn(start) event.
		// biome-ignore lint/suspicious/noExplicitAny: accessing internal test seam
		const turnResult = await (conversation as any)._dispatchConversationEvent("turn", {
			state: "start",
			turn: 0,
			messages: [],
			toolResults: [],
			conversation,
		})

		// Assert that continueWith is NOT present (no veto for non-end states).
		expect(turnResult.patch?.continueWith).toBeUndefined()
	})
})
