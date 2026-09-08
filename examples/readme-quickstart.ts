/** @file Quickstart example for BHZAI v0.2 — demonstrates harness creation, driver registration, and a turn execution */

import {
	Ollama,
	agentLoopPlugin,
	commandsPlugin,
	createHarness,
	llmPlugin,
	sessionPlugin,
	toolsPlugin,
} from "@bhzai/core"

/**
 * Quickstart entry point — demonstrates core BHZAI v0.2 workflow:
 * 1. Create a Harness instance with standard plugins
 * 2. Register a driver (Ollama) and a custom tool
 * 3. Create a session with a target model
 * 4. Send a message and observe the agent response
 * 5. Clean up via harness.dispose()
 *
 * @returns A promise resolving to an object with the assistant's response content
 */
export async function runQuickstart(): Promise<{ content: string }> {
	// 1. Create a harness with standard plugins
	const harness = await createHarness({
		plugins: [sessionPlugin, llmPlugin, toolsPlugin, commandsPlugin, agentLoopPlugin],
	})

	// 2. Register the Ollama driver
	const ollamaDriver = new Ollama({ baseUrl: "http://localhost:11434" })
	harness.addDriver(ollamaDriver)

	// 3. Register a simple custom tool
	const tools = harness.ctx.tools as {
		register: (tool: {
			name: string
			description: string
			inputSchema: Record<string, unknown>
			execute: (
				inv: unknown,
			) => Promise<{ content: Array<{ type: string; text: string }>; isError: boolean }>
		}) => void
	}
	tools.register({
		name: "get_current_time",
		description: "Get the current time in ISO 8601 format",
		inputSchema: {
			type: "object",
			properties: {},
			required: [],
		},
		execute: async () => {
			const now = new Date().toISOString()
			return {
				content: [{ type: "text", text: `Current time: ${now}` }],
				isError: false,
			}
		},
	})

	// 4. Create a session with a specific model
	const session = await harness.createSession({
		model: "ollama/llama3.3",
	})

	// 5. Send a message and await turn completion
	const response = await session.send("Say hello and introduce yourself in one sentence.")

	console.log("Assistant response:", response.text)

	// 6. Clean up
	await harness.dispose()

	// Return the response for testing purposes
	return { content: response.text }
}

// Run the quickstart when this file is executed as a module
if (import.meta.url === `file://${process.argv[1]}`) {
	runQuickstart().catch(console.error)
}
