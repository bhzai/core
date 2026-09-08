import type { PluginContext, PluginDefinition } from "../../kernel/types"
import type {
	PreStepContext,
	PreStepPayload,
	TurnEndPayload,
	TurnEndResult,
} from "../../loop/types"
import type { ToolDefinition, ToolInvocation } from "../../tools/types"

/**
 * Task item representation in the task management workflow.
 */
export interface Task {
	id: string
	title: string
	status: "pending" | "in_progress" | "done"
}

const sessionTasks = new Map<string, Task[]>()

function createUpdateTasksTool(): ToolDefinition<{ tasks: Task[] }> {
	return {
		name: "update_tasks",
		description:
			"Replace the task list for this session. Call whenever the plan changes; keep exactly one task in_progress.",
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
		execute: (invocation: ToolInvocation<{ tasks: Task[] }>) => {
			const sid = invocation.sessionId ?? "default"
			const tasks = invocation.params?.tasks ?? []
			sessionTasks.set(sid, tasks)
			return `tracking ${tasks.length} tasks`
		},
	}
}

/**
 * Reference example task-management plugin for workflow orchestration.
 *
 * Demonstrates:
 * 1. Tool registration (`update_tasks`)
 * 2. Dynamic context injection via `pre-step` waterfall
 * 3. Turn continuation / workflow enforcement via `turn/end` bail handler
 */
export const taskPlugin: PluginDefinition = {
	name: "tasks",
	dependencies: ["tools"],
	setup(ctx: PluginContext) {
		const tools = ctx.tools
		if (!tools) {
			throw new Error("taskPlugin requires tools service.")
		}

		const unregisterTool = tools.register(createUpdateTasksTool() as unknown as ToolDefinition)

		const removePreStep = ctx.events.waterfall(
			"pre-step",
			async (payload: PreStepPayload, context: PreStepContext, next) => {
				const tasks = sessionTasks.get(context.sessionId) ?? []
				if (tasks.length === 0) return await next(payload)

				const block = `<tasks>${JSON.stringify(tasks)}</tasks>`
				const systemPrompt = payload.systemPrompt ? `${payload.systemPrompt}\n${block}` : block

				return await next({ ...payload, systemPrompt })
			},
		)

		const removeTurnEnd = ctx.events.bail(
			"turn/end",
			(payload: TurnEndPayload): TurnEndResult | undefined => {
				const tasks = sessionTasks.get(payload.sessionId) ?? []
				const open = tasks.filter((t) => t.status !== "done")
				if (open.length === 0) return undefined

				const titles = open.map((t) => t.title).join(", ")
				return {
					followUp: `Open tasks remain: ${titles}. Continue, or mark them done via update_tasks.`,
				}
			},
		)

		return () => {
			unregisterTool()
			removePreStep()
			removeTurnEnd()
			sessionTasks.clear()
		}
	},
}
