/** @file Tests for the providers panel's pure helpers. */

import { describe, expect, it } from "vitest"
import {
	DEFAULT_PROVIDER_API,
	type ProviderConfig,
	loadProviders,
	normalizeBaseUrl,
	providerKindFromLabel,
	providerLabel,
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
	it("round-trips a mixed-kind provider list", () => {
		const storage = fakeStorage()
		const providers: ProviderConfig[] = [
			{ id: "a", kind: "ollama", baseUrl: "http://localhost:11434", token: "" },
			{ id: "b", kind: "lmstudio", baseUrl: "http://localhost:1234", token: "Bearer abc" },
		]

		expect(saveProviders(providers, storage)).toBe(true)
		expect(loadProviders(storage)).toEqual(providers)
	})

	it("returns an empty list when nothing is stored", () => {
		expect(loadProviders(fakeStorage())).toEqual([])
	})

	it("returns an empty list for corrupt JSON rather than throwing", () => {
		const storage = fakeStorage({ "bhzai.providers": "{not json" })
		expect(loadProviders(storage)).toEqual([])
	})

	it("discards a payload from an unknown schema version", () => {
		const storage = fakeStorage({
			"bhzai.providers": JSON.stringify({
				v: 99,
				providers: [{ id: "a", kind: "ollama", baseUrl: "http://localhost:11434", token: "" }],
			}),
		})
		expect(loadProviders(storage)).toEqual([])
	})

	it("ignores the pre-v2 ollama-only key rather than migrating it", () => {
		const storage = fakeStorage({
			"bhzai.providers.ollama": JSON.stringify({
				v: 1,
				providers: [{ id: "a", baseUrl: "http://localhost:11434", token: "" }],
			}),
		})
		expect(loadProviders(storage)).toEqual([])
	})

	it("discards entries with no usable id, kind, or baseUrl", () => {
		const storage = fakeStorage({
			"bhzai.providers": JSON.stringify({
				v: 2,
				providers: [
					{ id: "ok", kind: "ollama", baseUrl: "http://localhost:11434", token: "" },
					{ kind: "ollama", baseUrl: "http://no-id:11434", token: "" },
					{ id: "no-url", kind: "ollama", token: "" },
					{ id: "bad-kind", kind: "vllm", baseUrl: "http://x:8000", token: "" },
					{ id: "no-kind", baseUrl: "http://x:11434", token: "" },
					null,
					{ id: "", kind: "ollama", baseUrl: "http://empty-id:11434", token: "" },
				],
			}),
		})
		expect(loadProviders(storage)).toEqual([
			{ id: "ok", kind: "ollama", baseUrl: "http://localhost:11434", token: "" },
		])
	})

	it("survives storage that throws on read and on write", () => {
		const storage = brokenStorage()
		expect(loadProviders(storage)).toEqual([])
		expect(
			saveProviders(
				[{ id: "a", kind: "ollama", baseUrl: "http://localhost:11434", token: "" }],
				storage,
			),
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

	it("strips LM Studio's /api/v0 and /v1 suffixes", () => {
		expect(normalizeBaseUrl("http://localhost:1234/api/v0")).toBe("http://localhost:1234")
		expect(normalizeBaseUrl("http://localhost:1234/api/v0/")).toBe("http://localhost:1234")
		expect(normalizeBaseUrl("http://localhost:1234/v1")).toBe("http://localhost:1234")
	})

	it("strips a trailing slash from a bare root", () => {
		expect(normalizeBaseUrl("http://localhost:11434/")).toBe("http://localhost:11434")
	})

	it("leaves a bare root untouched", () => {
		expect(normalizeBaseUrl("http://localhost:1234")).toBe("http://localhost:1234")
	})

	it("leaves a root with a path prefix untouched (no API suffix)", () => {
		expect(normalizeBaseUrl("http://host/ollama")).toBe("http://host/ollama")
	})

	it("strips the API segment case-insensitively", () => {
		expect(normalizeBaseUrl("http://localhost:11434/API")).toBe("http://localhost:11434")
		expect(normalizeBaseUrl("http://localhost:1234/API/V0")).toBe("http://localhost:1234")
	})

	it("trims surrounding whitespace", () => {
		expect(normalizeBaseUrl("  http://localhost:11434/api  ")).toBe("http://localhost:11434")
	})
})

describe("validateApiUrl", () => {
	it("accepts http and https addresses", () => {
		expect(validateApiUrl("http://localhost:11434/api", "ollama")).toBeNull()
		expect(validateApiUrl("https://gpu.example:11434", "ollama")).toBeNull()
		expect(validateApiUrl("http://localhost:1234", "lmstudio")).toBeNull()
	})

	it("rejects an empty entry, naming the provider", () => {
		expect(validateApiUrl("", "ollama")).toMatch(/Enter the Ollama/)
		expect(validateApiUrl("   ", "lmstudio")).toMatch(/Enter the LM Studio/)
	})

	it("rejects a URL with no scheme and suggests that kind's default", () => {
		expect(validateApiUrl("example.com/ollama", "ollama")).toContain(DEFAULT_PROVIDER_API.ollama)
		expect(validateApiUrl("example.com", "lmstudio")).toContain(DEFAULT_PROVIDER_API.lmstudio)
	})

	it("rejects non-HTTP transports — both drivers speak HTTP only", () => {
		expect(validateApiUrl("ws://localhost:11434", "ollama")).toMatch(/Only HTTP Ollama servers/)
		expect(validateApiUrl("file:///tmp/lmstudio", "lmstudio")).toMatch(
			/Only HTTP LM Studio servers/,
		)
	})
})

describe("provider labels", () => {
	it("maps a kind to its display label and back", () => {
		expect(providerLabel("lmstudio")).toBe("LM Studio")
		expect(providerKindFromLabel("LM Studio")).toBe("lmstudio")
		expect(providerKindFromLabel("Ollama")).toBe("ollama")
	})

	it("falls back to the raw value for an unknown kind and to ollama for an unknown label", () => {
		expect(providerLabel("vllm")).toBe("vllm")
		expect(providerKindFromLabel("Nonsense")).toBe("ollama")
	})
})
