/** @file Integration tests for BHZAI.dispose() — TASK_0035 */

import { describe, expect, it, vi } from "vitest"
import { BHZAI } from "./bhzai.js"

// TASK_0035 — dispose() teardown integration: abort in-flight conversations,
// fire the dispose event, run plugin dispose hooks, close MCP sessions, and
// guard against post-dispose calls. These tests verify the full sequence
// works correctly even when all subsystems are active simultaneously.

describe("BHZAI.dispose — integration teardown", () => {
	it("live conversations are aborted on dispose", async () => {
		const bh = new BHZAI()
		await bh.init()

		const conversation = await bh.createConversation()
		expect(conversation.status).toBe("idle")

		// Dispose should abort the conversation
		await bh.dispose()

		// After dispose, conversation should be aborted
		expect(conversation.status).toBe("aborted")
	})

	it("every registered MCP session is closed", async () => {
		const bh = new BHZAI()

		// Mock MCP client factory
		const mockClose1 = vi.fn(async () => {})
		const mockClose2 = vi.fn(async () => {})

		let callCount = 0
		const mockFactory = vi.fn((config, toolRegistry, options) => {
			callCount++
			if (callCount === 1) {
				return {
					serverName: "server1",
					connect: async () => {},
					close: mockClose1,
				}
			}
			return {
				serverName: "server2",
				connect: async () => {},
				close: mockClose2,
			}
		})

		bh.registerMcpClientFactory(mockFactory)
		await bh.init()

		// Attach first MCP server
		await bh.addMcp({ name: "server1", url: "http://test1.local" })

		// Attach second MCP server
		await bh.addMcp({ name: "server2", url: "http://test2.local" })

		// Dispose should close all MCP sessions
		await bh.dispose()

		// Both close methods should have been called
		expect(mockClose1).toHaveBeenCalledTimes(1)
		expect(mockClose2).toHaveBeenCalledTimes(1)
	})

	it("plugin dispose hooks run in reverse order even with conversations and MCP sessions", async () => {
		const order: string[] = []
		const bh = new BHZAI()

		// Register two plugins with dispose hooks
		bh.use({
			name: "plugin-a",
			dispose: () => {
				order.push("A")
			},
		})
		bh.use({
			name: "plugin-b",
			dispose: () => {
				order.push("B")
			},
		})

		// Mock MCP client
		const mockClose = vi.fn(async () => {})
		const mockFactory = vi.fn((config, toolRegistry, options) => ({
			serverName: config.name || "test-server",
			connect: async () => {},
			close: mockClose,
		}))

		bh.registerMcpClientFactory(mockFactory)
		await bh.init()

		// Create a live conversation
		const conversation = await bh.createConversation()

		// Attach an MCP server
		await bh.addMcp({ name: "test-server", url: "http://test.local" })

		// Dispose with everything active
		await bh.dispose()

		// Plugin hooks run in reverse order (B, A)
		expect(order).toEqual(["B", "A"])
		// Conversation should be aborted
		expect(conversation.status).toBe("aborted")
		// MCP close should have been called
		expect(mockClose).toHaveBeenCalledTimes(1)
	})

	it("post-dispose addMcp is rejected", async () => {
		const bh = new BHZAI()
		const mockFactory = vi.fn((config, toolRegistry, options) => ({
			serverName: config.name || "test-server",
			connect: async () => {},
		}))
		bh.registerMcpClientFactory(mockFactory)
		await bh.init()
		await bh.dispose()

		await expect(bh.addMcp({ name: "test", url: "http://test.local" })).rejects.toThrow(/disposed/i)
	})

	it("post-dispose createConversation is rejected", async () => {
		const bh = new BHZAI()
		await bh.init()
		await bh.dispose()

		await expect(bh.createConversation()).rejects.toThrow(/disposed/i)
	})

	it("post-dispose loadConversation is rejected", async () => {
		const bh = new BHZAI()
		await bh.init()
		await bh.dispose()

		const snapshot = { v: 1, id: "test", messages: [] }
		await expect(bh.loadConversation(snapshot)).rejects.toThrow(/disposed/i)
	})

	it("post-dispose use is rejected", async () => {
		const bh = new BHZAI()
		await bh.dispose()

		expect(() => bh.use(() => {})).toThrow(/disposed/i)
	})

	it("post-dispose addTool is rejected", async () => {
		const bh = new BHZAI()
		await bh.dispose()

		expect(() => {
			bh.addTool("test", { type: "object" }, async () => ({ content: [] }))
		}).toThrow(/disposed/i)
	})

	it("post-dispose addDriver is rejected", async () => {
		const bh = new BHZAI()
		await bh.dispose()

		expect(() => {
			bh.addDriver({
				id: "test",
				listModels: async () => [],
				capabilities: () => ({ streaming: false, toolCalls: false, reasoning: false }),
				chat: async function* () {},
			})
		}).toThrow(/disposed/i)
	})

	it("post-dispose addCommand is rejected", async () => {
		const bh = new BHZAI()
		await bh.dispose()

		expect(() => {
			bh.addCommand("test", {
				description: "test",
				handler: async () => ({}),
			})
		}).toThrow(/disposed/i)
	})

	it("post-dispose complete is rejected", async () => {
		const bh = new BHZAI()
		await bh.dispose()

		await expect(bh.complete({ messages: [] })).rejects.toThrow(/disposed/i)
	})

	it("post-dispose embed is rejected", async () => {
		const bh = new BHZAI()
		await bh.dispose()

		await expect(bh.embed({ input: "test" })).rejects.toThrow(/disposed/i)
	})

	it("dispose event fires before plugin dispose hooks", async () => {
		const order: string[] = []
		const bh = new BHZAI()

		bh.use({
			name: "plugin",
			dispose: () => {
				order.push("hook")
			},
		})

		bh.on("dispose", () => {
			order.push("event")
		})

		await bh.dispose()

		// Event fires before hooks (per § 8.5)
		expect(order).toEqual(["event", "hook"])
	})

	it("MCP close failures do not prevent other sessions from closing", async () => {
		const bh = new BHZAI()

		const mockClose1 = vi.fn(async () => {
			throw new Error("session 1 close failed")
		})
		const mockClose2 = vi.fn(async () => {})

		let callCount = 0
		const mockFactory = vi.fn((config, toolRegistry, options) => {
			callCount++
			if (callCount === 1) {
				return {
					serverName: "server1",
					connect: async () => {},
					close: mockClose1,
				}
			}
			return {
				serverName: "server2",
				connect: async () => {},
				close: mockClose2,
			}
		})

		bh.registerMcpClientFactory(mockFactory)
		await bh.init()

		await bh.addMcp({ name: "server1", url: "http://test1.local" })
		await bh.addMcp({ name: "server2", url: "http://test2.local" })

		// Dispose should still attempt both closes via Promise.allSettled
		await expect(bh.dispose()).rejects.toThrow(/MCP session close failed/)

		// Both should have been called even though first rejected
		expect(mockClose1).toHaveBeenCalledTimes(1)
		expect(mockClose2).toHaveBeenCalledTimes(1)
	})

	it("MCP close failures are aggregated in error message", async () => {
		const bh = new BHZAI()

		const mockClose1 = vi.fn(async () => {
			throw new Error("error 1")
		})
		const mockClose2 = vi.fn(async () => {
			throw new Error("error 2")
		})

		let callCount = 0
		const mockFactory = vi.fn((config, toolRegistry, options) => {
			callCount++
			if (callCount === 1) {
				return {
					serverName: "server1",
					connect: async () => {},
					close: mockClose1,
				}
			}
			return {
				serverName: "server2",
				connect: async () => {},
				close: mockClose2,
			}
		})

		bh.registerMcpClientFactory(mockFactory)
		await bh.init()

		await bh.addMcp({ name: "server1", url: "http://test1.local" })
		await bh.addMcp({ name: "server2", url: "http://test2.local" })

		// Dispose should throw with both errors aggregated
		try {
			await bh.dispose()
			throw new Error("expected dispose to throw")
		} catch (err) {
			const errorMsg = err instanceof Error ? err.message : String(err)
			// Both error messages should be in the aggregated error
			expect(errorMsg).toMatch(/error 1/)
			expect(errorMsg).toMatch(/error 2/)
		}
	})
})
