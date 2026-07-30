/** @file Tests for the providers panel's pure helpers. */

import { describe, expect, it } from "vitest"
import {
	type OllamaProviderConfig,
	loadProviders,
	normalizeBaseUrl,
	saveProviders,
	validateApiUrl,
} from "./provider-store.js"

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

describe("loadProviders / saveProviders", () => {
	it("round-trips a provider list", () => {
		const storage = fakeStorage()
		const providers: OllamaProviderConfig[] = [
			{ id: "a", baseUrl: "http://localhost:11434", token: "" },
			{ id: "b", baseUrl: "http://gpu.box:11434", token: "Bearer abc" },
		]

		expect(saveProviders(providers, storage)).toBe(true)
		expect(loadProviders(storage)).toEqual(providers)
	})

	it("returns an empty list when nothing is stored", () => {
		expect(loadProviders(fakeStorage())).toEqual([])
	})

	it("returns an empty list for corrupt JSON rather than throwing", () => {
		const storage = fakeStorage({ "bhzai.providers.ollama": "{not json" })
		expect(loadProviders(storage)).toEqual([])
	})

	it("discards a payload from an unknown schema version", () => {
		const storage = fakeStorage({
			"bhzai.providers.ollama": JSON.stringify({
				v: 99,
				providers: [{ id: "a", baseUrl: "http://localhost:11434", token: "" }],
			}),
		})
		expect(loadProviders(storage)).toEqual([])
	})

	it("discards entries with no usable id or baseUrl", () => {
		const storage = fakeStorage({
			"bhzai.providers.ollama": JSON.stringify({
				v: 1,
				providers: [
					{ id: "ok", baseUrl: "http://localhost:11434", token: "" },
					{ baseUrl: "http://no-id:11434", token: "" },
					{ id: "no-url", token: "" },
					null,
					{ id: "", baseUrl: "http://empty-id:11434", token: "" },
				],
			}),
		})
		expect(loadProviders(storage)).toEqual([
			{ id: "ok", baseUrl: "http://localhost:11434", token: "" },
		])
	})

	it("survives storage that throws on read and on write", () => {
		const storage = brokenStorage()
		expect(loadProviders(storage)).toEqual([])
		expect(
			saveProviders([{ id: "a", baseUrl: "http://localhost:11434", token: "" }], storage),
		).toBe(false)
	})
})

describe("normalizeBaseUrl", () => {
	it("strips a trailing /api", () => {
		expect(normalizeBaseUrl("http://localhost:11434/api")).toBe("http://localhost:11434")
	})

	it("strips a trailing slash before /api", () => {
		expect(normalizeBaseUrl("http://localhost:11434/api/")).toBe("http://localhost:11434")
	})

	it("strips a trailing slash from a bare root", () => {
		expect(normalizeBaseUrl("http://localhost:11434/")).toBe("http://localhost:11434")
	})

	it("leaves a bare root untouched", () => {
		expect(normalizeBaseUrl("http://localhost:11434")).toBe("http://localhost:11434")
	})

	it("leaves a root with a path prefix untouched (no /api suffix)", () => {
		expect(normalizeBaseUrl("http://host/ollama")).toBe("http://host/ollama")
	})

	it("strips /api case-insensitively", () => {
		expect(normalizeBaseUrl("http://localhost:11434/API")).toBe("http://localhost:11434")
	})

	it("trims surrounding whitespace", () => {
		expect(normalizeBaseUrl("  http://localhost:11434/api  ")).toBe("http://localhost:11434")
	})
})

describe("validateApiUrl", () => {
	it("accepts http and https addresses", () => {
		expect(validateApiUrl("http://localhost:11434/api")).toBeNull()
		expect(validateApiUrl("https://gpu.example:11434")).toBeNull()
	})

	it("rejects an empty entry", () => {
		expect(validateApiUrl("")).toMatch(/Enter the Ollama/)
		expect(validateApiUrl("   ")).toMatch(/Enter the Ollama/)
	})

	it("rejects a URL with no scheme", () => {
		expect(validateApiUrl("example.com/ollama")).toMatch(/not a valid URL/)
	})

	it("rejects non-HTTP transports — the Ollama plugin speaks HTTP only", () => {
		expect(validateApiUrl("ws://localhost:11434")).toMatch(/Only HTTP Ollama servers/)
		expect(validateApiUrl("file:///tmp/ollama")).toMatch(/Only HTTP Ollama servers/)
	})
})
