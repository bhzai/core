// @vitest-environment happy-dom

import type { McpServerState } from "@bhzai/core/plugins/mcp"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { type BhzaiMcpServerCard, SERVER_INDEX_KEYS } from "./mcp-server-card.js"

/** A payload that becomes an element the moment it is parsed as HTML. */
const XSS = '<img src=x onerror="globalThis.__pwned = true">'

/** Handlers that record which action fired for which id. */
function spyHandlers(card: BhzaiMcpServerCard): { calls: string[] } {
	const calls: string[] = []
	card.addEventListener("bhzai-refresh", (event) => {
		calls.push(`refresh:${(event as CustomEvent<{ id: string }>).detail.id}`)
	})
	card.addEventListener("bhzai-retry", (event) => {
		calls.push(`retry:${(event as CustomEvent<{ id: string }>).detail.id}`)
	})
	card.addEventListener("bhzai-remove", (event) => {
		calls.push(`remove:${(event as CustomEvent<{ id: string }>).detail.id}`)
	})
	card.addEventListener("bhzai-show-error", (event) => {
		calls.push(`error:${(event as CustomEvent<{ id: string }>).detail.id}`)
	})
	return { calls }
}

/** Build a server snapshot with sane defaults. */
function serverState(overrides: Partial<McpServerState> = {}): McpServerState {
	return {
		id: "srv-1",
		config: { url: "https://example.com/mcp" },
		serverName: "example",
		status: "connected",
		tools: [],
		deferred: false,
		...overrides,
	} as McpServerState
}

/** Build a card fixture and wait for its first render. */
async function fixture(state: McpServerState): Promise<BhzaiMcpServerCard> {
	document.body.innerHTML = ""
	const card = document.createElement("bhzai-mcp-server-card") as BhzaiMcpServerCard
	card.className = "mcp-server"
	card.state = state
	document.body.appendChild(card)
	await card.updateComplete
	return card
}

describe("BhzaiMcpServerCard", () => {
	beforeEach(() => {
		document.body.innerHTML = ""
	})

	it("renders untrusted server text as text, never as markup", async () => {
		const spy = vi.fn()
		Object.defineProperty(globalThis, "__pwned", { set: spy, configurable: true })

		const card = await fixture(
			serverState({
				serverName: XSS,
				status: "error",
				error: {
					name: XSS,
					message: XSS,
					url: "https://example.com/mcp",
					at: Date.now(),
					phase: "connect",
				},
			}),
		)

		expect(spy).not.toHaveBeenCalled()
		expect(card.querySelectorAll("img")).toHaveLength(0)
		expect(card.querySelector(".mcp-server-name")?.textContent).toBe(XSS)
		expect(card.dataset.name).toBe(XSS)
		expect(card.textContent).toContain(XSS)
	})

	it("indexes the keys the server list searches on", async () => {
		const card = await fixture(
			serverState({
				tools: [
					{ name: "mcp__example__search", shortName: "search", description: "Find things" },
					{ name: "mcp__example__create", shortName: "create", description: "" },
				],
			}),
		)

		// Every key the list declares must actually be present, or search and sort
		// silently do nothing for that column.
		for (const key of SERVER_INDEX_KEYS) {
			expect(card.dataset[key]).toBeDefined()
		}
		expect(card.dataset.status).toBe("connected")
		expect(card.dataset.name).toBe("example")
		// Tool names are indexed but never displayed, so typing a tool name finds
		// the server exposing it.
		expect(card.dataset.tools).toBe("search create")
	})

	it("offers refresh and remove when connected", async () => {
		const card = await fixture(serverState())
		const handlers = spyHandlers(card)

		const labels = Array.from(card.querySelectorAll("button")).map((b) =>
			b.getAttribute("aria-label"),
		)
		expect(labels).toEqual(["Refresh tools for example", "Remove example"])

		for (const button of card.querySelectorAll("button")) {
			;(button as HTMLButtonElement).click()
		}
		expect(handlers.calls).toEqual(["refresh:srv-1", "remove:srv-1"])
	})

	it("offers error details and retry when failed", async () => {
		const card = await fixture(
			serverState({
				status: "error",
				error: {
					name: "TypeError",
					message: "Failed to fetch",
					url: "https://example.com/mcp",
					at: Date.now(),
					phase: "connect",
				},
			}),
		)
		const handlers = spyHandlers(card)

		for (const button of card.querySelectorAll("button")) {
			;(button as HTMLButtonElement).click()
		}
		expect(handlers.calls).toEqual(["error:srv-1", "retry:srv-1", "remove:srv-1"])
		// The status line names the error but leaves the message to the dialog.
		expect(card.querySelector(".mcp-server-status")?.textContent).toBe("failed · TypeError")
	})

	it("calls out a connected server with no tools", async () => {
		const card = await fixture(serverState({ tools: [] }))
		expect(card.querySelector(".mcp-server-status")?.textContent).toBe("connected · no tools")
	})

	it("shows the endpoint URL as the name's tooltip", async () => {
		const card = await fixture(serverState())
		expect(card.querySelector(".mcp-server-name")?.getAttribute("title")).toBe(
			"https://example.com/mcp",
		)
	})
})
