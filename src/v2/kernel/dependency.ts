import { CircularPluginDependencyError, MissingPluginDependencyError } from "./errors"
import type { PluginDefinition } from "./types"

/**
 * Topologically sorts an array of plugin definitions according to declared dependencies.
 * @param plugins Array of plugin definitions to sort.
 * @param loadedPluginNames Set of plugin names already loaded in the harness.
 * @returns Sorted array of plugins in executable dependency order.
 * @throws {MissingPluginDependencyError} When a dependency cannot be satisfied.
 * @throws {CircularPluginDependencyError} When a circular dependency is detected.
 */
export function sortPluginsTopologically(
	plugins: PluginDefinition[],
	loadedPluginNames: Set<string> = new Set(),
): PluginDefinition[] {
	const pluginMap = new Map<string, PluginDefinition>()
	for (const p of plugins) {
		pluginMap.set(p.name, p)
	}

	// 1. Verify missing dependencies
	for (const p of plugins) {
		for (const dep of p.dependencies || []) {
			if (!pluginMap.has(dep) && !loadedPluginNames.has(dep)) {
				throw new MissingPluginDependencyError(p.name, dep)
			}
		}
	}

	// 2. DFS topological sort with cycle detection
	const visited = new Map<string, number>() // 0: unvisited, 1: visiting, 2: visited
	const sorted: PluginDefinition[] = []
	const pathStack: string[] = []

	function visit(pluginName: string): void {
		const state = visited.get(pluginName) ?? 0
		if (state === 2) return
		if (state === 1) {
			const cycleStart = pathStack.indexOf(pluginName)
			const cycle = pathStack.slice(cycleStart).concat(pluginName)
			throw new CircularPluginDependencyError(cycle)
		}

		visited.set(pluginName, 1)
		pathStack.push(pluginName)

		const def = pluginMap.get(pluginName)
		if (def) {
			for (const dep of def.dependencies || []) {
				if (pluginMap.has(dep)) {
					visit(dep)
				}
			}
			sorted.push(def)
		}

		pathStack.pop()
		visited.set(pluginName, 2)
	}

	for (const p of plugins) {
		if ((visited.get(p.name) ?? 0) === 0) {
			visit(p.name)
		}
	}

	return sorted
}

/**
 * Computes all dependent plugins that must be unloaded prior to unloading a target plugin.
 * @param targetName Name of the plugin scheduled for unloading.
 * @param loadedPlugins Map of currently loaded plugins and their definitions.
 * @returns Ordered list of plugin names to unload (dependents first, target last).
 */
export function getDependentsCascade(
	targetName: string,
	loadedPlugins: Map<string, { definition: PluginDefinition }>,
): string[] {
	const reverseGraph = new Map<string, Set<string>>()
	for (const [name, state] of loadedPlugins) {
		for (const dep of state.definition.dependencies || []) {
			let set = reverseGraph.get(dep)
			if (!set) {
				set = new Set()
				reverseGraph.set(dep, set)
			}
			set.add(name)
		}
	}

	const toUnload: string[] = []
	const visited = new Set<string>()

	function collect(current: string): void {
		if (visited.has(current)) return
		visited.add(current)
		const dependents = reverseGraph.get(current)
		if (dependents) {
			for (const dep of dependents) {
				collect(dep)
			}
		}
		toUnload.push(current)
	}

	collect(targetName)
	return toUnload
}
