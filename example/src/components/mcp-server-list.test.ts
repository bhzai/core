// @vitest-environment happy-dom

import type { McpServerState, McpServerTool } from "@bhzai/core/plugins/mcp"
import { beforeEach, describe, expect, it } from "vitest"
import "./mcp-server-card.js"
import "./mcp-server-list.js"
import type { BhzaiMcpServerCard } from "./mcp-server-card.js"
import type { BhzaiMcpServerList } from "./mcp-server-list.js"

/** Build a server snapshot with sane defaults. */
function serverState(
	id: string,
	serverName: string,
	status: McpServerState["status"] = "connected",
	tools: McpServerTool[] = [],
): McpServerState {
	return {
		id,
		config: { url: `https://${serverName}.example/mcp` },
		serverName,
		status,
		tools,
		deferred: false,
	} as McpServerState
}

/** `n` tools named `tool-0`, `tool-1`, … */
function tools(n: number): McpServerTool[] {
	return Array.from({ length: n }, (_, i) => ({
		name: `mcp__srv__tool-${i}`,
		shortName: `tool-${i}`,
		description: `does thing ${i}`,
	}))
}

/** Wait for every child server card to finish its update cycle. */
async function awaitCards(list: BhzaiMcpServerList): Promise<void> {
	await Promise.all(
		Array.from(list.querySelectorAll("bhzai-mcp-server-card")).map(
			(card) => (card as BhzaiMcpServerCard).updateComplete,
		),
	)
}

/** Build a server-list fixture and wait for its first render. */
async function fixture(): Promise<BhzaiMcpServerList> {
	document.body.innerHTML = ""
	const list = document.createElement("bhzai-mcp-server-list") as BhzaiMcpServerList
	document.body.appendChild(list)
	await list.updateComplete
	await awaitCards(list)
	return list
}

describe("BhzaiMcpServerList", () => {
	beforeEach(() => {
		document.body.innerHTML = ""
	})

	it("shows the empty state and hides the controls when nothing is attached", async () => {
		const list = await fixture()
		list.states = []
		await list.updateComplete
		await awaitCards(list)

		expect((list.querySelector(".mcp-empty") as HTMLElement).hidden).toBe(false)
		expect((list.querySelector(".mcp-list-controls") as HTMLElement).hidden).toBe(true)
	})

	it("renders a card per server and reveals the controls", async () => {
		const list = await fixture()
		list.states = [serverState("a", "alpha"), serverState("b", "beta", "error")]
		await list.updateComplete
		await awaitCards(list)

		expect(list.querySelectorAll(".mcp-server")).toHaveLength(2)
		expect((list.querySelector(".mcp-empty") as HTMLElement).hidden).toBe(true)
		expect((list.querySelector(".mcp-list-controls") as HTMLElement).hidden).toBe(false)
	})

	it("keeps the empty states outside the rendered list", async () => {
		const list = await fixture()

		list.states = [serverState("a", "alpha")]
		await list.updateComplete
		await awaitCards(list)
		list.states = []
		await list.updateComplete
		await awaitCards(list)

		expect(list.querySelector(".mcp-empty")).not.toBeNull()
	})

	it("shows the no-matches state when a filter excludes everything", async () => {
		const list = await fixture()
		list.states = [serverState("a", "alpha"), serverState("b", "beta")]
		await list.updateComplete
		await awaitCards(list)

		const search = list.querySelector(".mcp-search") as HTMLInputElement
		search.value = "nothing-matches-this"
		search.dispatchEvent(new Event("input"))
		await list.updateComplete
		await awaitCards(list)

		const noMatches = Array.from(list.querySelectorAll(".mcp-empty")).find(
			(el) => el.textContent?.trim() === "No servers match that filter.",
		) as HTMLElement
		expect(noMatches.hidden).toBe(false)

		const empty = Array.from(list.querySelectorAll(".mcp-empty")).find(
			(el) => el.textContent?.trim() === "No servers attached.",
		) as HTMLElement
		expect(empty.hidden).toBe(true)

		search.value = ""
		search.dispatchEvent(new Event("input"))
		await list.updateComplete
		await awaitCards(list)
		expect(noMatches.hidden).toBe(true)
	})

	it("filters servers by name and by the tools they expose", async () => {
		const list = await fixture()
		list.states = [
			serverState("a", "alpha", "connected", [
				{ name: "mcp__alpha__search_issues", shortName: "search_issues", description: "" },
			]),
			serverState("b", "beta"),
		]
		await list.updateComplete
		await awaitCards(list)

		const search = list.querySelector(".mcp-search") as HTMLInputElement
		const names = () =>
			Array.from(list.querySelectorAll<HTMLElement>(".mcp-server")).map((c) => c.dataset.name)

		search.value = "beta"
		search.dispatchEvent(new Event("input"))
		await list.updateComplete
		await awaitCards(list)
		expect(names()).toEqual(["beta"])

		// A tool name finds the server exposing it, even though it is not visible
		// on the collapsed card.
		search.value = "search_issues"
		search.dispatchEvent(new Event("input"))
		await list.updateComplete
		await awaitCards(list)
		expect(names()).toEqual(["alpha"])
	})

	it("sorts servers by name and toggles direction", async () => {
		const list = await fixture()
		list.states = [serverState("b", "bravo"), serverState("a", "alpha")]
		await list.updateComplete
		await awaitCards(list)

		const nameSort = list.querySelector('[data-sort="name"]') as HTMLButtonElement
		nameSort.click()
		await list.updateComplete
		await awaitCards(list)
		expect(
			Array.from(list.querySelectorAll<HTMLElement>(".mcp-server")).map((c) => c.dataset.name),
		).toEqual(["alpha", "bravo"])

		nameSort.click()
		await list.updateComplete
		await awaitCards(list)
		expect(
			Array.from(list.querySelectorAll<HTMLElement>(".mcp-server")).map((c) => c.dataset.name),
		).toEqual(["bravo", "alpha"])
	})

	it("keeps an expanded tool disclosure open across an unrelated re-render", async () => {
		// Every manager transition re-renders the whole list. Without carrying the
		// expansion state, one server connecting would snap another's tools shut.
		const list = await fixture()
		list.states = [serverState("a", "alpha", "connected", tools(9))]
		await list.updateComplete
		await awaitCards(list)

		const details = list.querySelector("details.mcp-tools") as HTMLDetailsElement
		details.open = true
		details.dispatchEvent(new Event("toggle"))

		list.states = [
			serverState("a", "alpha", "connected", tools(9)),
			serverState("b", "beta", "connecting"),
		]
		await list.updateComplete
		await awaitCards(list)

		const reRendered = list.querySelector("details.mcp-tools") as HTMLDetailsElement
		expect(reRendered.open).toBe(true)
	})

	it("forgets expansion state for a server that goes away", async () => {
		const list = await fixture()
		list.states = [serverState("a", "alpha", "connected", tools(9))]
		await list.updateComplete
		await awaitCards(list)

		const details = list.querySelector("details.mcp-tools") as HTMLDetailsElement
		details.open = true
		details.dispatchEvent(new Event("toggle"))

		// Removed, then re-added under the same id: a fresh attach should start
		// collapsed rather than inheriting a stale expansion.
		list.states = []
		await list.updateComplete
		await awaitCards(list)
		list.states = [serverState("a", "alpha", "connected", tools(9))]
		await list.updateComplete
		await awaitCards(list)

		expect((list.querySelector("details.mcp-tools") as HTMLDetailsElement).open).toBe(false)
	})

	it("only renders a tool list for a connected server that has tools", async () => {
		const list = await fixture()
		list.states = [
			serverState("a", "alpha", "connected", []),
			serverState("b", "beta", "error", tools(9)),
		]
		await list.updateComplete
		await awaitCards(list)

		expect(list.querySelectorAll("details.mcp-tools")).toHaveLength(0)
	})
})
