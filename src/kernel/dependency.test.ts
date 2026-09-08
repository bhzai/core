import { describe, expect, it } from "vitest"
import { getDependentsCascade, sortPluginsTopologically } from "./dependency"
import { CircularPluginDependencyError, MissingPluginDependencyError } from "./errors"
import type { PluginDefinition } from "./types"

describe("sortPluginsTopologically", () => {
	it("orders independent plugins without errors", () => {
		const plugins: PluginDefinition[] = [
			{ name: "a", setup: () => {} },
			{ name: "b", setup: () => {} },
		]
		const sorted = sortPluginsTopologically(plugins)
		expect(sorted.map((p) => p.name)).toEqual(["a", "b"])
	})

	it("orders dependencies before dependents", () => {
		const plugins: PluginDefinition[] = [
			{ name: "loop", dependencies: ["llm", "tools"], setup: () => {} },
			{ name: "llm", setup: () => {} },
			{ name: "tools", setup: () => {} },
		]
		const sorted = sortPluginsTopologically(plugins)
		const names = sorted.map((p) => p.name)

		expect(names.indexOf("llm")).toBeLessThan(names.indexOf("loop"))
		expect(names.indexOf("tools")).toBeLessThan(names.indexOf("loop"))
	})

	it("recognizes dependencies that are already loaded in harness", () => {
		const plugins: PluginDefinition[] = [
			{ name: "compaction", dependencies: ["sessions"], setup: () => {} },
		]
		const loaded = new Set(["sessions"])
		const sorted = sortPluginsTopologically(plugins, loaded)
		expect(sorted.map((p) => p.name)).toEqual(["compaction"])
	})

	it("throws MissingPluginDependencyError when dependency is not satisfied", () => {
		const plugins: PluginDefinition[] = [
			{ name: "agent", dependencies: ["non-existent"], setup: () => {} },
		]
		expect(() => sortPluginsTopologically(plugins)).toThrow(MissingPluginDependencyError)
	})

	it("throws CircularPluginDependencyError when a direct cycle exists", () => {
		const plugins: PluginDefinition[] = [
			{ name: "alpha", dependencies: ["beta"], setup: () => {} },
			{ name: "beta", dependencies: ["alpha"], setup: () => {} },
		]
		expect(() => sortPluginsTopologically(plugins)).toThrow(CircularPluginDependencyError)
	})

	it("throws CircularPluginDependencyError when an indirect cycle exists", () => {
		const plugins: PluginDefinition[] = [
			{ name: "a", dependencies: ["b"], setup: () => {} },
			{ name: "b", dependencies: ["c"], setup: () => {} },
			{ name: "c", dependencies: ["a"], setup: () => {} },
		]
		expect(() => sortPluginsTopologically(plugins)).toThrow(CircularPluginDependencyError)
	})
})

describe("getDependentsCascade", () => {
	it("returns only the target plugin when no dependents exist", () => {
		const loaded = new Map<string, { definition: PluginDefinition }>()
		loaded.set("leaf", { definition: { name: "leaf", setup: () => {} } })

		const cascade = getDependentsCascade("leaf", loaded)
		expect(cascade).toEqual(["leaf"])
	})

	it("returns dependents in reverse order ending with the target", () => {
		const loaded = new Map<string, { definition: PluginDefinition }>()
		loaded.set("base", { definition: { name: "base", setup: () => {} } })
		loaded.set("mid", { definition: { name: "mid", dependencies: ["base"], setup: () => {} } })
		loaded.set("top", { definition: { name: "top", dependencies: ["mid"], setup: () => {} } })

		const cascade = getDependentsCascade("base", loaded)
		expect(cascade).toEqual(["top", "mid", "base"])
	})
})
