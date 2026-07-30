/**
 * @file Provider orchestration: the providers dialog, ollama driver lifecycle,
 * and persistence.
 *
 * Mirrors `mcp-controller.ts`'s structure: the controller owns the live ollama
 * driver instances keyed by provider id, wires the dialog's events, persists
 * the provider list, and refreshes the model picker via the
 * `onProvidersChanged` callback (adding an ollama driver triggers
 * `models.changed`).
 *
 * KERNEL SHADOWING NOTE: `bh.addDriver` is synchronous and shadows by
 * `driver.id`. Every `Ollama` instance has `id === 'ollama'`, so only the
 * LAST-added ollama driver is live in the kernel at any time — earlier ones
 * are replaced in the catalogue but their `Ollama` instances keep emitting
 * lifecycle events to this controller. For this example that is acceptable:
 * the UI still tracks each configured provider's connection state
 * independently via its own `Ollama` instance's events, but only the
 * most-recently-added contributes models to the catalogue. If each provider
 * needed to be independently live, the drivers would need distinct ids —
 * out of scope here.
 *
 * REMOVAL LIMITATION: the kernel has no `removeDriver`. For removal we
 * disconnect our `Ollama` reference (clearing its caps cache and firing the
 * `disconnect` event) and drop it from our tracking map, but the kernel's
 * shadowed `ollama` entry is NOT unregistered — a later `addDriver` would
 * replace it, but a remove leaves the last-added one in place. Documented
 * here; acceptable for a local demo.
 */

import type { BHZAI } from "@bhzai/core"
import { Ollama } from "@bhzai/core/plugins/ollama"

import type { BhzaiProviderCog } from "../components/provider-cog.js"
import type { BhzaiProvidersDialog, ProviderViewState } from "../components/providers-dialog.js"
import {
	type OllamaProviderConfig,
	loadProviders,
	normalizeBaseUrl,
	saveProviders,
	validateApiUrl,
} from "../lib/provider-store.js"
import { showErrorToast } from "../lib/toast.js"

/** Everything the provider controller drives. */
export interface ProviderControllerDeps {
	/** The live BHZAI kernel instance. */
	bh: BHZAI
	/** The providers cog button in the status bar. */
	cog: BhzaiProviderCog
	/** The providers dialog custom element. */
	dialog: BhzaiProvidersDialog
	/** Invoked whenever the provider list changes, so the model picker refreshes. */
	onProvidersChanged?: () => void
}

/** Controller returned by {@link createProviderController}. */
export interface ProviderController {
	/** Wire the dialog events, load persisted providers, and re-add each one. */
	start(): Promise<void>
}

/** Per-provider runtime tracking: the live driver plus its view state. */
interface ProviderEntry {
	/** The live `Ollama` driver instance. */
	driver: Ollama
	/** The persisted config. */
	config: OllamaProviderConfig
	/** Current connection status, updated by lifecycle events. */
	status: "connected" | "error" | "connecting"
	/** Whether the driver has been registered on the kernel via `bh.addDriver`. */
	registered: boolean
}

/**
 * Wire the providers dialog to the BHZAI kernel.
 *
 * @param deps - The kernel, the cog, the dialog, and an optional change callback
 */
export function createProviderController(deps: ProviderControllerDeps): ProviderController {
	const { bh, cog, dialog, onProvidersChanged } = deps

	/** Live ollama driver instances keyed by provider id. */
	const providers = new Map<string, ProviderEntry>()

	/** Build the view-state list the dialog renders, from the live map. */
	function viewStates(): ProviderViewState[] {
		return Array.from(providers.values()).map((entry) => ({
			id: entry.config.id,
			kind: "ollama",
			label: entry.config.baseUrl,
			status: entry.status,
			token: entry.config.token,
		}))
	}

	/** Refresh the dialog's list view from the live map. */
	function refreshList(): void {
		dialog.setProviders(viewStates())
	}

	/** Persist the current provider list. */
	function persist(): void {
		saveProviders(
			Array.from(providers.values()).map((entry) => ({
				id: entry.config.id,
				baseUrl: entry.config.baseUrl,
				token: entry.config.token,
			})),
		)
	}

	/**
	 * Create an `Ollama` driver with lifecycle event handlers, WITHOUT
	 * registering it on the kernel yet. The caller probes the connection
	 * (via `driver.listModels()`) and only calls {@link registerDriver} on
	 * success — this makes the probe the single, deterministic fetch the
	 * user sees in the network tab, rather than racing the kernel's
	 * background `addDriver` refresh (which can be skipped entirely when
	 * `syncingModels` is already true).
	 */
	function createEntry(id: string, baseUrl: string, token: string): ProviderEntry {
		const driver = new Ollama({
			baseUrl,
			headers: token ? { Authorization: `Bearer ${token}` } : {},
		})
		const config: OllamaProviderConfig = { id, baseUrl, token }
		const entry: ProviderEntry = { driver, config, status: "connecting", registered: false }

		driver.addEventListener("connect", () => {
			entry.status = "connected"
			dialog.setBusy(false)
			refreshList()
			onProvidersChanged?.()
		})
		driver.addEventListener("error", (event) => {
			const detail = (event as CustomEvent<{ error: unknown; phase: string }>).detail
			entry.status = "error"
			dialog.setBusy(false)
			refreshList()
			if (detail?.phase === "listModels") {
				showErrorToast(`Ollama connection failed: ${baseUrl}`)
			}
		})
		driver.addEventListener("disconnect", () => {
			// Disconnect is a host-intent signal; the row stays as-is until the
			// controller re-attaches or removes it.
		})

		return entry
	}

	/**
	 * Register a probed-and-connected driver on the kernel so its models
	 * appear in the merged catalogue. Idempotent — only registers once.
	 */
	function registerDriver(entry: ProviderEntry): void {
		if (entry.registered) return
		bh.addDriver(entry.driver)
		entry.registered = true
	}

	/** Add a new ollama provider from the add form. */
	async function addProvider(baseUrl: string, token: string): Promise<void> {
		const error = validateApiUrl(baseUrl)
		if (error) {
			dialog.showError(error)
			return
		}

		const normalized = normalizeBaseUrl(baseUrl)

		// If a provider with the same baseUrl already exists, update it instead
		// of creating a duplicate. The id is preserved so the UI stays in place.
		const existing = Array.from(providers.values()).find(
			(entry) => entry.config.baseUrl === normalized,
		)
		if (existing) {
			await updateProvider(existing.config.id, baseUrl, token)
			return
		}

		const id = crypto.randomUUID()

		dialog.clearError()
		dialog.setBusy(true)

		const entry = createEntry(id, normalized, token)
		providers.set(id, entry)
		refreshList()

		// Probe the connection BEFORE registering on the kernel. This is the
		// single, deterministic fetch the user sees in the network tab. On
		// success the 'connect' event fires and we register the driver; on
		// failure the 'error' event fires and we keep the provider with red
		// status so the user can edit/retry.
		try {
			await entry.driver.listModels()
			registerDriver(entry)
		} catch {
			// The 'error' event already handled status + toast.
		}

		persist()
		dialog.setProviders(viewStates())
		// Switch to edit view so a subsequent Connect click updates this
		// provider instead of creating a duplicate.
		dialog.showEditView(id)
	}

	/** Update an existing ollama provider from the edit form. */
	async function updateProvider(id: string, baseUrl: string, token: string): Promise<void> {
		const error = validateApiUrl(baseUrl)
		if (error) {
			dialog.showError(error)
			return
		}

		const normalized = normalizeBaseUrl(baseUrl)
		const existing = providers.get(id)
		if (!existing) return

		// Disconnect the old driver first so its caps cache clears and the
		// disconnect event fires.
		existing.driver.disconnect()
		providers.delete(id)

		dialog.clearError()
		dialog.setBusy(true)

		const entry = createEntry(id, normalized, token)
		providers.set(id, entry)
		refreshList()

		try {
			await entry.driver.listModels()
			registerDriver(entry)
		} catch {
			// The 'error' event already handled status + toast.
		}

		persist()
		dialog.setProviders(viewStates())
	}

	/** Remove an ollama provider. */
	function removeProvider(id: string): void {
		const entry = providers.get(id)
		if (!entry) return

		// See the file-level REMOVAL LIMITATION note: the kernel has no
		// removeDriver, so the shadowed 'ollama' entry stays registered. We
		// disconnect our reference and drop it from tracking.
		entry.driver.disconnect()
		providers.delete(id)
		persist()
		refreshList()
		// Return to the list view so the removed row disappears.
		dialog.show()
	}

	return {
		async start() {
			cog.addEventListener("bhzai-open-providers", () => {
				dialog.show()
				refreshList()
			})

			dialog.addEventListener("bhzai-add-provider", (event) => {
				const detail = (event as CustomEvent<{ type: string; baseUrl: string; token: string }>)
					.detail
				if (detail?.type === "ollama") {
					void addProvider(detail.baseUrl, detail.token)
				}
			})

			dialog.addEventListener("bhzai-update-provider", (event) => {
				const detail = (event as CustomEvent<{ id: string; baseUrl: string; token: string }>).detail
				if (detail?.id) {
					void updateProvider(detail.id, detail.baseUrl, detail.token)
				}
			})

			dialog.addEventListener("bhzai-remove-provider", (event) => {
				const detail = (event as CustomEvent<{ id: string }>).detail
				if (detail?.id) {
					removeProvider(detail.id)
				}
			})

			// Restore saved providers one at a time, like mcp-controller
			// reconnects saved servers. Sequential so the list fills top-down.
			for (const saved of loadProviders()) {
				const entry = createEntry(saved.id, saved.baseUrl, saved.token)
				providers.set(saved.id, entry)
				refreshList()
				try {
					await entry.driver.listModels()
					registerDriver(entry)
				} catch {
					// The 'error' event already handled status + toast.
				}
			}
			refreshList()
		},
	}
}
