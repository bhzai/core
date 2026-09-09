export {
	type IndexedDbPersistenceOptions,
	createIndexedDbPersistence,
} from "./persistence"

export {
	type IdbConversationsPluginOptions,
	idbConversationsPlugin,
} from "./plugin"

/** Events emitted by the IndexedDB conversations persistence plugin. */
export const IdbConversationEvents = {
	success: "idb-conversations.success",
	upgradeneeded: "idb-conversations.upgradeneeded",
	loadPage: "idb-conversations.load-page",
	loadSuccess: "idb-conversations.load.success",
	loadError: "idb-conversations.load.error",
	countSuccess: "idb-conversations.count.success",
	countError: "idb-conversations.count.error",
	conversationLoaded: "idb-conversations.conversation.loaded",
	conversationDeleted: "idb-conversations.conversation.deleted",
} as const
