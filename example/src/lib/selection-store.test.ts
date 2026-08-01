/** @file Tests for the provider + model selection's pure persistence helpers. */

import { describe, expect, it } from "vitest"
import { type Selection, loadSelection, saveSelection } from "./selection-store.js"

/** An in-memory `Storage` stand-in, so persistence is testable without a browser. */
function fakeStorage(initial: Record<string, string> = {}): Storage {
	const data = new Map(Object.entries(initial))
	return {
		get length() {
			return data.size
		},
		clear: () => data.clear(),
		getItem: (key: string) => data.get(key) ?? null,
		key: (index: number) => Array.from(data.keys())[index] ?? null,
		removeItem: (key: string) => data.delete(key),
		setItem: (key: string, value: string) => {
			data.set(key, value)
		},
	} as Storage
}

/** A `Storage` whose writes always fail, as in private mode or when over quota. */
function brokenStorage(): Storage {
	return {
		...fakeStorage(),
		getItem: () => {
			throw new Error("storage disabled")
		},
		setItem: () => {
			throw new Error("quota exceeded")
		},
	} as unknown as Storage
}

describe("loadSelection / saveSelection", () => {
	it("round-trips a provider + model selection", () => {
		const storage = fakeStorage()
		const selection: Selection = { provider: "ollama", modelId: "qwen2.5:7b" }

		expect(saveSelection(selection, storage)).toBe(true)
		expect(loadSelection(storage)).toEqual(selection)
	})

	it("round-trips the 'all' provider with no model chosen yet", () => {
		const storage = fakeStorage()
		const selection: Selection = { provider: "all", modelId: "" }

		expect(saveSelection(selection, storage)).toBe(true)
		expect(loadSelection(storage)).toEqual(selection)
	})

	it("returns null when nothing is stored", () => {
		expect(loadSelection(fakeStorage())).toBeNull()
	})

	it("returns null for corrupt JSON rather than throwing", () => {
		const storage = fakeStorage({ "bhzai.selection": "{not json" })
		expect(loadSelection(storage)).toBeNull()
	})

	it("discards a payload from an unknown schema version", () => {
		const storage = fakeStorage({
			"bhzai.selection": JSON.stringify({ v: 99, provider: "ollama", modelId: "x" }),
		})
		expect(loadSelection(storage)).toBeNull()
	})

	it("discards a payload with the wrong shape", () => {
		const storage = fakeStorage({
			"bhzai.selection": JSON.stringify({ v: 1, provider: "ollama" }),
		})
		expect(loadSelection(storage)).toBeNull()
	})

	it("survives storage that throws on read and on write", () => {
		const storage = brokenStorage()
		expect(loadSelection(storage)).toBeNull()
		expect(saveSelection({ provider: "all", modelId: "" }, storage)).toBe(false)
	})
})
