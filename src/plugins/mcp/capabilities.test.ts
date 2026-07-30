// TASK_0014 — MCP client capabilities tests (elicitation, sampling, roots).
//
// These tests exercise:
//  - `buildClientCapabilities`'s key-presence-based construction.
//  - `handleElicitation` (opt-in gate, observability emit, accept/decline/
//    cancel, schema validation, handler-thrown error).
//  - `handleSampling` (opt-in gate, approval reuse, driver selection,
//    driver.chat() consumption, error paths).
//  - `handleRootsList` (opt-in gate, getRoots() success/throw).
//  - `McpClient` wiring: handshake capabilities object, inbound request
//    dispatch, `notifyRootsChanged()` notification.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { EventBus } from "../../core/event-bus.js"
import { ToolRegistry } from "../../tools/registry.js"
import type { BHZAIDriver, DriverEvent } from "../../types/index.js"
import {
	type ElicitRequest,
	type ElicitResponse,
	type McpClientCapabilityOptions,
	type Root,
	type SamplingDriverRegistry,
	buildClientCapabilities,
	handleElicitation,
	handleRootsList,
	handleSampling,
	rootsListChangedNotification,
} from "./capabilities.js"
import { McpClient } from "./client.js"

// ---------------------------------------------------------------------------
// Mock-fetch helpers (mirrors client.test.ts's pattern).
// ---------------------------------------------------------------------------

interface FetchCall {
	readonly url: string
	readonly init: RequestInit
}

function jsonResponse(
	body: unknown,
	opts: { sessionId?: string | null; status?: number } = {},
): Response {
	const headers = new Headers({ "Content-Type": "application/json" })
	if (opts.sessionId !== null) {
		headers.set("Mcp-Session-Id", opts.sessionId ?? "test-session-id")
	}
	return new Response(JSON.stringify(body), {
		status: opts.status ?? 200,
		headers,
	})
}

function acceptedResponse(): Response {
	return new Response(null, { status: 202 })
}

function installFetchSequence(responses: Response[]): {
	fetch: ReturnType<typeof vi.fn>
	calls: () => FetchCall[]
} {
	const calls: FetchCall[] = []
	let i = 0
	const fetchMock = vi.fn(async (url: string, init: RequestInit): Promise<Response> => {
		calls.push({ url, init })
		const response = responses[i]
		i++
		if (!response) {
			throw new Error(`test fetch mock: ran out of canned responses (call #${i} for ${url})`)
		}
		return response
	})
	vi.stubGlobal("fetch", fetchMock)
	return { fetch: fetchMock, calls: () => calls }
}

function rpcBody(call: FetchCall): { method: string; params?: unknown; id?: string | number } {
	const raw = call.init.body as string
	return JSON.parse(raw)
}

function initResult(): unknown {
	return {
		jsonrpc: "2.0",
		id: "ignored",
		result: {
			protocolVersion: "2025-11-25",
			capabilities: { tools: { listChanged: false } },
			serverInfo: { name: "test-server", version: "1.0.0" },
		},
	}
}

async function flush(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 0))
}

/**
 * TASK_0016: deferred clients now fetch tools/list (to cache) during
 * connect(), so tests using `deferred: true` need a 3rd response. This
 * helper builds the standard 3-response sequence (initialize →
 * initialized → empty tools/list).
 */
function deferredHandshakeResponses(): Response[] {
	return [
		jsonResponse(initResult()),
		acceptedResponse(),
		jsonResponse({ jsonrpc: "2.0", id: "x", result: { tools: [] } }),
	]
}

beforeEach(() => {})
afterEach(() => {
	vi.unstubAllGlobals()
	vi.restoreAllMocks()
})

// ---------------------------------------------------------------------------
// buildClientCapabilities — key-presence-based construction.
// ---------------------------------------------------------------------------

describe("buildClientCapabilities — key-presence-based construction", () => {
	it("returns an empty object when no opt-ins are supplied", () => {
		expect(buildClientCapabilities(undefined)).toEqual({})
	})

	it("includes only the elicitation key when only elicitation is opted in", () => {
		const opts: McpClientCapabilityOptions = {
			elicitation: { onElicit: async () => ({ action: "decline" }) },
		}
		expect(buildClientCapabilities(opts)).toEqual({ elicitation: {} })
	})

	it("includes only the sampling key when only sampling is opted in", () => {
		const opts: McpClientCapabilityOptions = { sampling: {} }
		expect(buildClientCapabilities(opts)).toEqual({ sampling: {} })
	})

	it("includes only the roots key when only roots is opted in", () => {
		const opts: McpClientCapabilityOptions = { roots: { getRoots: () => [] } }
		expect(buildClientCapabilities(opts)).toEqual({ roots: {} })
	})

	it("includes all three keys when all opt-ins are supplied", () => {
		const opts: McpClientCapabilityOptions = {
			elicitation: { onElicit: async () => ({ action: "decline" }) },
			sampling: {},
			roots: { getRoots: () => [] },
		}
		expect(buildClientCapabilities(opts)).toEqual({
			elicitation: {},
			sampling: {},
			roots: {},
		})
	})

	it("does not include absent keys with false/empty values — key PRESENCE is the signal", () => {
		// An empty object opts (no keys) yields no capability keys.
		expect(buildClientCapabilities({})).toEqual({})
	})
})

// ---------------------------------------------------------------------------
// handleElicitation — opt-in gate, observability emit, accept/decline/cancel.
// ---------------------------------------------------------------------------

describe("handleElicitation", () => {
	it("returns method-not-found error when elicitation is not opted in", async () => {
		const result = await handleElicitation("id-1", { message: "hi" }, undefined, undefined)
		expect(result.error?.code).toBe(-32601)
		expect(result.error?.message).toMatch(/elicitation\/create/)
		expect(result.result).toBeUndefined()
	})

	it("calls onElicit and returns its accept response", async () => {
		const onElicit = vi.fn(
			async (req: ElicitRequest): Promise<ElicitResponse> => ({
				action: "accept",
				content: { name: "Alice" },
			}),
		)
		const opts: McpClientCapabilityOptions = { elicitation: { onElicit } }
		const result = await handleElicitation("id-2", { message: "Name?" }, opts, undefined)
		expect(onElicit).toHaveBeenCalledTimes(1)
		expect(onElicit).toHaveBeenCalledWith({ message: "Name?" })
		expect(result.result).toEqual({ action: "accept", content: { name: "Alice" } })
		expect(result.error).toBeUndefined()
	})

	it("calls onElicit and returns its decline response", async () => {
		const onElicit = vi.fn(async (): Promise<ElicitResponse> => ({ action: "decline" }))
		const opts: McpClientCapabilityOptions = { elicitation: { onElicit } }
		const result = await handleElicitation("id-3", { message: "hi" }, opts, undefined)
		expect(result.result).toEqual({ action: "decline" })
	})

	it("calls onElicit and returns its cancel response", async () => {
		const onElicit = vi.fn(async (): Promise<ElicitResponse> => ({ action: "cancel" }))
		const opts: McpClientCapabilityOptions = { elicitation: { onElicit } }
		const result = await handleElicitation("id-4", { message: "hi" }, opts, undefined)
		expect(result.result).toEqual({ action: "cancel" })
	})

	it("emits mcp.elicitation observability event through the bus (does not override onElicit)", async () => {
		const bus = { dispatch: vi.fn(async () => {}) }
		const onElicit = vi.fn(async (): Promise<ElicitResponse> => ({ action: "accept", content: {} }))
		const opts: McpClientCapabilityOptions = { elicitation: { onElicit } }
		await handleElicitation("id-5", { message: "hi" }, opts, bus)
		expect(bus.dispatch).toHaveBeenCalledTimes(1)
		expect(bus.dispatch).toHaveBeenCalledWith("mcp.elicitation", expect.any(Object))
		// onElicit still ran (the emit did not override it).
		expect(onElicit).toHaveBeenCalledTimes(1)
	})

	it("onElicit is authoritative even if the bus dispatch throws", async () => {
		const bus = {
			dispatch: vi.fn(async () => {
				throw new Error("observer failed")
			}),
		}
		const onElicit = vi.fn(async (): Promise<ElicitResponse> => ({ action: "accept", content: {} }))
		const opts: McpClientCapabilityOptions = { elicitation: { onElicit } }
		const result = await handleElicitation("id-6", { message: "hi" }, opts, bus)
		// The throwing observer did not break the handler.
		expect(result.result).toEqual({ action: "accept", content: {} })
		expect(onElicit).toHaveBeenCalledTimes(1)
	})

	it("validates content against requestedSchema on accept and returns invalid-params on mismatch", async () => {
		const onElicit = vi.fn(
			async (): Promise<ElicitResponse> => ({
				action: "accept",
				content: { name: 123 }, // wrong type — schema expects string
			}),
		)
		const opts: McpClientCapabilityOptions = { elicitation: { onElicit } }
		const validate = (schema: unknown, data: unknown): boolean => {
			// Trivial validator: checks `name` is a string.
			const s = schema as { properties?: { name?: { type?: string } } }
			const expectedType = s.properties?.name?.type
			if (expectedType === "string") {
				return typeof (data as { name?: unknown }).name === "string"
			}
			return true
		}
		const result = await handleElicitation(
			"id-7",
			{ message: "hi", requestedSchema: { properties: { name: { type: "string" } } } },
			opts,
			undefined,
			validate,
		)
		expect(result.error?.code).toBe(-32602)
		expect(result.error?.message).toMatch(/requestedSchema/)
	})

	it("returns internal-error when onElicit throws", async () => {
		const onElicit = vi.fn(async () => {
			throw new Error("host UI crashed")
		})
		const opts: McpClientCapabilityOptions = { elicitation: { onElicit } }
		const result = await handleElicitation("id-8", { message: "hi" }, opts, undefined)
		expect(result.error?.code).toBe(-32603)
		expect(result.error?.message).toMatch(/host UI crashed/)
	})
})

// ---------------------------------------------------------------------------
// handleSampling — opt-in gate, approval reuse, driver selection.
// ---------------------------------------------------------------------------

/** A mock driver that yields a fixed delta + done. */
function mockDriver(id: string, text: string): BHZAIDriver {
	const chat = async function* (): AsyncIterable<DriverEvent> {
		yield { type: "delta", text }
		yield { type: "done", stopReason: "stop" }
	}
	return {
		id,
		listModels: async () => [
			{
				ref: `${id}/m1`,
				driver: id,
				id: "m1",
				capabilities: { streaming: true, toolCalls: false, reasoning: false },
				availability: "ready",
			},
		],
		capabilities: () => ({ streaming: true, toolCalls: false, reasoning: false }),
		chat,
	}
}

function mockDriverRegistry(drivers: BHZAIDriver[]): SamplingDriverRegistry {
	return {
		getDriver: (id) => drivers.find((d) => d.id === id),
		drivers: () => drivers,
	}
}

describe("handleSampling", () => {
	it("returns method-not-found error when sampling is not opted in", async () => {
		const drivers = mockDriverRegistry([mockDriver("d", "hi")])
		const result = await handleSampling(
			"id-1",
			{ messages: [] },
			undefined,
			undefined,
			drivers,
			"srv",
		)
		expect(result.error?.code).toBe(-32601)
		expect(result.error?.message).toMatch(/sampling\/createMessage/)
	})

	it("refuses with no gate and no autoApproveTools", async () => {
		const drivers = mockDriverRegistry([mockDriver("d", "hi")])
		const opts: McpClientCapabilityOptions = { sampling: {} }
		const result = await handleSampling("id-2", { messages: [] }, opts, undefined, drivers, "srv")
		expect(result.error?.code).toBe(-32602)
		expect(result.error?.message).toMatch(/approver is required/)
	})

	it("autoApproveTools: true bypasses the gate and routes to the driver", async () => {
		const drivers = mockDriverRegistry([mockDriver("d", "hello-from-driver")])
		const opts: McpClientCapabilityOptions = { sampling: {} }
		const result = await handleSampling(
			"id-3",
			{ messages: [] },
			opts,
			{ autoApproveTools: true },
			drivers,
			"srv",
		)
		expect(result.result).toMatchObject({
			role: "assistant",
			content: { type: "text", text: "hello-from-driver" },
			model: "d/m1",
		})
	})

	it("gate returning approved: true proceeds to the driver", async () => {
		const drivers = mockDriverRegistry([mockDriver("d", "approved-text")])
		const opts: McpClientCapabilityOptions = { sampling: {} }
		const gateCalls: Array<{ toolName: string; serverName: string; params: unknown }> = []
		const gate = async (call: { toolName: string; serverName: string; params: unknown }) => {
			gateCalls.push(call)
			return { approved: true }
		}
		const result = await handleSampling(
			"id-4",
			{ messages: [] },
			opts,
			{ approvalGate: gate },
			drivers,
			"srv",
		)
		expect(result.result).toMatchObject({ content: { text: "approved-text" } })
		// The gate was called with the synthetic sampling toolName.
		expect(gateCalls).toHaveLength(1)
		expect(gateCalls[0]?.toolName).toBe("sampling/createMessage")
		expect(gateCalls[0]?.serverName).toBe("srv")
	})

	it("gate returning approved: false refuses with the reason", async () => {
		const drivers = mockDriverRegistry([mockDriver("d", "hi")])
		const opts: McpClientCapabilityOptions = { sampling: {} }
		const gate = vi.fn(async () => ({ approved: false, reason: "user declined" }))
		const result = await handleSampling(
			"id-5",
			{ messages: [] },
			opts,
			{ approvalGate: gate },
			drivers,
			"srv",
		)
		expect(result.error?.code).toBe(-32602)
		expect(result.error?.message).toMatch(/user declined/)
	})

	it("uses the preferred driver when sampling.driver is set", async () => {
		const d1 = mockDriver("d1", "from-d1")
		const d2 = mockDriver("d2", "from-d2")
		const drivers = mockDriverRegistry([d1, d2])
		const opts: McpClientCapabilityOptions = { sampling: { driver: "d2" } }
		const result = await handleSampling(
			"id-6",
			{ messages: [] },
			opts,
			{ autoApproveTools: true },
			drivers,
			"srv",
		)
		expect(result.result).toMatchObject({ content: { text: "from-d2" }, model: "d2/m1" })
	})

	it("returns invalid-params when the preferred driver is not registered", async () => {
		const drivers = mockDriverRegistry([mockDriver("d1", "hi")])
		const opts: McpClientCapabilityOptions = { sampling: { driver: "nope" } }
		const result = await handleSampling(
			"id-7",
			{ messages: [] },
			opts,
			{ autoApproveTools: true },
			drivers,
			"srv",
		)
		expect(result.error?.code).toBe(-32602)
		expect(result.error?.message).toMatch(/'nope' is not registered/)
	})

	it("returns internal-error when no drivers are registered", async () => {
		const drivers = mockDriverRegistry([])
		const opts: McpClientCapabilityOptions = { sampling: {} }
		const result = await handleSampling(
			"id-8",
			{ messages: [] },
			opts,
			{ autoApproveTools: true },
			drivers,
			"srv",
		)
		expect(result.error?.code).toBe(-32603)
		expect(result.error?.message).toMatch(/no drivers are registered/)
	})

	it("returns internal-error when the driver chat() yields a done(error)", async () => {
		const failingDriver: BHZAIDriver = {
			id: "d",
			listModels: async () => [
				{
					ref: "d/m1",
					driver: "d",
					id: "m1",
					capabilities: { streaming: true, toolCalls: false, reasoning: false },
					availability: "ready",
				},
			],
			capabilities: () => ({ streaming: true, toolCalls: false, reasoning: false }),
			chat: async function* (): AsyncIterable<DriverEvent> {
				yield { type: "done", stopReason: "error", error: "boom" }
			},
		}
		const drivers = mockDriverRegistry([failingDriver])
		const opts: McpClientCapabilityOptions = { sampling: {} }
		const result = await handleSampling(
			"id-9",
			{ messages: [] },
			opts,
			{ autoApproveTools: true },
			drivers,
			"srv",
		)
		expect(result.error?.code).toBe(-32603)
		expect(result.error?.message).toMatch(/boom/)
	})
})

// ---------------------------------------------------------------------------
// handleRootsList — opt-in gate, getRoots() success/throw.
// ---------------------------------------------------------------------------

describe("handleRootsList", () => {
	it("returns method-not-found error when roots is not opted in", async () => {
		const result = await handleRootsList("id-1", undefined)
		expect(result.error?.code).toBe(-32601)
		expect(result.error?.message).toMatch(/roots\/list/)
	})

	it("returns the host's roots as result.roots", async () => {
		const roots: Root[] = [{ uri: "file:///a", name: "A" }, { uri: "file:///b" }]
		const opts: McpClientCapabilityOptions = { roots: { getRoots: () => roots } }
		const result = await handleRootsList("id-2", opts)
		expect(result.result).toEqual({ roots })
	})

	it("supports async getRoots()", async () => {
		const opts: McpClientCapabilityOptions = {
			roots: { getRoots: async () => [{ uri: "file:///x" }] },
		}
		const result = await handleRootsList("id-3", opts)
		expect(result.result).toEqual({ roots: [{ uri: "file:///x" }] })
	})

	it("returns internal-error when getRoots() throws", async () => {
		const opts: McpClientCapabilityOptions = {
			roots: {
				getRoots: async () => {
					throw new Error("fs unavailable")
				},
			},
		}
		const result = await handleRootsList("id-4", opts)
		expect(result.error?.code).toBe(-32603)
		expect(result.error?.message).toMatch(/fs unavailable/)
	})
})

describe("rootsListChangedNotification", () => {
	it("builds a notifications/roots/list_changed notification with no params", () => {
		const notif = rootsListChangedNotification()
		expect(notif.method).toBe("notifications/roots/list_changed")
		expect(notif.params).toBeUndefined()
	})
})

// ---------------------------------------------------------------------------
// McpClient wiring — handshake capabilities, inbound dispatch, notifyRootsChanged.
// ---------------------------------------------------------------------------

describe("McpClient — capability wiring", () => {
	it("handshake sends an empty capabilities object when no opt-ins are supplied", async () => {
		const responses = deferredHandshakeResponses()
		const { calls } = installFetchSequence(responses)
		const bus = new EventBus()
		const registry = new ToolRegistry(bus)
		const client = new McpClient({ url: "https://example.com/mcp", deferred: true }, registry, {
			autoApproveTools: true,
		})
		await client.connect()
		const initCall = calls()[0]
		const body = rpcBody(initCall)
		expect(body.params).toMatchObject({ capabilities: {} })
	})

	it("handshake includes only the opted-in capability keys", async () => {
		const responses = deferredHandshakeResponses()
		const { calls } = installFetchSequence(responses)
		const bus = new EventBus()
		const registry = new ToolRegistry(bus)
		const client = new McpClient({ url: "https://example.com/mcp", deferred: true }, registry, {
			autoApproveTools: true,
			elicitation: { onElicit: async () => ({ action: "decline" }) },
			roots: { getRoots: () => [] },
		})
		await client.connect()
		const initCall = calls()[0]
		const body = rpcBody(initCall)
		expect(body.params).toMatchObject({
			capabilities: { elicitation: {}, roots: {} },
		})
		// sampling is NOT opted in, so it must be absent (not present with false).
		const caps = (body.params as { capabilities: Record<string, unknown> }).capabilities
		expect("sampling" in caps).toBe(false)
	})

	it("handleInboundRequest routes elicitation/create to onElicit", async () => {
		const bus = new EventBus()
		const registry = new ToolRegistry(bus)
		const onElicit = vi.fn(async (): Promise<ElicitResponse> => ({ action: "accept", content: {} }))
		const client = new McpClient({ url: "https://example.com/mcp", deferred: true }, registry, {
			autoApproveTools: true,
			elicitation: { onElicit },
		})
		const result = await client.handleInboundRequest("id-1", "elicitation/create", {
			message: "hi",
		})
		expect(onElicit).toHaveBeenCalledTimes(1)
		expect(result.result).toEqual({ action: "accept", content: {} })
	})

	it("handleInboundRequest returns method-not-found for an unknown method", async () => {
		const bus = new EventBus()
		const registry = new ToolRegistry(bus)
		const client = new McpClient({ url: "https://example.com/mcp", deferred: true }, registry, {
			autoApproveTools: true,
		})
		const result = await client.handleInboundRequest("id-1", "some/unknown/method", {})
		expect(result.error?.code).toBe(-32601)
	})

	it("handleInboundRequest returns internal-error for sampling with no driver registry", async () => {
		const bus = new EventBus()
		const registry = new ToolRegistry(bus)
		const client = new McpClient({ url: "https://example.com/mcp", deferred: true }, registry, {
			autoApproveTools: true,
			sampling: {},
		})
		const result = await client.handleInboundRequest("id-1", "sampling/createMessage", {
			messages: [],
		})
		expect(result.error?.code).toBe(-32603)
		expect(result.error?.message).toMatch(/no driver registry/)
	})

	it("handleInboundRequest routes sampling/createMessage through the gate and driver", async () => {
		const bus = new EventBus()
		const registry = new ToolRegistry(bus)
		const drivers = mockDriverRegistry([mockDriver("d", "sampled-text")])
		const client = new McpClient({ url: "https://example.com/mcp", deferred: true }, registry, {
			autoApproveTools: true,
			sampling: {},
			driverRegistry: drivers,
		})
		const result = await client.handleInboundRequest("id-1", "sampling/createMessage", {
			messages: [],
		})
		expect(result.result).toMatchObject({ content: { text: "sampled-text" } })
	})

	it("handleInboundRequest routes roots/list to getRoots()", async () => {
		const bus = new EventBus()
		const registry = new ToolRegistry(bus)
		const client = new McpClient({ url: "https://example.com/mcp", deferred: true }, registry, {
			autoApproveTools: true,
			roots: { getRoots: () => [{ uri: "file:///a" }] },
		})
		const result = await client.handleInboundRequest("id-1", "roots/list", {})
		expect(result.result).toEqual({ roots: [{ uri: "file:///a" }] })
	})

	it("notifyRootsChanged() sends notifications/roots/list_changed when roots is opted in", async () => {
		const responses = [
			jsonResponse(initResult()),
			acceptedResponse(),
			// TASK_0016: deferred fetches tools/list (to cache) → 3rd call.
			jsonResponse({ jsonrpc: "2.0", id: "x", result: { tools: [] } }),
			// The notifyRootsChanged() call sends a notification → 202.
			acceptedResponse(),
		]
		const { calls } = installFetchSequence(responses)
		const bus = new EventBus()
		const registry = new ToolRegistry(bus)
		const client = new McpClient({ url: "https://example.com/mcp", deferred: true }, registry, {
			autoApproveTools: true,
			roots: { getRoots: () => [] },
		})
		await client.connect()
		await flush()
		await client.notifyRootsChanged()
		// The 4th call (index 3) is the roots/list_changed notification.
		const notifCall = calls()[3]
		const body = rpcBody(notifCall)
		expect(body.method).toBe("notifications/roots/list_changed")
		expect(body.id).toBeUndefined()
	})

	it("notifyRootsChanged() is a no-op when roots is not opted in", async () => {
		const responses = deferredHandshakeResponses()
		const { fetch, calls } = installFetchSequence(responses)
		const bus = new EventBus()
		const registry = new ToolRegistry(bus)
		const client = new McpClient({ url: "https://example.com/mcp", deferred: true }, registry, {
			autoApproveTools: true,
		})
		await client.connect()
		await flush()
		await client.notifyRootsChanged()
		// No new fetch call was made (only the 3 handshake+discovery calls).
		expect(fetch).toHaveBeenCalledTimes(3)
		expect(calls().map((c) => rpcBody(c).method)).not.toContain("notifications/roots/list_changed")
	})
})
