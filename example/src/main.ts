/**
 * @file BHZAI WebLLM example · bootstrap.
 *
 * The only file that knows the `index.html` id contract. It resolves every
 * element, wires the custom elements to the two orchestrators, and gets out of
 * the way. All DOM manipulation lives in `components/`, all kernel and engine
 * work in `app/`.
 *
 * Imports `@bhzai/core` by its published subpath names — never
 * `../../src/*.ts` — so the example exercises the real package boundary.
 */

import type { ModelInfo } from "@bhzai/core"
import { BHZAI } from "@bhzai/core"
import { createMcpPlugin } from "@bhzai/core/plugins/mcp"
import { type MLCEngineInstance, WebLLM } from "@bhzai/core/plugins/webllm"

import { createChatController } from "./app/chat-controller.js"
import { showFatalError } from "./app/fatal-error.js"
import { createMcpController } from "./app/mcp-controller.js"
import { createProviderController } from "./app/provider-controller.js"
import { createEngine, hasWebGpu, prebuiltAppConfig } from "./app/webllm-engine.js"
// Importing the component modules registers their custom elements.
import "./components/cold-start-panel.js"
import "./components/composer.js"
import "./components/conversation-view.js"
import "./components/mcp-add-form.js"
import "./components/mcp-error-dialog.js"
import "./components/mcp-server-list.js"
import "./components/model-select.js"
import "./components/provider-cog.js"
import "./components/providers-dialog.js"
import "./components/status-indicator.js"
import "./components/telemetry-panel.js"
import { byId } from "./lib/dom.js"

/** Resolve every custom element from the markup in `index.html`. */
function buildUi() {
	return {
		status: byId<BhzaiStatusIndicator>("status"),
		modelSelect: byId<BhzaiModelSelect>("model-select"),
		providerCog: byId<BhzaiProviderCog>("provider-cog"),
		providersDialog: byId<BhzaiProvidersDialog>("providers-dialog"),
		composer: byId<BhzaiComposer>("composer"),
		conversation: byId<BhzaiConversation>("conversation"),
		telemetry: byId<BhzaiTelemetry>("telemetry-stats"),
		coldStart: byId<BhzaiColdStart>("cold-start"),
		mcpForm: byId<BhzaiMcpAddForm>("mcp-add"),
		mcpDialog: byId<BhzaiMcpErrorDialog>("mcp-error-dialog"),
		mcpServerList: byId<BhzaiMcpServerList>("mcp-servers"),
	}
}

// The imports above only register classes; type-only imports keep the file honest.
import type { BhzaiColdStart } from "./components/cold-start-panel.js"
import type { BhzaiComposer } from "./components/composer.js"
import type { BhzaiConversation } from "./components/conversation-view.js"
import type { BhzaiMcpAddForm } from "./components/mcp-add-form.js"
import type { BhzaiMcpErrorDialog } from "./components/mcp-error-dialog.js"
import type { BhzaiMcpServerList } from "./components/mcp-server-list.js"
import type { BhzaiModelSelect } from "./components/model-select.js"
import type { BhzaiProviderCog } from "./components/provider-cog.js"
import type { BhzaiProvidersDialog } from "./components/providers-dialog.js"
import type { BhzaiStatusIndicator } from "./components/status-indicator.js"
import type { BhzaiTelemetry } from "./components/telemetry-panel.js"

/** Pick a sensible default from a list of bare model ids. */
function pickDefaultModel(models: ModelInfo[]): ModelInfo | undefined {
	return (
		models.find((m) => m.id.startsWith("Qwen3")) ??
		models.find((m) => m.id.startsWith("Qwen")) ??
		models[0]
	)
}

/** Set up the engine, the kernel, and both orchestrators. */
async function initialize(): Promise<void> {
	const ui = buildUi()

	// WebGPU is required for WebLLM, and nothing below works without it.
	if (!hasWebGpu()) {
		showFatalError(
			"WebGPU unavailable — this demo needs a WebGPU-capable browser (Chrome/Edge 113+).",
			ui,
		)
		return
	}

	try {
		const engine = createEngine((progress, text) => ui.coldStart.show(progress, text))

		const bh = new BHZAI()
		// Pre-warmed form: the host owns the engine, which is what lets the chat
		// controller read `runtimeStatsText()` for telemetry.
		//
		// The cast is a structural-typing artifact, not a runtime concern. The
		// driver models the engine with a single streaming `create` signature,
		// while MLCEngine's real `create` is an overload set whose first member is
		// the NON-streaming one — so TypeScript compares against that and reports
		// `stream: true` as incompatible. The call the driver actually makes is
		// exactly the streaming overload.
		const driver = new WebLLM({
			engine: engine as unknown as MLCEngineInstance,
			appConfig: prebuiltAppConfig,
		})
		bh.addDriver(driver)

		// The MCP plugin fills the kernel's client-factory seam — without it
		// `bh.addMcp()` refuses to attach anything — and hands back a manager that
		// makes each attached server's state observable. Must be `use()`d before
		// `init()`; the manager is only usable after.
		const mcp = createMcpPlugin()
		bh.use(mcp.plugin)

		await bh.init()

		// Seed the picker from the live kernel catalogue and keep it in sync.
		const refreshPicker = async () => {
			ui.modelSelect.models = await bh.listModels()
		}
		await refreshPicker()
		bh.on("models.changed", refreshPicker)

		const models = ui.modelSelect.models
		const defaultModel = pickDefaultModel(models)
		if (!defaultModel) {
			showFatalError("No models available in @mlc-ai/web-llm — check your installation.", ui)
			return
		}
		ui.modelSelect.selectedModelId = defaultModel.id

		const chat = createChatController({ bh, engine, driver, ui })
		ui.composer.wire({
			onSend: (text) => void chat.send(text),
			onStop: () => chat.stop(),
		})
		ui.modelSelect.addEventListener("bhzai-change", (event) => {
			const ref = (event as CustomEvent<{ ref: string }>).detail?.ref
			if (ref) void chat.selectModel(ref)
		})

		const mcpController = createMcpController({
			manager: mcp.manager,
			serverList: ui.mcpServerList,
			form: ui.mcpForm,
			dialog: ui.mcpDialog,
		})

		// Deliberately not awaited: a slow or dead MCP endpoint must not delay the
		// chat UI, and every outcome lands in the panel either way.
		void mcpController.start()

		// The providers panel owns ollama driver lifecycle. Adding an ollama
		// driver triggers `models.changed`, so the picker is refreshed via the
		// same `refreshPicker` callback the kernel subscription uses.
		const providerController = createProviderController({
			bh,
			cog: ui.providerCog,
			dialog: ui.providersDialog,
			onProvidersChanged: () => void refreshPicker(),
		})
		void providerController.start()

		// The picker shows `defaultModel.id` on load, but a programmatic default
		// never fires a `bhzai-change` event — so bootstrap that conversation here,
		// and the very first message works without touching the picker.
		await chat.selectModel(defaultModel.ref)
	} catch (error) {
		console.error("Initialization failed:", error)
		showFatalError("Failed to initialize — check the console for details.", ui)
	}
}

document.addEventListener("DOMContentLoaded", () => {
	void initialize()
})
