// @vitest-environment happy-dom

import { beforeEach, describe, expect, it } from "vitest"
import "./provider-select.js"
import { ALL_PROVIDERS, type BhzaiProviderSelect } from "./provider-select.js"

/** Build the provider-select custom element. */
function fixture(): BhzaiProviderSelect {
	document.body.innerHTML = ""
	const el = document.createElement("bhzai-provider-select") as BhzaiProviderSelect
	document.body.appendChild(el)
	return el
}

/**
 * Dispatch the `change` custom event `lit-typeahead` fires when the user
 * selects an item from its searchable dropdown (the only path that fires it).
 */
function dispatchSelect(el: BhzaiProviderSelect, value: string): void {
	const typeahead = el.querySelector("lit-typeahead")
	if (!typeahead) throw new Error("lit-typeahead not found")
	typeahead.dispatchEvent(
		new CustomEvent("change", { detail: { value }, bubbles: true, composed: true }),
	)
}

describe("BhzaiProviderSelect", () => {
	beforeEach(() => {
		document.body.innerHTML = ""
	})

	it("renders All plus one item per provider", async () => {
		const el = fixture()
		el.providers = ["webllm", "vllm"]
		await el.updateComplete

		const typeahead = el.querySelector("lit-typeahead") as HTMLElement & {
			items: string[]
		}
		expect(typeahead.items).toEqual(["All", "WebLLM", "vLLM"])
	})

	it("defaults to All providers", async () => {
		const el = fixture()
		el.providers = ["webllm"]
		await el.updateComplete

		expect(el.selectedProvider).toBe(ALL_PROVIDERS)
	})

	it("dispatches bhzai-change when selecting a provider from the dropdown", async () => {
		const el = fixture()
		el.providers = ["webllm", "vllm"]
		await el.updateComplete

		const events: string[] = []
		el.addEventListener("bhzai-change", (event) => {
			events.push((event as CustomEvent<{ provider: string }>).detail.provider)
		})

		// Simulate the user selecting "vLLM" from the searchable dropdown.
		dispatchSelect(el, "vLLM")
		await el.updateComplete

		expect(el.selectedProvider).toBe("vllm")
		expect(events).toEqual(["vllm"])
	})

	it("dispatches bhzai-change when selecting All from the dropdown", async () => {
		const el = fixture()
		el.providers = ["webllm", "vllm"]
		el.selectedProvider = "vllm"
		await el.updateComplete

		const events: string[] = []
		el.addEventListener("bhzai-change", (event) => {
			events.push((event as CustomEvent<{ provider: string }>).detail.provider)
		})

		dispatchSelect(el, "All")
		await el.updateComplete

		expect(el.selectedProvider).toBe(ALL_PROVIDERS)
		expect(events).toEqual([ALL_PROVIDERS])
	})

	it("ignores an unrecognized value instead of changing the filter", async () => {
		const el = fixture()
		el.providers = ["webllm", "vllm"]
		el.selectedProvider = "vllm"
		await el.updateComplete

		const events: string[] = []
		el.addEventListener("bhzai-change", (event) => {
			events.push((event as CustomEvent<{ provider: string }>).detail.provider)
		})

		// A stray `change` with a value that matches no rendered label is not a
		// real selection — the current filter stays in place.
		dispatchSelect(el, "garbage")
		await el.updateComplete

		expect(el.selectedProvider).toBe("vllm")
		expect(events).toEqual([])
	})

	it("does not re-dispatch when the same provider is selected again", async () => {
		const el = fixture()
		el.providers = ["webllm", "vllm"]
		el.selectedProvider = "vllm"
		await el.updateComplete

		const events: string[] = []
		el.addEventListener("bhzai-change", (event) => {
			events.push((event as CustomEvent<{ provider: string }>).detail.provider)
		})

		// Select "vLLM" again — already selected, should be a no-op.
		dispatchSelect(el, "vLLM")
		await el.updateComplete

		expect(events).toEqual([])
	})
})
