// @vitest-environment happy-dom

import { beforeEach, describe, expect, it } from "vitest"
import "./conversation-view.js"
import type { BhzaiConversation } from "./conversation-view.js"

/** Build the conversation custom element. */
function fixture(): BhzaiConversation {
	document.body.innerHTML = ""
	const el = document.createElement("bhzai-conversation") as BhzaiConversation
	document.body.appendChild(el)
	return el
}

describe("BhzaiConversation", () => {
	beforeEach(() => {
		document.body.innerHTML = ""
	})

	it("renders a user message as text, not markup", async () => {
		const view = fixture()
		view.appendUserMessage("<b>hello</b>")
		await view.updateComplete
		const bubble = view.querySelector(".message.user .message-answer") as HTMLElement
		expect(bubble.textContent).toBe("<b>hello</b>")
		expect(bubble.querySelector("b")).toBeNull()
	})

	it("routes thought and answer deltas to separate regions", async () => {
		const view = fixture()

		const turn = view.beginAssistantTurn()
		turn.appendThought("weigh")
		turn.appendThought("ing…")
		turn.appendAnswer("Hel")
		turn.appendAnswer("lo.")
		await view.updateComplete

		const message = view.querySelector(".message.assistant") as HTMLElement
		expect(message.querySelector(".message-thought-content")?.textContent).toBe("weighing…")
		expect(message.querySelector(".message-answer")?.textContent).toBe("Hello.")
	})

	it("creates the Thought disclosure only when reasoning actually arrives", async () => {
		const view = fixture()

		const turn = view.beginAssistantTurn()
		turn.appendAnswer("no reasoning here")
		await view.updateComplete

		expect(view.querySelector(".message-thought")).toBeNull()
	})

	it("collapses the Thought disclosure by default", async () => {
		const view = fixture()

		view.beginAssistantTurn().appendThought("hmm")
		await view.updateComplete

		expect((view.querySelector(".message-thought") as HTMLDetailsElement).open).toBe(false)
	})

	it("keeps concurrent turns independent", async () => {
		// Each turn closes over its own state rather than looking a message back up
		// by id, so a second turn cannot stream into the first.
		const view = fixture()

		const first = view.beginAssistantTurn()
		const second = view.beginAssistantTurn()
		first.appendAnswer("one")
		second.appendAnswer("two")
		await view.updateComplete

		const answers = Array.from(view.querySelectorAll(".message.assistant .message-answer")).map(
			(node) => node.textContent,
		)
		expect(answers).toEqual(["one", "two"])
	})

	it("shows a turn error as an alert without touching earlier messages", async () => {
		const view = fixture()

		view.appendUserMessage("hi")
		view.showTurnError("Failed to generate a response: boom")
		await view.updateComplete

		const error = view.querySelector(".message.error") as HTMLElement
		expect(error.getAttribute("role")).toBe("alert")
		expect(error.textContent).toBe("Failed to generate a response: boom")
		expect(view.querySelector(".message.user")).not.toBeNull()
	})

	it("removes the empty state on request, and tolerates being asked twice", async () => {
		const view = fixture()

		view.clearEmptyState()
		await view.updateComplete
		expect(view.querySelector(".empty-state")).toBeNull()
		expect(() => {
			view.clearEmptyState()
		}).not.toThrow()
	})

	it("tolerates a missing empty state", async () => {
		document.body.innerHTML = ""
		const view = document.createElement("bhzai-conversation") as BhzaiConversation
		document.body.appendChild(view)

		expect(() => view.clearEmptyState()).not.toThrow()
	})

	it("renders a compacted marker with a label", async () => {
		const view = fixture()

		view.appendUserMessage("hello")
		view.appendCompactedMarker("conversation compacted")
		await view.updateComplete

		const marker = view.querySelector(".message.compacted") as HTMLElement
		expect(marker).not.toBeNull()
		expect(marker.getAttribute("role")).toBe("status")
		expect(marker.querySelector(".compacted-label")?.textContent).toBe("conversation compacted")
	})

	it("loadMessages restores thought from meta.think, not from thought blocks", async () => {
		const view = fixture()

		view.loadMessages([
			{
				role: "user",
				content: "hello",
				blocks: [{ type: "text", text: "hello" }],
			},
			{
				role: "assistant",
				content: "Hi there!",
				blocks: [{ type: "text", text: "Hi there!" }],
				meta: { think: "reasoning about the greeting" },
			},
		])
		await view.updateComplete

		const assistant = view.querySelector(".message.assistant") as HTMLElement
		expect(assistant).not.toBeNull()
		expect(assistant.querySelector(".message-thought-content")?.textContent).toBe(
			"reasoning about the greeting",
		)
		expect(assistant.querySelector(".message-answer")?.textContent).toBe("Hi there!")
	})

	it("loadMessages renders assistant without thought when meta.think is absent", async () => {
		const view = fixture()

		view.loadMessages([
			{
				role: "assistant",
				content: "no reasoning",
				blocks: [{ type: "text", text: "no reasoning" }],
				meta: {},
			},
		])
		await view.updateComplete

		expect(view.querySelector(".message-thought")).toBeNull()
		expect(view.querySelector(".message-answer")?.textContent).toBe("no reasoning")
	})
})
