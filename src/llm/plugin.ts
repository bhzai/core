import type { PluginContext, PluginDefinition } from "../kernel/types"
import type { BHZAIDriver, ChatRequest, DriverEvent } from "../types/driver"
import type { ModelInfo } from "../types/model"
import { executeComplete } from "./complete"
import { NoModelError } from "./errors"
import { mergeDriverCatalogues, resolveModel } from "./models"
import { callDriverWithRetry } from "./retry"
import type {
	LlmCompleteRequest,
	LlmCompleteResult,
	LlmService,
	LlmStreamRequest,
	RequestWaterfallContext,
	ResolvedModel,
} from "./types"

/**
 * Concrete implementation of the LlmService claimed on ctx.llm.
 */
class LlmServiceImpl implements LlmService {
	private readonly ctx: PluginContext
	private readonly drivers = new Map<string, BHZAIDriver>()
	private defaultModel?: string

	constructor(ctx: PluginContext) {
		this.ctx = ctx
	}

	addDriver(driver: BHZAIDriver): () => void {
		this.drivers.set(driver.id, driver)
		this.ctx.events.emit("models.changed", undefined)

		return () => {
			if (this.drivers.get(driver.id) === driver) {
				this.drivers.delete(driver.id)
				this.ctx.events.emit("models.changed", undefined)
			}
		}
	}

	getDriver(id: string): BHZAIDriver | undefined {
		return this.drivers.get(id)
	}

	listDrivers(): BHZAIDriver[] {
		return Array.from(this.drivers.values())
	}

	async listModels(): Promise<ModelInfo[]> {
		return await mergeDriverCatalogues(this.drivers.values())
	}

	setDefaultModel(modelRef?: string): void {
		this.defaultModel = modelRef
	}

	getDefaultModel(): string | undefined {
		return this.defaultModel
	}

	async resolveModel(ref?: string): Promise<ResolvedModel> {
		const target = ref ?? this.defaultModel
		if (!target) {
			throw new NoModelError()
		}
		const catalogue = await this.listModels()
		return resolveModel(target, this.drivers, catalogue)
	}

	async *stream(request: LlmStreamRequest): AsyncIterable<DriverEvent> {
		const resolved = await this.resolveModel(request.model)

		const baseRequest: ChatRequest = {
			model: resolved.model,
			messages: request.messages,
			systemPrompt: request.systemPrompt,
			tools: request.tools,
			params: request.params,
			signal: request.signal ?? new AbortController().signal,
		}

		const waterfallContext: RequestWaterfallContext = {
			driverId: resolved.driver.id,
			modelId: resolved.model,
			qualifiedRef: resolved.qualifiedRef,
		}

		const finalRequest = await this.ctx.events.runWaterfall(
			"request",
			baseRequest,
			waterfallContext,
		)

		for await (const event of callDriverWithRetry(resolved.driver, finalRequest, request.retry)) {
			yield event
		}
	}

	async complete(request: LlmCompleteRequest): Promise<LlmCompleteResult> {
		return await executeComplete((r) => this.stream(r), request)
	}
}

/**
 * Plugin providing the v0.2 LLM service by claiming ctx.llm.
 */
export const llmPlugin: PluginDefinition = {
	name: "llm",
	setup(ctx: PluginContext) {
		const service = new LlmServiceImpl(ctx)
		ctx.claim("llm", service)
	},
}
