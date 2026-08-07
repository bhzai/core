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

/** Dispatch a native `input` event from the inner `<input>` inside `lit-typeahead`. */
function dispatchInput(el: BhzaiProviderSelect, value: string): void {
	const typeahead = el.querySelector("lit-typeahead")
	if (!typeahead) throw new Error("lit-typeahead not found")
	const shadow = typeahead.shadowRoot
	if (!shadow) throw new Error("lit-typeahead has no shadow root")
	const input = shadow.querySelector("input")
	if (!input) throw new Error("input not found inside lit-typeahead shadow root")
	input.value = value
	input.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true }))
}

/** Dispatch a `change` custom event from `lit-typeahead` (simulates blur). */
function dispatchChange(el: BhzaiProviderSelect, value: string): void {
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

	it("dispatches bhzai-change immediately on input event (datalist selection)", async () => {
		const el = fixture()
		el.providers = ["webllm", "vllm"]
		await el.updateComplete

		const events: string[] = []
		el.addEventListener("bhzai-change", (event) => {
			events.push((event as CustomEvent<{ provider: string }>).detail.provider)
		})

		// Simulate the user selecting "vLLM" from the datalist — the native
		// `input` event fires immediately, without waiting for blur.
		dispatchInput(el, "vLLM")
		await el.updateComplete

		expect(el.selectedProvider).toBe("vllm")
		expect(events).toEqual(["vllm"])
	})

	it("dispatches bhzai-change when selecting All via input event", async () => {
		const el = fixture()
		el.providers = ["webllm", "vllm"]
		el.selectedProvider = "vllm"
		await el.updateComplete

		const events: string[] = []
		el.addEventListener("bhzai-change", (event) => {
			events.push((event as CustomEvent<{ provider: string }>).detail.provider)
		})

		dispatchInput(el, "All")
		await el.updateComplete

		expect(el.selectedProvider).toBe(ALL_PROVIDERS)
		expect(events).toEqual([ALL_PROVIDERS])
	})

	it("does not dispatch on partial match during typing (no flicker)", async () => {
		const el = fixture()
		el.providers = ["webllm", "vllm"]
		await el.updateComplete

		const events: string[] = []
		el.addEventListener("bhzai-change", (event) => {
			events.push((event as CustomEvent<{ provider: string }>).detail.provider)
		})

		// User types "vL" — partial match, should NOT change the filter
		dispatchInput(el, "vL")
		await el.updateComplete

		expect(el.selectedProvider).toBe(ALL_PROVIDERS)
		expect(events).toEqual([])
	})

	it("falls back to All on change (blur) with an unrecognized value", async () => {
		const el = fixture()
		el.providers = ["webllm", "vllm"]
		el.selectedProvider = "vllm"
		await el.updateComplete

		const events: string[] = []
		el.addEventListener("bhzai-change", (event) => {
			events.push((event as CustomEvent<{ provider: string }>).detail.provider)
		})

		// User types garbage and tabs away — change fires on blur
		dispatchChange(el, "garbage")
		await el.updateComplete

		expect(el.selectedProvider).toBe(ALL_PROVIDERS)
		expect(events).toEqual([ALL_PROVIDERS])
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

		// Select "vLLM" again — already selected, should be a no-op
		dispatchInput(el, "vLLM")
		await el.updateComplete

		expect(events).toEqual([])
	})

	it("still handles the change event (blur fallback path)", async () => {
		const el = fixture()
		el.providers = ["webllm", "vllm"]
		await el.updateComplete

		const events: string[] = []
		el.addEventListener("bhzai-change", (event) => {
			events.push((event as CustomEvent<{ provider: string }>).detail.provider)
		})

		dispatchChange(el, "WebLLM")
		await el.updateComplete

		expect(el.selectedProvider).toBe("webllm")
		expect(events).toEqual(["webllm"])
	})
})
