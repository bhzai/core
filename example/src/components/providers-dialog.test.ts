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

/** Two sample provider rows for the list view. */
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
		expect(rows).toHaveLength(3)
		// WebLLM is always first and connected.
		expect(rows[0]?.getAttribute("data-kind")).toBe("webllm")
		expect(rows[0]?.querySelector(".provider-dot")?.getAttribute("data-state")).toBe("connected")
		expect(rows[0]?.querySelector(".provider-label")?.textContent).toBe("WebLLM (built-in)")
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
