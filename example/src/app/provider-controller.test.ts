/**
 * @file Tests for the providers panel controller.
 *
 * Drives `createProviderController` with the REAL drivers against a fake
 * `fetch`, plus minimal stand-ins for the dialog and cog custom elements — so
 * the connect/probe/register/status pipeline is exercised end to end without a
 * DOM. What the dialog is *told* to render is the assertion target, since that
 * is what the user sees.
 */

import { beforeEach, describe, expect, it, vi } from "vitest"

import { BHZAI } from "@bhzai/core"
import type { BhzaiProviderCog } from "../components/provider-cog.js"
import type { BhzaiProvidersDialog, ProviderViewState } from "../components/providers-dialog.js"
import { createProviderController } from "./provider-controller.js"

// The failure path raises a toast, and toastify reaches straight for `document`.
// These tests are about controller state, not presentation, so the toast is
// stubbed rather than pulling a DOM environment into this file.
vi.mock("../lib/toast.js", () => ({ showErrorToast: vi.fn() }))

/** A stand-in dialog recording every state push the controller makes. */
class FakeDialog extends EventTarget {
	providers: ProviderViewState[] = []
	busy: boolean | null = null
	errors: string[] = []
	view = "list"
	setProviders(list: ProviderViewState[]): void {
		this.providers = list
	}
	setBusy(value: boolean): void {
		this.busy = value
	}
	showError(message: string): void {
		this.errors.push(message)
	}
	clearError(): void {}
	show(): void {
		this.view = "list"
	}
	showEditView(id: string): void {
		this.view = `edit:${id}`
	}
	showAddView(): void {
		this.view = "add"
	}
}

/** The OpenRouter `/v1/models` payload shape, trimmed to what the driver reads. */
function openRouterModels() {
	return {
		data: [
			{
				id: "openai/gpt-4o-mini",
				context_length: 128000,
				supported_parameters: ["tools", "temperature"],
			},
		],
		total_count: 1,
	}
}

/** A fake `fetch` that answers the OpenRouter models endpoint and records calls. */
function fakeFetch(handler?: (url: string) => { status?: number; json?: unknown }) {
	const urls: string[] = []
	return Object.assign(
		vi.fn(async (input: string) => {
			urls.push(input)
			const result = handler?.(input) ?? { json: openRouterModels() }
			const status = result.status ?? 200
			return {
				ok: status >= 200 && status < 300,
				status,
				json: async () => result.json ?? {},
				text: async () => JSON.stringify(result.json ?? ""),
			} as Response
		}),
		{ urls },
	)
}

describe("provider controller — connecting an OpenAI-compatible provider", () => {
	let bh: BHZAI
	let dialog: FakeDialog
	let cog: EventTarget
	let originalFetch: typeof fetch

	beforeEach(() => {
		bh = new BHZAI()
		dialog = new FakeDialog()
		cog = new EventTarget()
		originalFetch = globalThis.fetch
	})

	/** Start a controller wired to the fakes. */
	async function start(onProvidersChanged?: () => void) {
		const controller = createProviderController({
			bh,
			cog: cog as unknown as BhzaiProviderCog,
			dialog: dialog as unknown as BhzaiProvidersDialog,
			onProvidersChanged,
		})
		await controller.start()
		return controller
	}

	/** Submit the add form the way the dialog's event does. */
	function addProvider(type: string, baseUrl: string, token = "") {
		dialog.dispatchEvent(
			new CustomEvent("bhzai-add-provider", { detail: { type, baseUrl, token } }),
		)
	}

	it("marks an OpenRouter provider connected and registers it on the kernel", async () => {
		const fetchMock = fakeFetch()
		;(globalThis as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch
		try {
			await start()
			addProvider("openai", "https://openrouter.ai/api/v1/models", "sk-or-v1-test")
			// Let the probe and registration settle.
			await new Promise((resolve) => setTimeout(resolve, 20))

			expect(dialog.providers).toHaveLength(1)
			expect(dialog.providers[0]?.status).toBe("connected")
			expect(dialog.providers[0]?.kind).toBe("openai")
			// The pasted endpoint address is normalized to the API root.
			expect(dialog.providers[0]?.label).toBe("https://openrouter.ai/api")
			expect(fetchMock.urls[0]).toBe("https://openrouter.ai/api/v1/models")
			// Registered, so its models reach the merged catalogue.
			expect((await bh.listModels()).map((m) => m.ref)).toContain("openai/openai/gpt-4o-mini")
		} finally {
			;(globalThis as { fetch: typeof fetch }).fetch = originalFetch
		}
	})

	it("marks the provider errored when the endpoint rejects the key", async () => {
		const fetchMock = fakeFetch(() => ({
			status: 401,
			json: { error: { message: "No auth credentials found" } },
		}))
		;(globalThis as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch
		try {
			await start()
			addProvider("openai", "https://openrouter.ai/api", "bad-key")
			await new Promise((resolve) => setTimeout(resolve, 20))

			expect(dialog.providers[0]?.status).toBe("error")
			expect(await bh.listModels()).toEqual([])
		} finally {
			;(globalThis as { fetch: typeof fetch }).fetch = originalFetch
		}
	})

	it("notifies the host once the provider is registered", async () => {
		const fetchMock = fakeFetch()
		;(globalThis as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch
		const changed = vi.fn()
		try {
			await start(changed)
			addProvider("openai", "https://openrouter.ai/api", "sk-or-v1-test")
			await new Promise((resolve) => setTimeout(resolve, 20))
			expect(changed).toHaveBeenCalled()
		} finally {
			;(globalThis as { fetch: typeof fetch }).fetch = originalFetch
		}
	})

	// REGRESSION: drivers dispatch 'connect' from inside listModels(), so a
	// refresh triggered by that event re-enters bh.listModels() and polls every
	// driver again — observed in the wild as thousands of requests.
	it("does not storm the endpoint when the host refreshes on every change", async () => {
		const fetchMock = fakeFetch()
		;(globalThis as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch
		try {
			await start(() => void bh.listModels())
			addProvider("openai", "https://openrouter.ai/api", "sk-or-v1-test")
			await new Promise((resolve) => setTimeout(resolve, 50))
			expect(fetchMock.urls.length).toBeLessThan(10)
		} finally {
			;(globalThis as { fetch: typeof fetch }).fetch = originalFetch
		}
	})
})

describe("provider controller — connecting a vLLM provider", () => {
	let bh: BHZAI
	let dialog: FakeDialog
	let cog: EventTarget
	let originalFetch: typeof fetch

	beforeEach(() => {
		bh = new BHZAI()
		dialog = new FakeDialog()
		cog = new EventTarget()
		originalFetch = globalThis.fetch
	})

	/** A vLLM `/v1/models` payload, trimmed to what the driver reads. */
	function vllmModels() {
		return {
			object: "list",
			data: [
				{
					id: "meta-llama/Llama-3.1-8B-Instruct",
					object: "model",
					owned_by: "vllm",
					root: "meta-llama/Llama-3.1-8B-Instruct",
					parent: null,
					max_model_len: 131072,
				},
			],
		}
	}

	/** Start a controller wired to the fakes. */
	async function start() {
		const controller = createProviderController({
			bh,
			cog: cog as unknown as BhzaiProviderCog,
			dialog: dialog as unknown as BhzaiProvidersDialog,
		})
		await controller.start()
		return controller
	}

	/** Submit the add form the way the dialog's event does. */
	function addProvider(type: string, baseUrl: string, token = "") {
		dialog.dispatchEvent(
			new CustomEvent("bhzai-add-provider", { detail: { type, baseUrl, token } }),
		)
	}

	it("probes the vLLM root and registers its models under the vllm/ ref", async () => {
		const fetchMock = fakeFetch(() => ({ json: vllmModels() }))
		;(globalThis as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch
		try {
			await start()
			// The address a user pastes out of vLLM's docs carries the /v1 suffix.
			addProvider("vllm", "http://localhost:8000/v1")
			await new Promise((resolve) => setTimeout(resolve, 20))

			expect(dialog.providers).toHaveLength(1)
			expect(dialog.providers[0]?.status).toBe("connected")
			expect(dialog.providers[0]?.kind).toBe("vllm")
			// Normalized back to the server root, then re-appended by the driver.
			expect(dialog.providers[0]?.label).toBe("http://localhost:8000")
			expect(fetchMock.urls[0]).toBe("http://localhost:8000/v1/models")

			const models = await bh.listModels()
			expect(models.map((m) => m.ref)).toContain("vllm/meta-llama/Llama-3.1-8B-Instruct")
			// max_model_len reaches the catalogue, which is what keeps
			// auto-compaction enabled for this model.
			expect(models.find((m) => m.driver === "vllm")?.capabilities.contextWindow).toBe(131072)
		} finally {
			;(globalThis as { fetch: typeof fetch }).fetch = originalFetch
		}
	})

	it("marks a dead vLLM endpoint as errored rather than registering it", async () => {
		const fetchMock = fakeFetch(() => ({ status: 500, json: { error: "down" } }))
		;(globalThis as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch
		try {
			await start()
			addProvider("vllm", "http://localhost:8000")
			await new Promise((resolve) => setTimeout(resolve, 20))

			expect(dialog.providers[0]?.status).toBe("error")
			expect((await bh.listModels()).some((m) => m.driver === "vllm")).toBe(false)
		} finally {
			;(globalThis as { fetch: typeof fetch }).fetch = originalFetch
		}
	})

	// vLLM and OpenAI drivers have distinct ids, so they do NOT shadow each
	// other in the kernel's catalogue — both providers stay live at once.
	it("coexists with an OpenAI provider without shadowing it", async () => {
		const fetchMock = fakeFetch((url) =>
			url.startsWith("http://localhost:8000")
				? { json: vllmModels() }
				: { json: openRouterModels() },
		)
		;(globalThis as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch
		try {
			await start()
			addProvider("vllm", "http://localhost:8000")
			addProvider("openai", "https://openrouter.ai/api", "sk-or-v1-test")
			await new Promise((resolve) => setTimeout(resolve, 30))

			const drivers = new Set((await bh.listModels()).map((m) => m.driver))
			expect(drivers).toEqual(new Set(["vllm", "openai"]))
		} finally {
			;(globalThis as { fetch: typeof fetch }).fetch = originalFetch
		}
	})
})
