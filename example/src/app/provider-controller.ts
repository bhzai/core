/**
 * @file Provider orchestration: the providers dialog, local HTTP driver
 * lifecycle, and persistence.
 *
 * Mirrors `mcp-controller.ts`'s structure: the controller owns the live driver
 * instances keyed by provider id, wires the dialog's events, persists the
 * provider list, and refreshes the model picker via the `onProvidersChanged`
 * callback (adding a driver triggers `models.changed`).
 *
 * Three provider kinds are supported, all plain-`fetch` drivers with the same
 * lifecycle-event surface: `Ollama` (`@bhzai/core/plugins/ollama`), `LMStudio`
 * (`@bhzai/core/plugins/lmstudio`) and `OpenAI`
 * (`@bhzai/core/plugins/openai`). The first two are local servers; the third is
 * the hosted platform, and differs only in needing the API token the form
 * already collects. Everything below is written against the shared
 * {@link ProviderDriver} shape, so adding a fourth kind means one entry in
 * `PROVIDER_KINDS` plus one line in {@link createDriver}.
 *
 * KERNEL SHADOWING NOTE: `bh.addDriver` is synchronous and shadows by
 * `driver.id`. Every `Ollama` instance has `id === 'ollama'` and every
 * `LMStudio` instance has `id === 'lmstudio'`, so only the LAST-added driver
 * OF EACH KIND is live in the kernel at any time — earlier ones are replaced in
 * the catalogue but their instances keep emitting lifecycle events to this
 * controller. (An Ollama provider and an LM Studio provider do NOT shadow each
 * other; the ids differ.) For this example that is acceptable: the UI still
 * tracks each configured provider's connection state independently via its own
 * driver instance's events, but only the most-recently-added of a kind
 * contributes models to the catalogue. If each provider needed to be
 * independently live, the drivers would need distinct ids — out of scope here.
 *
 * REMOVAL LIMITATION: the kernel has no `removeDriver`. For removal we
 * disconnect our driver reference (clearing its caps cache and firing the
 * `disconnect` event) and drop it from our tracking map, but the kernel's
 * shadowed entry is NOT unregistered — a later `addDriver` would replace it,
 * but a remove leaves the last-added one in place. Documented here; acceptable
 * for a local demo.
 */

import type { BHZAI, BHZAIDriver } from "@bhzai/core"
import type { Harness } from "@bhzai/core"
import { LMStudio } from "@bhzai/core/plugins/lmstudio"
import { Ollama } from "@bhzai/core/plugins/ollama"
import { OpenAI } from "@bhzai/core/plugins/openai"
import { VLLM } from "@bhzai/core/plugins/vllm"

import type { BhzaiProviderCog } from "../components/provider-cog.js"
import type { BhzaiProvidersDialog, ProviderViewState } from "../components/providers-dialog.js"
import {
	PROVIDER_KINDS,
	type ProviderConfig,
	type ProviderKind,
	loadProviders,
	normalizeBaseUrl,
	providerLabel,
	saveProviders,
	validateApiUrl,
} from "../lib/provider-store.js"
import { showErrorToast } from "../lib/toast.js"

/**
 * The slice of a local HTTP driver this controller needs.
 *
 * Both `Ollama` and `LMStudio` satisfy it. It is spelled structurally rather
 * than as `Ollama | LMStudio` because calling `addEventListener` on a union of
 * two classes that each declaration-merge their own typed overloads resolves
 * to no common signature; going through the plain `EventTarget` contract keeps
 * one code path for every kind.
 */
type ProviderDriver = BHZAIDriver & EventTarget & { disconnect(): void }

/** Everything the provider controller drives. */
export interface ProviderControllerDeps {
	/** The live BHZAI kernel or Harness instance. */
	bh: Harness | BHZAI
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
	/** The live driver instance for this provider's kind. */
	driver: ProviderDriver
	/** The persisted config. */
	config: ProviderConfig
	/** Current connection status, updated by lifecycle events. */
	status: "connected" | "error" | "connecting"
	/** Whether the driver has been registered on the kernel via `bh.addDriver`. */
	registered: boolean
}

/**
 * Instantiate the driver for a provider kind.
 *
 * @param kind - Which provider to build
 * @param baseUrl - The normalized server root
 * @param token - Optional bearer token; empty string means unauthenticated
 * @returns A driver instance, not yet registered on the kernel
 */
function createDriver(kind: ProviderKind, baseUrl: string, token: string): ProviderDriver {
	const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {}
	switch (kind) {
		case "lmstudio":
			return new LMStudio({ baseUrl, headers })
		case "vllm":
			// The token is optional: a vLLM server only expects one when it was
			// started with `--api-key`. Tool-call and reasoning support are
			// server-launch flags invisible on the wire, so the driver's defaults
			// (tools on, reasoning off) are left in place here — see the plugin
			// README for when to override them.
			return new VLLM({ baseUrl, headers })
		case "openai":
			// The token is the API key here, not an optional extra: an OpenAI
			// provider added without one fails its probe with 401 and shows red,
			// which is the correct and legible outcome.
			return new OpenAI({ baseUrl, headers })
		default:
			return new Ollama({ baseUrl, headers })
	}
}

/**
 * Narrow an untrusted `type` from the dialog's add event to a known kind.
 *
 * @param type - The event detail's `type` field
 * @returns The matching kind, or null when it is not one we can build
 */
function toProviderKind(type: unknown): ProviderKind | null {
	return PROVIDER_KINDS.find((kind) => kind === type) ?? null
}

/**
 * Wire the providers dialog to the BHZAI kernel.
 *
 * @param deps - The kernel, the cog, the dialog, and an optional change callback
 */
export function createProviderController(deps: ProviderControllerDeps): ProviderController {
	const { bh, cog, dialog, onProvidersChanged } = deps

	/** Live driver instances keyed by provider id. */
	const providers = new Map<string, ProviderEntry>()

	/** Build the view-state list the dialog renders, from the live map. */
	function viewStates(): ProviderViewState[] {
		return Array.from(providers.values()).map((entry) => ({
			id: entry.config.id,
			kind: entry.config.kind,
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
				kind: entry.config.kind,
				baseUrl: entry.config.baseUrl,
				token: entry.config.token,
			})),
		)
	}

	/**
	 * Create a driver with lifecycle event handlers, WITHOUT registering it on
	 * the kernel yet. The caller probes the connection (via
	 * `driver.listModels()`) and only calls {@link registerDriver} on success —
	 * this makes the probe the single, deterministic fetch the user sees in the
	 * network tab, rather than racing the kernel's background `addDriver`
	 * refresh (which can be skipped entirely when `syncingModels` is already
	 * true).
	 */
	function createEntry(
		id: string,
		kind: ProviderKind,
		baseUrl: string,
		token: string,
	): ProviderEntry {
		const driver = createDriver(kind, baseUrl, token)
		const config: ProviderConfig = { id, kind, baseUrl, token }
		const entry: ProviderEntry = { driver, config, status: "connecting", registered: false }

		driver.addEventListener("connect", () => {
			entry.status = "connected"
			dialog.setBusy(false)
			refreshList()
			// Deliberately does NOT refresh the picker. Drivers dispatch
			// 'connect' from inside `listModels()`, and the picker refresh calls
			// `bh.listModels()`, which polls every driver — so refreshing here
			// feeds straight back into another 'connect'. The kernel's
			// re-entrancy guard now caps that at one extra poll, but the edge is
			// redundant regardless: `registerDriver` below calls
			// `bh.addDriver()`, whose own refresh dispatches `models.changed`,
			// which is what `onProvidersChanged` is subscribed to.
		})
		driver.addEventListener("error", (event) => {
			const detail = (event as CustomEvent<{ error: unknown; phase: string }>).detail
			entry.status = "error"
			dialog.setBusy(false)
			refreshList()
			if (detail?.phase === "listModels") {
				// Keep the underlying failure inspectable — the toast is for the
				// user, the console line is for whoever is debugging.
				console.error(`${providerLabel(kind)} connection failed: ${baseUrl}`, detail.error)
				showErrorToast(`${providerLabel(kind)} connection failed: ${baseUrl}`)
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

	/**
	 * Probe a freshly created entry and register it on success. The driver's
	 * own `error` event has already handled status and the toast on failure,
	 * so the rejection is deliberately absorbed here.
	 */
	async function connectEntry(entry: ProviderEntry): Promise<void> {
		try {
			await entry.driver.listModels()
			registerDriver(entry)
			// Refresh the picker HERE rather than from the driver's 'connect'
			// handler: this runs after `listModels()` has settled, so it cannot
			// re-enter a driver poll that is still in flight (see the note in
			// `createEntry`).
			onProvidersChanged?.()
		} catch {
			// The 'error' event already handled status + toast + console.
		}
	}

	/** Add a new provider from the add form. */
	async function addProvider(kind: ProviderKind, baseUrl: string, token: string): Promise<void> {
		const error = validateApiUrl(baseUrl, kind)
		if (error) {
			dialog.showError(error)
			return
		}

		const normalized = normalizeBaseUrl(baseUrl)

		// If a provider of the same kind and baseUrl already exists, update it
		// instead of creating a duplicate. The id is preserved so the UI stays
		// in place. The kind is part of the key: the same host and port can
		// legitimately not be two providers, but two kinds on different ports
		// are distinct entries.
		const existing = Array.from(providers.values()).find(
			(entry) => entry.config.kind === kind && entry.config.baseUrl === normalized,
		)
		if (existing) {
			await updateProvider(existing.config.id, baseUrl, token)
			return
		}

		const id = crypto.randomUUID()

		dialog.clearError()
		dialog.setBusy(true)

		const entry = createEntry(id, kind, normalized, token)
		providers.set(id, entry)
		refreshList()

		// Probe the connection BEFORE registering on the kernel. This is the
		// single, deterministic fetch the user sees in the network tab. On
		// success the 'connect' event fires and we register the driver; on
		// failure the 'error' event fires and we keep the provider with red
		// status so the user can edit/retry.
		await connectEntry(entry)

		persist()
		dialog.setProviders(viewStates())
		// Switch to edit view so a subsequent Connect click updates this
		// provider instead of creating a duplicate.
		dialog.showEditView(id)
	}

	/** Update an existing provider from the edit form. */
	async function updateProvider(id: string, baseUrl: string, token: string): Promise<void> {
		const existing = providers.get(id)
		if (!existing) return

		const kind = existing.config.kind
		const error = validateApiUrl(baseUrl, kind)
		if (error) {
			dialog.showError(error)
			return
		}

		const normalized = normalizeBaseUrl(baseUrl)

		// Disconnect the old driver first so its caps cache clears and the
		// disconnect event fires.
		existing.driver.disconnect()
		providers.delete(id)

		dialog.clearError()
		dialog.setBusy(true)

		const entry = createEntry(id, kind, normalized, token)
		providers.set(id, entry)
		refreshList()

		await connectEntry(entry)

		persist()
		dialog.setProviders(viewStates())
	}

	/** Remove a provider. */
	function removeProvider(id: string): void {
		const entry = providers.get(id)
		if (!entry) return

		// See the file-level REMOVAL LIMITATION note: the kernel has no
		// removeDriver, so the shadowed entry stays registered. We disconnect
		// our reference and drop it from tracking.
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
				const kind = toProviderKind(detail?.type)
				if (kind) {
					void addProvider(kind, detail.baseUrl, detail.token)
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
				const entry = createEntry(saved.id, saved.kind, saved.baseUrl, saved.token)
				providers.set(saved.id, entry)
				refreshList()
				await connectEntry(entry)
			}
			refreshList()
		},
	}
}
