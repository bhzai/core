import { describe, expectTypeOf, it } from "vitest"

import type {
	BHZAIMessage,
	CallToolResult,
	ChatRequest,
	ContentBlock,
	ConversationStatus,
	DriverCapabilities,
	DriverEvent,
	EmitResult,
	GenerationParams,
	JSONSchema,
	ModelInfo,
	ToolWireDefinition,
	Unsubscribe,
	Usage,
} from "./index.js"

// Pure compile-time type-assertion tests for the shared types barrel
// (TASK_0002). These tests have no runtime assertions — they exist so that
// `tsc --noEmit` (run via `pnpm typecheck`) and Vitest's typecheck mode fail
// the build if any of the declared shapes drift from the spec. The
// `@ts-expect-error` lines are the load-bearing assertions: if the error they
// expect to suppress disappears (because a type got too loose), TypeScript
// itself reports an "Unused '@ts-expect-error' directive" error under
// `strict` + the default `expectBehavior` for that flag.

describe("BHZAIMessage", () => {
	it("accepts a literal supplying all required fields and method stubs", () => {
		const msg: BHZAIMessage = {
			id: "uuid",
			role: "user",
			content: "hi",
			blocks: [{ type: "text", text: "hi" }],
			time: 0,
			meta: {},
			append: () => {},
			setContent: () => {},
		}
		expectTypeOf<BHZAIMessage>().toMatchTypeOf<BHZAIMessage>()
		// Touch the literal so it isn't flagged as unused.
		expectTypeOf(msg).toBeObject()
	})

	it("rejects a literal missing a required field (omits `time`)", () => {
		// @ts-expect-error - missing `time` is not assignable to BHZAIMessage
		const _bad: BHZAIMessage = {
			id: "uuid",
			role: "user",
			content: "hi",
			blocks: [],
			meta: {},
			append: () => {},
			setContent: () => {},
		}
		// The `@ts-expect-error` above is the load-bearing assertion: if
		// BHZAIMessage ever loosens to accept this literal, TS2578 (unused
		// directive) fails the build.
		expectTypeOf<BHZAIMessage>().not.toBeNever()
	})
})

describe("DriverEvent", () => {
	it("narrows correctly on the `done` variant", () => {
		const handle = (event: DriverEvent): string => {
			if (event.type === "done") {
				// `stopReason` is accessible inside the narrowed branch.
				expectTypeOf(event.stopReason).toEqualTypeOf<
					"stop" | "tool-calls" | "length" | "abort" | "error"
				>()
				// `text` only exists on `delta`/`reasoning-delta` — must NOT be
				// accessible inside the `done` branch.
				// @ts-expect-error - `text` does not exist on the `done` variant
				const _leak: string = event.text
				// Suppress unused-binding lint while keeping the @ts-expect-error
				// above load-bearing.
				expectTypeOf<string>().not.toBeNever()
				return event.stopReason
			}
			return "other"
		}
		expectTypeOf(handle).toBeFunction()
	})
})

describe("ModelInfo.availability", () => {
	it("accepts the three documented literal values", () => {
		const ready: ModelInfo = {
			ref: "ollama/llama3.3:70b",
			driver: "ollama",
			id: "llama3.3:70b",
			capabilities: {
				streaming: true,
				toolCalls: true,
				reasoning: false,
			},
			availability: "ready",
		}
		const downloadable: ModelInfo = { ...ready, availability: "downloadable" }
		const unavailable: ModelInfo = { ...ready, availability: "unavailable" }
		expectTypeOf(ready.availability).toEqualTypeOf<"ready" | "downloadable" | "unavailable">()
		expectTypeOf(downloadable.availability).toEqualTypeOf<
			"ready" | "downloadable" | "unavailable"
		>()
		expectTypeOf(unavailable.availability).toEqualTypeOf<"ready" | "downloadable" | "unavailable">()
	})

	it("rejects a fourth string literal", () => {
		const base: ModelInfo = {
			ref: "ollama/llama3.3:70b",
			driver: "ollama",
			id: "llama3.3:70b",
			capabilities: { streaming: true, toolCalls: true, reasoning: false },
			availability: "ready",
		}
		// @ts-expect-error - `'pending'` is not assignable to ModelInfo.availability
		const _bad: ModelInfo = { ...base, availability: "pending" }
		expectTypeOf<ModelInfo>().not.toBeNever()
	})
})

describe("EmitResult<Payload>", () => {
	it("treats `patch` as Partial<Payload>", () => {
		type P = { foo: number; bar: string }
		const ok: EmitResult<P> = {
			blocked: false,
			patch: { foo: 1 },
			handled: 1,
		}
		expectTypeOf(ok.patch).toEqualTypeOf<Partial<P>>()

		// A field not in `P` must be rejected.
		// @ts-expect-error - `baz` is not a key of P, so not assignable to Partial<P>
		const _bad: EmitResult<P> = { blocked: false, patch: { baz: true }, handled: 0 }
		expectTypeOf<EmitResult<P>>().not.toBeNever()
	})

	it("can be used as a bare alias defaulting to unknown", () => {
		const bare: EmitResult = { blocked: false, patch: {}, handled: 0 }
		expectTypeOf(bare.patch).toEqualTypeOf<Partial<unknown>>()
	})
})

describe("ConversationStatus", () => {
	it("accepts the six documented literal values", () => {
		const statuses: ConversationStatus[] = [
			"idle",
			"streaming",
			"waiting-tool",
			"compacting",
			"aborted",
			"error",
		]
		expectTypeOf(statuses).toEqualTypeOf<ConversationStatus[]>()
	})

	it("rejects a bogus string literal", () => {
		// @ts-expect-error - `'running'` is not a ConversationStatus
		const _bad: ConversationStatus = "running"
		expectTypeOf<ConversationStatus>().not.toBeNever()
	})
})

// Sanity-check that every exported type is at least referenced, so a future
// barrel edit that drops an export surfaces here as a compile error.
describe("barrel surface", () => {
	it("references every exported type", () => {
		expectTypeOf<Unsubscribe>().toEqualTypeOf<() => void>()
		expectTypeOf<Usage>().toEqualTypeOf<{ inputTokens: number; outputTokens: number }>()
		expectTypeOf<JSONSchema>().toEqualTypeOf<Record<string, unknown>>()
		expectTypeOf<ContentBlock>().not.toBeNever()
		expectTypeOf<CallToolResult>().toEqualTypeOf<{
			content: ContentBlock[]
			structuredContent?: Record<string, unknown>
			isError?: boolean
			_meta?: Record<string, unknown>
		}>()
		expectTypeOf<DriverCapabilities>().toEqualTypeOf<{
			streaming: boolean
			toolCalls: boolean
			reasoning: boolean
			embeddings?: boolean
			contextWindow?: number
		}>()
		expectTypeOf<GenerationParams>().toEqualTypeOf<{
			temperature?: number
			maxTokens?: number
			stop?: string[]
			reasoning?: "off" | "minimal" | "low" | "medium" | "high" | "max"
		}>()
		expectTypeOf<ToolWireDefinition>().toEqualTypeOf<{
			name: string
			description: string
			inputSchema: JSONSchema
		}>()
		expectTypeOf<ChatRequest>().toEqualTypeOf<{
			model: string
			messages: BHZAIMessage[]
			systemPrompt?: string
			tools?: ToolWireDefinition[]
			params?: GenerationParams
			signal: AbortSignal
		}>()
	})
})
