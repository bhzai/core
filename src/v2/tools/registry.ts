import type { ToolWireDefinition } from "../../types/driver"
import type { ToolDefinition, ToolFilter } from "./types"

/**
 * Manages tool registration with LIFO shadowing and query filtering.
 */
export class ToolRegistry {
	private readonly toolStacks = new Map<string, ToolDefinition[]>()

	/**
	 * Registers a tool definition. If a tool with the same name already exists,
	 * shadows it until the returned disposable is called.
	 * @param tool The tool definition to register.
	 * @returns A cleanup function restoring any shadowed definition.
	 */
	register(tool: ToolDefinition): () => void {
		let stack = this.toolStacks.get(tool.name)
		if (!stack) {
			stack = []
			this.toolStacks.set(tool.name, stack)
		}
		stack.push(tool)

		return () => {
			const current = this.toolStacks.get(tool.name)
			if (!current) return

			const idx = current.lastIndexOf(tool)
			if (idx !== -1) {
				current.splice(idx, 1)
			}
			if (current.length === 0) {
				this.toolStacks.delete(tool.name)
			}
		}
	}

	/**
	 * Retrieves the active tool definition for a given name.
	 * @param name Tool name identifier.
	 */
	get(name: string): ToolDefinition | undefined {
		const stack = this.toolStacks.get(name)
		if (!stack || stack.length === 0) return undefined
		return stack[stack.length - 1]
	}

	/**
	 * Checks whether a tool with the given name is registered.
	 * @param name Tool name identifier.
	 */
	has(name: string): boolean {
		const stack = this.toolStacks.get(name)
		return Boolean(stack && stack.length > 0)
	}

	/**
	 * Lists all currently active tools matching the optional filter criteria.
	 * @param filter Optional allow/deny or tag filters.
	 */
	list(filter?: ToolFilter): ToolDefinition[] {
		const active: ToolDefinition[] = []
		for (const stack of this.toolStacks.values()) {
			if (stack.length > 0) {
				active.push(stack[stack.length - 1])
			}
		}

		return active.filter((t) => this.matchesFilter(t, filter))
	}

	/**
	 * Projects active tools to wire definitions for model driver requests.
	 * @param filter Optional filter criteria.
	 */
	projectWireTools(filter?: ToolFilter): ToolWireDefinition[] {
		return this.list(filter).map((t) => ({
			name: t.name,
			description: t.description,
			inputSchema: t.inputSchema,
		}))
	}

	private matchesFilter(tool: ToolDefinition, filter?: ToolFilter): boolean {
		if (!filter) return true

		if (filter.allow && !filter.allow.includes(tool.name)) {
			return false
		}
		if (filter.deny?.includes(tool.name)) {
			return false
		}
		if (filter.tags && (!tool.tags || !tool.tags.some((t) => filter.tags?.includes(t)))) {
			return false
		}
		if (filter.excludeTags && tool.tags?.some((t) => filter.excludeTags?.includes(t))) {
			return false
		}

		return true
	}
}
