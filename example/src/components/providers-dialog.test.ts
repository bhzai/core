// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from "vitest"
import "./providers-dialog.js"
import type { BhzaiProvidersDialog, ProviderViewState } from "./providers-dialog.js"

/** A payload that becomes an element the moment it is parsed as HTML. */
const XSS = '<img src=x onerror="globalThis.__pwned = true">'

/** Build a providers-dialog fixture and wait for its first render. */
async function fixture(): Promise<BhzaiProvidersDialog> {
	document.body.innerHTML = ""
	const dialog = document.createElement("bhzai-providers-dialog") as BhzaiProvidersDialog
	document.body.appendChild(dialog)
	await dialog.updateComplete
	return dialog
}

/** Three sample provider rows for the list view, spanning both addable kinds. */
function sampleProviders(): ProviderViewState[] {
	return [
		{ id: "ollama-1", kind: "ollama", label: "http://localhost:11434", status: "connected" },
		{
			id: "ollama-2",
			kind: "ollama",
			label: "http://gpu.box:11434",
			status: "error",
			error: "boom",
		},
		{ id: "lmstudio-1", kind: "lmstudio", label: "http://localhost:1234", status: "connected" },
	]
}

describe("BhzaiProvidersDialog", () => {
	beforeEach(() => {
		document.body.innerHTML = ""
	})

	it("show() makes the dialog visible and resets to list view", async () => {
		const dialog = await fixture()
		dialog.show()
		await dialog.updateComplete

		expect(dialog.hasAttribute("open")).toBe(true)
		expect(dialog.querySelector("h2")?.textContent).toBe("Providers")
	})

	it("setProviders renders the rows and always shows the WebLLM built-in", async () => {
		const dialog = await fixture()
		dialog.show()
		dialog.setProviders(sampleProviders())
		await dialog.updateComplete

		const rows = dialog.querySelectorAll(".provider-row")
		expect(rows).toHaveLength(4)
		// WebLLM is always first and connected.
		expect(rows[0]?.getAttribute("data-kind")).toBe("webllm")
		expect(rows[0]?.querySelector(".provider-dot")?.getAttribute("data-state")).toBe("connected")
		expect(rows[0]?.querySelector(".provider-label")?.textContent).toBe("WebLLM (built-in)")
		// …and carries no kind badge, since it is not a configurable entry.
		expect(rows[0]?.querySelector(".provider-kind")).toBeNull()
	})

	it("badges each added row with its provider kind", async () => {
		const dialog = await fixture()
		dialog.show()
		dialog.setProviders(sampleProviders())
		await dialog.updateComplete

		const badges = Array.from(dialog.querySelectorAll(".provider-kind")).map((el) => el.textContent)
		expect(badges).toEqual(["Ollama", "Ollama", "LM Studio"])
	})

	it("shows a green dot for a connected ollama row and a red dot for an error row", async () => {
		const dialog = await fixture()
		dialog.show()
		dialog.setProviders(sampleProviders())
		await dialog.updateComplete

		const ollamaRows = Array.from(dialog.querySelectorAll(".provider-row")).filter(
			(el) => el.getAttribute("data-kind") === "ollama",
		)
		expect(ollamaRows).toHaveLength(2)
		expect(ollamaRows[0]?.getAttribute("data-state")).toBe("connected")
		expect(ollamaRows[0]?.querySelector(".provider-dot")?.getAttribute("data-state")).toBe(
			"connected",
		)
		expect(ollamaRows[1]?.getAttribute("data-state")).toBe("error")
		expect(ollamaRows[1]?.querySelector(".provider-dot")?.getAttribute("data-state")).toBe("error")
	})

	it("clicking Add provider switches to the add view with the typeahead and api-url input", async () => {
		const dialog = await fixture()
		dialog.show()
		await dialog.updateComplete

		const addBtn = dialog.querySelector(".provider-add") as HTMLButtonElement
		addBtn.click()
		await dialog.updateComplete

		expect(dialog.querySelector("h2")?.textContent).toBe("Add provider")
		expect(dialog.querySelector("lit-typeahead")).not.toBeNull()
		expect(dialog.querySelector("input[name=api-url]")).not.toBeNull()
		expect(dialog.querySelector("input[name=api-token]")).not.toBeNull()
	})

	it("offers every addable kind in the type typeahead, Ollama first", async () => {
		const dialog = await fixture()
		dialog.show()
		dialog.showAddView()
		await dialog.updateComplete

		const typeahead = dialog.querySelector("lit-typeahead") as HTMLElement & { items: string[] }
		expect(typeahead.items).toEqual(["Ollama", "LM Studio", "vLLM", "OpenAI"])
		expect(dialog.querySelector(".provider-field > span")?.textContent).toBe("Type")
	})

	it("re-labels the address field and its placeholder when the type changes", async () => {
		const dialog = await fixture()
		dialog.show()
		dialog.showAddView()
		await dialog.updateComplete

		const labelFor = () =>
			Array.from(dialog.querySelectorAll(".provider-field > span")).map((el) => el.textContent)
		expect(labelFor()).toContain("Ollama API address")

		const typeahead = dialog.querySelector("lit-typeahead") as HTMLElement
		typeahead.dispatchEvent(
			new CustomEvent("change", { detail: { value: "LM Studio" }, bubbles: true }),
		)
		await dialog.updateComplete

		expect(labelFor()).toContain("LM Studio API address")
		expect((dialog.querySelector("input[name=api-url]") as HTMLInputElement).placeholder).toBe(
			"http://localhost:1234",
		)
	})

	it("ignores a detail-less change event instead of snapping back to the first kind", async () => {
		const dialog = await fixture()
		dialog.show()
		dialog.showAddView()
		await dialog.updateComplete

		const labelFor = () =>
			Array.from(dialog.querySelectorAll(".provider-field > span")).map((el) => el.textContent)
		const typeahead = dialog.querySelector("lit-typeahead") as HTMLElement
		typeahead.dispatchEvent(
			new CustomEvent("change", { detail: { value: "LM Studio" }, bubbles: true }),
		)
		await dialog.updateComplete
		expect(labelFor()).toContain("LM Studio API address")

		// The typeahead's internal <input> bubbles a bare native `change`.
		typeahead.dispatchEvent(new Event("change", { bubbles: true }))
		await dialog.updateComplete
		expect(labelFor()).toContain("LM Studio API address")
	})

	it("showError reveals an inline error line and clearError hides it", async () => {
		const dialog = await fixture()
		dialog.show()
		dialog.showAddView()
		await dialog.updateComplete

		dialog.showError("something went wrong")
		await dialog.updateComplete
		const errorLine = dialog.querySelector("p[role=alert]") as HTMLElement
		expect(errorLine.hidden).toBe(false)
		expect(errorLine.textContent).toBe("something went wrong")

		dialog.clearError()
		await dialog.updateComplete
		expect((dialog.querySelector("p[role=alert]") as HTMLElement).hidden).toBe(true)
	})

	it("setBusy(true) disables the connect button", async () => {
		const dialog = await fixture()
		dialog.show()
		dialog.showAddView()
		await dialog.updateComplete

		dialog.setBusy(true)
		await dialog.updateComplete
		expect((dialog.querySelector("button.provider-connect") as HTMLButtonElement).disabled).toBe(
			true,
		)

		dialog.setBusy(false)
		await dialog.updateComplete
		expect((dialog.querySelector("button.provider-connect") as HTMLButtonElement).disabled).toBe(
			false,
		)
	})

	it("submitting the add form dispatches bhzai-add-provider with the ollama type and baseUrl", async () => {
		const dialog = await fixture()
		dialog.show()
		dialog.showAddView()
		await dialog.updateComplete

		const spy = vi.fn()
		dialog.addEventListener("bhzai-add-provider", (event) => spy(event))

		const urlInput = dialog.querySelector("input[name=api-url]") as HTMLInputElement
		urlInput.value = "http://localhost:11434/api"
		const form = dialog.querySelector("form") as HTMLFormElement
		form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))

		expect(spy).toHaveBeenCalledTimes(1)
		const detail = (spy.mock.calls[0][0] as CustomEvent).detail
		expect(detail.type).toBe("ollama")
		expect(detail.baseUrl).toBe("http://localhost:11434/api")
		expect(detail.token).toBe("")
	})

	it("submitting after switching type dispatches the lmstudio kind", async () => {
		const dialog = await fixture()
		dialog.show()
		dialog.showAddView()
		await dialog.updateComplete

		const typeahead = dialog.querySelector("lit-typeahead") as HTMLElement
		typeahead.dispatchEvent(
			new CustomEvent("change", { detail: { value: "LM Studio" }, bubbles: true }),
		)
		await dialog.updateComplete

		const spy = vi.fn()
		dialog.addEventListener("bhzai-add-provider", (event) => spy(event))

		const urlInput = dialog.querySelector("input[name=api-url]") as HTMLInputElement
		urlInput.value = "http://localhost:1234"
		const form = dialog.querySelector("form") as HTMLFormElement
		form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))

		const detail = (spy.mock.calls[0][0] as CustomEvent).detail
		expect(detail.type).toBe("lmstudio")
		expect(detail.baseUrl).toBe("http://localhost:1234")
	})

	it("shows the connection status on the edit view, where a successful Connect lands", async () => {
		const dialog = await fixture()
		dialog.setProviders([
			{ id: "p1", kind: "openai", label: "https://openrouter.ai/api", status: "connected" },
		])
		dialog.show()
		dialog.showEditView("p1")
		await dialog.updateComplete

		const status = dialog.querySelector(".provider-status") as HTMLElement
		expect(status).toBeTruthy()
		expect(status.getAttribute("data-state")).toBe("connected")
		expect(status.textContent).toContain("Connected")
		expect(status.getAttribute("role")).toBe("status")
	})

	it("reports a failed connection on the edit view too", async () => {
		const dialog = await fixture()
		dialog.setProviders([
			{ id: "p1", kind: "openai", label: "https://api.openai.com", status: "error" },
		])
		dialog.show()
		dialog.showEditView("p1")
		await dialog.updateComplete

		const status = dialog.querySelector(".provider-status") as HTMLElement
		expect(status.getAttribute("data-state")).toBe("error")
		expect(status.textContent).toContain("Connection failed")
	})

	it("omits the status line when the row is gone", async () => {
		const dialog = await fixture()
		dialog.setProviders([])
		dialog.show()
		dialog.showEditView("missing")
		await dialog.updateComplete
		expect(dialog.querySelector(".provider-status")).toBeNull()
	})

	it("editing an lmstudio row labels the address field for LM Studio", async () => {
		const dialog = await fixture()
		dialog.show()
		dialog.setProviders(sampleProviders())
		await dialog.updateComplete

		const row = dialog.querySelector('.provider-row[data-kind="lmstudio"]') as HTMLElement
		row.click()
		await dialog.updateComplete

		expect(dialog.querySelector("h2")?.textContent).toBe("Edit provider")
		expect(dialog.querySelector(".provider-field > span")?.textContent).toBe(
			"LM Studio API address",
		)
		expect((dialog.querySelector("input[name=api-url]") as HTMLInputElement).value).toBe(
			"http://localhost:1234",
		)
	})

	it("clicking a connected ollama row opens the edit view", async () => {
		const dialog = await fixture()
		dialog.show()
		dialog.setProviders(sampleProviders())
		await dialog.updateComplete

		const ollamaRow = dialog.querySelector('.provider-row[data-kind="ollama"]') as HTMLElement
		ollamaRow.click()
		await dialog.updateComplete

		expect(dialog.querySelector("h2")?.textContent).toBe("Edit provider")
		expect(dialog.querySelector("input[name=api-url]")).not.toBeNull()
	})

	it("renders an XSS payload in a base URL as text, never as markup", async () => {
		const spy = vi.fn()
		Object.defineProperty(globalThis, "__pwned", { set: spy, configurable: true })

		const dialog = await fixture()
		dialog.show()
		dialog.setProviders([{ id: "xss", kind: "ollama", label: XSS, status: "error", error: XSS }])
		await dialog.updateComplete

		expect(spy).not.toHaveBeenCalled()
		expect(dialog.querySelectorAll("img")).toHaveLength(0)
		const row = dialog.querySelector('.provider-row[data-kind="ollama"]')
		expect(row?.querySelector(".provider-label")?.textContent).toBe(XSS)
	})
})
