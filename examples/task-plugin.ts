/** @file Task-management plugin reference example (TASK_0036, ARCHITECTURE.md § 11.7)
 *
 * This plugin demonstrates the capability-object form for simplicity in this example;
 * decorator-based (@Plugin/@On/@Tool) authoring is contract-equivalent per § 7.1
 * and would look identical in behavior. The capability-object form was chosen because
 * it is more concise for a single-file example with straightforward event handlers.
 */

import type { BHZAI } from "../src/core/bhzai.js"
import type { BHZAIPluginCapabilities } from "../src/core/index.js"
import type { BHZAIConversation, BHZAIToolDefinition, ToolInvocation } from "../src/types/index.js"

/**
 * A task represents a unit of work to be done in the conversation.
 *
 * @property id - Unique identifier for the task
 * @property title - Human-readable task description
 * @property status - Current task status: pending (not started), in_progress (active), or done (completed)
 */
export interface Task {
	id: string
	title: string
	status: "pending" | "in_progress" | "done"
}

/**
 * Task-management plugin that maintains a task list on conversation metadata.
 *
 * Provides:
 * - An `update_tasks` tool to replace the task list when the plan changes
 * - A `context` handler to inject the current task list into the model's system prompt
 * - A `turn(end)` gate that vetoes conversation termination while tasks remain open
 *
 * This plugin demonstrates three key extension patterns (ARCHITECTURE.md § 11.7):
 * 1. Tool registration for user-facing commands
 * 2. Context injection for maintaining context without polluting message history
 * 3. Loop-gate vetoing for workflow enforcement
 */
export const taskPlugin: BHZAIPluginCapabilities = {
	name: "tasks",

	/**
	 * Initialize the plugin by registering the `update_tasks` tool and event handlers.
	 *
	 * @param bh - The BHZAI kernel instance
	 */
	async initialize({ bh }: { bh: BHZAI }) {
		// Register the update_tasks tool for managing the task list.
		const updateTasksTool: BHZAIToolDefinition = {
			name: "update_tasks",
			description:
				"Replace the task list for this conversation. Call whenever the plan changes; keep exactly one task in_progress.",
			inputSchema: {
				type: "object",
				required: ["tasks"],
				properties: {
					tasks: {
						type: "array",
						items: {
							type: "object",
							required: ["id", "title", "status"],
							properties: {
								id: { type: "string" },
								title: { type: "string" },
								status: { enum: ["pending", "in_progress", "done"] },
							},
						},
					},
				},
			},
			annotations: { idempotentHint: true },
			async execute({ conversation, params }: ToolInvocation) {
				// Replace the entire task list in conversation metadata.
				// This triggers a meta.changed event that the host observes for UI updates.
				const { tasks } = params as { tasks: Task[] }
				await conversation?.setMeta({ tasks })
				return `tracking ${tasks.length} tasks`
			},
		}

		bh.addTool(updateTasksTool)

		/**
		 * Context injection handler: keep the current task list visible to the model
		 * on every LLM call without adding to the message history.
		 *
		 * Reads the current task list from conversation.meta and injects it into the
		 * system prompt as a structured <tasks> block. Only applies when the list is
		 * non-empty, avoiding empty blocks when no tasks are defined.
		 */
		bh.on("conversation.context", (payload: unknown) => {
			const { conversation } = payload as { conversation: BHZAIConversation }
			const tasks = (conversation.meta?.tasks as Task[] | undefined) ?? []

			if (tasks.length === 0) {
				return // No patch: empty or absent task list gets no injection
			}

			// Inject the task list as a structured XML-like block with JSON content
			return {
				appendSystemPrompt: `<tasks>${JSON.stringify(tasks)}</tasks>`,
			}
		})

		/**
		 * Workflow gate handler: veto conversation termination while open tasks remain.
		 *
		 * Fires on every turn(end) event. If any task has status !== 'done',
		 * returns a veto that injects a synthetic user message listing the open tasks
		 * and directing the model back to update_tasks. This enforces a workflow where
		 * the model cannot naturally stop until it has marked all tasks complete.
		 */
		bh.on("conversation.turn", (payload: unknown) => {
			const { state, conversation } = payload as { state: string; conversation: BHZAIConversation }

			// Only handle the end-of-iteration state; start states pass through.
			if (state !== "end") {
				return
			}

			// Compute the list of open (non-done) tasks.
			const tasks = (conversation.meta?.tasks as Task[] | undefined) ?? []
			const open = tasks.filter((t) => t.status !== "done")

			if (open.length === 0) {
				return // All tasks done or no tasks: allow natural termination
			}

			// Veto: return a message that lists open tasks and prompts the model to continue.
			// The agent loop injects this message and continues looping until vetoed no longer.
			return {
				continueWith: `Open tasks remain: ${open.map((t) => t.title).join(", ")}. Continue, or mark them done via update_tasks.`,
			}
		})
	},
}
