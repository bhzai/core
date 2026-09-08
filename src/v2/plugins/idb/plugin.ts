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

		return () => {
			unregister()
		}
	},
}
