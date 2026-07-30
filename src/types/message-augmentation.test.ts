/** @file Type-level proof that BHZAIMessageExtensions merges via module augmentation. */

import { describe, expect, it } from "vitest"
import { createMessage } from "../conversation/message.js"
import { BHZAI } from "../core/bhzai.js"
import type { BHZAIMessage } from "./message.js"

// This is exactly what a third-party plugin writes, except for the specifier.
// A plugin augments the package itself (`declare module "@bhzai/core"`),
// which merges even though `dist/index.d.ts` re-exports the interface from a
// bundled chunk — TypeScript follows the re-export alias to the original
// declaration. That specifier is unusable here because it only resolves once
// `dist/` exists, so this test augments the declaring module directly.
declare module "./message.js" {
	interface BHZAIMessageExtensions {
		/** Contrived plugin field, used only by this test. */
		sentiment?: "positive" | "negative"
	}
}

describe("BHZAIMessageExtensions module augmentation", () => {
	it("adds the augmented field to BHZAIMessage's static type", () => {
		const bh = new BHZAI()
		bh.defineMessageField("sentiment")

		const message = createMessage({ role: "assistant", content: "hi" }, bh._getMessageFields())

		// The assignment and the read below are the actual assertion: neither
		// compiles unless the augmentation merged into BHZAIMessage.
		message.sentiment = "positive"
		const read: "positive" | "negative" | undefined = message.sentiment

		expect(read).toBe("positive")
		expect(message.meta.sentiment).toBe("positive")
	})

	it("keeps augmented members optional so pre-existing messages stay assignable", () => {
		// A message literal that predates the plugin must still satisfy BHZAIMessage.
		const legacy: BHZAIMessage = {
			id: "m1",
			role: "user",
			content: "x",
			blocks: [{ type: "text", text: "x" }],
			time: 0,
			meta: {},
			append() {},
			setContent() {},
		}

		expect(legacy.sentiment).toBeUndefined()
	})
})
