/**
 * @file Tests for the example app conversations controller.
 */

import "fake-indexeddb/auto"
import { createHarness, idbConversationsPlugin, sessionPlugin } from "@bhzai/core"
import { IdbConversationEvents } from "@bhzai/core/plugins/idb-conversations"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { ChatController } from "./chat-controller.js"
import {
	type ConversationsControllerDeps,
	createConversationsController,
} from "./conversations-controller.js"

describe("conversations controller", () => {
	let harness: Awaited<ReturnType<typeof createHarness>>
	let fakeUi: ConversationsControllerDeps["ui"]
	let fakeChat: ChatController
	let listElement: EventTarget & {
		setConversations: ReturnType<typeof vi.fn>
		appendConversations: ReturnType<typeof vi.fn>
		setHasMore: ReturnType<typeof vi.fn>
		removeConversation: ReturnType<typeof vi.fn>
		setActive: ReturnType<typeof vi.fn>
		clearActive: ReturnType<typeof vi.fn>
	}

	beforeEach(async () => {
		listElement = Object.assign(new EventTarget(), {
			setConversations: vi.fn(),
			appendConversations: vi.fn(),
			setHasMore: vi.fn(),
			removeConversation: vi.fn(),
			setActive: vi.fn(),
			clearActive: vi.fn(),
		})

		fakeUi = {
			conversationList:
				listElement as unknown as ConversationsControllerDeps["ui"]["conversationList"],
			conversation: {} as unknown as ConversationsControllerDeps["ui"]["conversation"],
			composer: {} as unknown as ConversationsControllerDeps["ui"]["composer"],
		}

		fakeChat = {
			newConversation: vi.fn(),
			setConversation: vi.fn(),
			selectModel: vi.fn(),
			send: vi.fn(),
			stop: vi.fn(),
			activeConversationId: "conv-1",
			currentModelRef: "webllm/model",
		}

		harness = await createHarness({
			plugins: [sessionPlugin, idbConversationsPlugin],
		})
	})

	it("starts and requests the first page of conversations", async () => {
		const loadPageSpy = vi.fn()
		harness.on(IdbConversationEvents.loadPage, loadPageSpy)

		const controller = createConversationsController({
			bh: harness,
			ui: fakeUi,
			chat: fakeChat,
		})

		await controller.start()
		expect(loadPageSpy).toHaveBeenCalledWith({ offset: 0 })
	})

	it("updates conversation list on loadSuccess", async () => {
		createConversationsController({
			bh: harness,
			ui: fakeUi,
			chat: fakeChat,
		})

		const mockConversations = [
			{
				id: "c1",
				title: "First",
				createdAt: 1000,
				updatedAt: 1000,
				messageCount: 2,
				modelId: "model-1",
			},
		]

		harness.emit(IdbConversationEvents.loadSuccess, {
			conversations: mockConversations,
			offset: 0,
			hasMore: true,
		})

		expect(listElement.setConversations).toHaveBeenCalledWith(mockConversations)
		expect(listElement.setHasMore).toHaveBeenCalledWith(true)
	})

	it("handles new conversation UI action", async () => {
		createConversationsController({
			bh: harness,
			ui: fakeUi,
			chat: fakeChat,
		})

		listElement.dispatchEvent(new CustomEvent("bhzai-new-conversation"))
		expect(fakeChat.newConversation).toHaveBeenCalled()
		expect(listElement.clearActive).toHaveBeenCalled()
	})
})
