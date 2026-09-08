import { describe, expect, it } from "vitest"
import * as root from "./index.js"

describe("root barrel (v0.2)", () => {
	it("exports core kernel primitives", () => {
		expect(typeof root.createHarness).toBe("function")
		expect(typeof root.createEventBus).toBe("function")
	})

	it("exports standard plugins", () => {
		expect(typeof root.sessionPlugin).toBe("object")
		expect(typeof root.llmPlugin).toBe("object")
		expect(typeof root.toolsPlugin).toBe("object")
		expect(typeof root.commandsPlugin).toBe("object")
		expect(typeof root.agentLoopPlugin).toBe("object")
		expect(typeof root.contextTrackingPlugin).toBe("object")
		expect(typeof root.compactionPlugin).toBe("object")
	})

	it("exports packaged extension plugins", () => {
		expect(typeof root.idbConversationsPlugin).toBe("object")
		expect(typeof root.mcpPlugin).toBe("object")
		expect(typeof root.createMemoryPlugin).toBe("function")
		expect(typeof root.createRagPlugin).toBe("function")
		expect(typeof root.taskPlugin).toBe("object")
	})

	it("exports LLM drivers", () => {
		expect(typeof root.Ollama).toBe("function")
		expect(typeof root.WebLLM).toBe("function")
		expect(typeof root.LMStudio).toBe("function")
		expect(typeof root.OpenAI).toBe("function")
		expect(typeof root.VLLM).toBe("function")
	})

	it("initializes a functional harness from root exports", async () => {
		const harness = await root.createHarness({
			plugins: [root.sessionPlugin, root.toolsPlugin, root.commandsPlugin],
		})
		expect(harness.ctx.events).toBeDefined()
		expect(harness.ctx.sessions).toBeDefined()
		expect(harness.ctx.tools).toBeDefined()
		expect(harness.ctx.commands).toBeDefined()
		await harness.dispose()
	})
})
