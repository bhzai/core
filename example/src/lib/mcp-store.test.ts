/** @file Tests for the MCP panel's pure helpers. */

import { describe, expect, it } from "vitest"
import {
	errorHint,
	loadServers,
	parseHeaderLines,
	saveServers,
	validateServerUrl,
} from "./mcp-store.js"

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

describe("loadServers / saveServers", () => {
	it("round-trips a server list", () => {
		const storage = fakeStorage()
		const servers = [
			{ url: "https://a.example/mcp", name: "a", headers: { Authorization: "Bearer x" } },
			{ url: "https://b.example/mcp" },
		]

		expect(saveServers(servers, storage)).toBe(true)
		expect(loadServers(storage)).toEqual(servers)
	})

	it("returns an empty list when nothing is stored", () => {
		expect(loadServers(fakeStorage())).toEqual([])
	})

	it("returns an empty list for corrupt JSON rather than throwing", () => {
		const storage = fakeStorage({ "bhzai.mcp.servers": "{not json" })
		expect(loadServers(storage)).toEqual([])
	})

	it("discards a payload from an unknown schema version", () => {
		const storage = fakeStorage({
			"bhzai.mcp.servers": JSON.stringify({ v: 99, servers: [{ url: "https://a.example/mcp" }] }),
		})
		expect(loadServers(storage)).toEqual([])
	})

	it("discards entries with no usable url", () => {
		const storage = fakeStorage({
			"bhzai.mcp.servers": JSON.stringify({
				v: 1,
				servers: [{ url: "https://ok.example/mcp" }, { name: "no url" }, null, { url: "" }],
			}),
		})
		expect(loadServers(storage)).toEqual([{ url: "https://ok.example/mcp" }])
	})

	it("survives storage that throws on read and on write", () => {
		const storage = brokenStorage()
		expect(loadServers(storage)).toEqual([])
		expect(saveServers([{ url: "https://a.example/mcp" }], storage)).toBe(false)
	})
})

describe("parseHeaderLines", () => {
	it("parses one Key: Value per line", () => {
		const { headers, errors } = parseHeaderLines("Authorization: Bearer abc\nX-Tenant: acme")
		expect(headers).toEqual({ Authorization: "Bearer abc", "X-Tenant": "acme" })
		expect(errors).toEqual([])
	})

	it("splits on the first colon only, so values may contain colons", () => {
		const { headers } = parseHeaderLines("X-Origin: https://example.com:8443/path")
		expect(headers["X-Origin"]).toBe("https://example.com:8443/path")
	})

	it("ignores blank lines and surrounding whitespace", () => {
		const { headers, errors } = parseHeaderLines("\n  Authorization :  Bearer abc  \n\n")
		expect(headers).toEqual({ Authorization: "Bearer abc" })
		expect(errors).toEqual([])
	})

	it("reports a malformed line instead of dropping it silently", () => {
		const { headers, errors } = parseHeaderLines("Authorization Bearer abc\nX-Ok: 1")
		expect(headers).toEqual({ "X-Ok": "1" })
		expect(errors).toHaveLength(1)
		expect(errors[0]).toContain("Line 1")
	})

	it("reports an empty header name", () => {
		const { errors } = parseHeaderLines(": value")
		expect(errors).toHaveLength(1)
	})

	it("allows an empty header value", () => {
		const { headers, errors } = parseHeaderLines("X-Empty:")
		expect(headers).toEqual({ "X-Empty": "" })
		expect(errors).toEqual([])
	})

	it("returns empty results for empty input", () => {
		expect(parseHeaderLines("")).toEqual({ headers: {}, errors: [] })
	})
})

describe("validateServerUrl", () => {
	it("accepts http and https endpoints", () => {
		expect(validateServerUrl("https://example.com/mcp")).toBeNull()
		expect(validateServerUrl("http://localhost:3000/mcp")).toBeNull()
	})

	it("rejects an empty entry", () => {
		expect(validateServerUrl("")).toMatch(/Enter the server/)
		expect(validateServerUrl("   ")).toMatch(/Enter the server/)
	})

	it("rejects a URL with no scheme", () => {
		expect(validateServerUrl("example.com/mcp")).toMatch(/not a valid URL/)
	})

	it("rejects non-HTTP transports — this client speaks streamable HTTP only", () => {
		expect(validateServerUrl("ws://example.com/mcp")).toMatch(/Only HTTP MCP servers/)
		expect(validateServerUrl("file:///tmp/mcp")).toMatch(/Only HTTP MCP servers/)
	})
})

describe("errorHint", () => {
	it("explains the opaque TypeError a CORS rejection produces", () => {
		const hint = errorHint({ name: "TypeError", message: "Failed to fetch" })
		expect(hint).toMatch(/CORS/)
	})

	it("matches the network-failure wording of other browsers", () => {
		expect(errorHint({ name: "Error", message: "NetworkError when attempting to fetch" })).toMatch(
			/CORS/,
		)
		expect(errorHint({ name: "Error", message: "Load failed" })).toMatch(/CORS/)
	})

	it("points at credentials for 401/403", () => {
		expect(errorHint({ name: "McpHandshakeError", message: "MCP HTTP 401 Unauthorized" })).toMatch(
			/Authorization header/,
		)
	})

	it("points at the endpoint path for 404", () => {
		expect(errorHint({ name: "McpHandshakeError", message: "MCP HTTP 404 Not Found" })).toMatch(
			/\/mcp/,
		)
	})

	it("names the SSE gap when the server streams its response", () => {
		expect(
			errorHint({ name: "McpHandshakeError", message: "MCP response was an SSE stream" }),
		).toMatch(/application\/json/)
	})

	it("returns null when the message already speaks for itself", () => {
		expect(
			errorHint({ name: "McpHandshakeError", message: "tools/list returned garbage" }),
		).toBeNull()
		expect(errorHint(null)).toBeNull()
		expect(errorHint(undefined)).toBeNull()
	})
})
