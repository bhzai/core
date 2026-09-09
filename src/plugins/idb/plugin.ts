import type { PluginContext, PluginDefinition } from "../../kernel/types"
import type { SessionService } from "../../sessions/types"
import { type IndexedDbPersistenceOptions, createIndexedDbPersistence } from "./persistence"

/**
 * Options for the idb-conversations plugin.
 */
export interface IdbConversationsPluginOptions extends IndexedDbPersistenceOptions {
	/** Custom backend identifier to register in ctx.sessions (default: "indexeddb"). */
	backendName?: string
}

/**
 * v0.2 Plugin registering IndexedDB persistence backend into ctx.sessions.
 */
export const idbConversationsPlugin: PluginDefinition<IdbConversationsPluginOptions> = {
	name: "idb-conversations",
	dependencies: ["sessions"],
	setup(ctx: PluginContext, config: IdbConversationsPluginOptions = {}) {
		const sessions = ctx.sessions as SessionService | undefined
		if (!sessions) {
			throw new Error("Sessions service must be claimed before loading idb-conversations.")
		}

		const backendName = config.backendName || "indexeddb"
		const backend = createIndexedDbPersistence(config)
		const unregister = sessions.registerBackend(backendName, backend)

		const unregLoadPage = ctx.events.on("idb-conversations.load-page", async (p: unknown) => {
			const payload = p as { offset?: number; limit?: number }
			const offset = payload?.offset ?? 0
			const list = await sessions.list({ backend: backendName })
			ctx.events.emit("idb-conversations.load.success", {
				conversations: list.slice(offset),
				offset,
				hasMore: false,
				total: list.length,
			})
		})

		const unregDelete = ctx.events.on("session/deleted", (p: unknown) => {
			const payload = p as { sessionId?: string }
			if (payload?.sessionId) {
				ctx.events.emit("idb-conversations.conversation.deleted", {
					id: payload.sessionId,
				})
			}
		})

		return () => {
			unregister()
			unregLoadPage()
			unregDelete()
		}
	},
}

/**
 * Factory creating an idb-conversations plugin instance (alias for backwards compatibility).
 * @param config Plugin options.
 */
export function createIdbConversationStorePlugin(
	config: IdbConversationsPluginOptions = {},
): PluginDefinition<IdbConversationsPluginOptions> {
	return {
		...idbConversationsPlugin,
		setup(ctx) {
			return idbConversationsPlugin.setup(ctx, config)
		},
	}
}
