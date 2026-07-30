/** @file Quickstart example for BHZAI — demonstrates kernel initialization, plugin registration, and a simple agent loop */

import { BHZAI } from "@bhzai/core"
import { Ollama } from "@bhzai/core/plugins/ollama"

/**
 * Quickstart entry point — demonstrates core BHZAI workflow:
 * 1. Create a BHZAI instance
 * 2. Register a driver (Ollama) and a custom tool
 * 3. Initialize the kernel
 * 4. Create a conversation
 * 5. Send a message and observe the agent response
 *
 * @returns A promise resolving to an object with the assistant's response content
 */
export async function runQuickstart(): Promise<{ content: string }> {
	// 1. Create a BHZAI instance
	const bh = new BHZAI()

	// 2. Register the Ollama driver (which talks to a local/remote Ollama server)
	bh.addDriver(new Ollama({ baseUrl: "http://localhost:11434" }))

	// 3. Register a simple custom tool via the capability-object plugin form (§ 7.2)
	bh.use({
		name: "quickstart-plugin",
		initialize({ bh }) {
			bh.addTool({
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
		},
	})

	// 4. Initialize the kernel (runs plugin initialize hooks, resolves models, etc.)
	await bh.init()

	// 5. Create a conversation with a specific model (qualified 'driver/model' reference)
	const conversation = await bh.createConversation({
		model: "ollama/llama3.3",
	})

	// 6. Send a message and observe the agent response
	const response = await conversation.sendMessage(
		"Say hello and introduce yourself in one sentence.",
	)

	console.log("Assistant response:", response.content)

	// 7. Clean up
	await bh.dispose()

	// Return the response for testing purposes
	return { content: response.content }
}

// Run the quickstart when this file is executed as a module
if (import.meta.url === `file://${process.argv[1]}`) {
	runQuickstart().catch(console.error)
}
