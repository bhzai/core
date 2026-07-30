// TASK_0021 — Credential resolution chain tests (§ 10.4).
//
// These tests cover `resolveCredentials`' three-tier priority chain using
// mocked `CredentialResolver` hooks. They do NOT test the plugin registry
// (TASK_0005), the driver/MCP call sites (TASK_0019/TASK_0020/TASK_0011),
// or any OAuth/token-refresh logic (explicitly out of scope per § 10.4).
//
// The `authHooks` parameter is supplied directly to `resolveCredentials` as
// a plain array — this is the locally-injected list variant (the BHZAI kernel
// would pass `getRegisteredPlugins().filter(p => p.auth).map(p => p.auth)` in
// production, but this test file does not depend on the kernel's plugin
// registry accessor).

import { describe, expect, it, vi } from "vitest"

import {
	type CredentialResolver,
	type CredentialScope,
	type Credentials,
	resolveCredentials,
} from "./credentials.js"

const driverScope: CredentialScope = { kind: "driver", id: "ollama" }
const mcpScope: CredentialScope = { kind: "mcp", id: "my-server" }

/** Build a mock CredentialResolver that returns a fixed value. */
function mockHook(
	returnValue: Credentials | undefined,
): CredentialResolver & { resolve: ReturnType<typeof vi.fn> } {
	return {
		resolve: vi.fn(async () => returnValue),
	}
}

describe("resolveCredentials — tier 1 (runtime value)", () => {
	it("returns the runtime value immediately, even when auth hooks would return a different value", async () => {
		const runtimeValue: Credentials = { Authorization: "Bearer runtime" }
		const hook = mockHook({ Authorization: "Bearer from-hook" })

		const result = await resolveCredentials(driverScope, runtimeValue, [hook])

		expect(result).toEqual({ Authorization: "Bearer runtime" })
		// Proving short-circuit, not just "returned the right value by
		// coincidence" — the hook's resolve mock was never called.
		expect(hook.resolve).not.toHaveBeenCalled()
	})

	it("returns the runtime value when no auth hooks are registered", async () => {
		const runtimeValue: Credentials = { "x-api-key": "key123" }
		const result = await resolveCredentials(mcpScope, runtimeValue)
		expect(result).toEqual({ "x-api-key": "key123" })
	})
})

describe("resolveCredentials — tier 2 (auth hooks, first-defined-wins)", () => {
	it("consults hooks in registration order; first defined result wins", async () => {
		const hookA = mockHook({ Authorization: "Bearer from-A" })
		const hookB = mockHook({ Authorization: "Bearer from-B" })

		const result = await resolveCredentials(driverScope, undefined, [hookA, hookB])

		expect(result).toEqual({ Authorization: "Bearer from-A" })
		// Hook B was never called because hook A already returned a defined
		// value (first-wins short-circuit).
		expect(hookA.resolve).toHaveBeenCalledTimes(1)
		expect(hookB.resolve).not.toHaveBeenCalled()
	})

	it("falls through to the second hook when the first returns undefined", async () => {
		const hookA = mockHook(undefined)
		const hookB = mockHook({ Authorization: "Bearer from-B" })

		const result = await resolveCredentials(driverScope, undefined, [hookA, hookB])

		expect(result).toEqual({ Authorization: "Bearer from-B" })
		expect(hookA.resolve).toHaveBeenCalledTimes(1)
		expect(hookB.resolve).toHaveBeenCalledTimes(1)
	})

	it("passes the scope to each hook's resolve call", async () => {
		const hook = mockHook({ Authorization: "Bearer token" })
		await resolveCredentials(mcpScope, undefined, [hook])
		expect(hook.resolve).toHaveBeenCalledWith(mcpScope)
	})
})

describe("resolveCredentials — tier 3 (unauthenticated)", () => {
	it("returns undefined when no auth hooks are registered", async () => {
		const result = await resolveCredentials(driverScope)
		expect(result).toBeUndefined()
	})

	it("returns undefined when all hooks return undefined", async () => {
		const hookA = mockHook(undefined)
		const hookB = mockHook(undefined)
		const result = await resolveCredentials(driverScope, undefined, [hookA, hookB])
		expect(result).toBeUndefined()
	})

	it("does NOT throw or reject for the no-credentials case", async () => {
		await expect(resolveCredentials(driverScope)).resolves.toBeUndefined()
		await expect(
			resolveCredentials(driverScope, undefined, [mockHook(undefined)]),
		).resolves.toBeUndefined()
	})
})

describe("resolveCredentials — no caching", () => {
	it("calls the hook's resolve on every invocation (no memoization)", async () => {
		const hook = mockHook({ Authorization: "Bearer token" })
		await resolveCredentials(driverScope, undefined, [hook])
		await resolveCredentials(driverScope, undefined, [hook])
		expect(hook.resolve).toHaveBeenCalledTimes(2)
	})

	it("reflects a changed return value on the second call (no stale cache)", async () => {
		let currentValue: Credentials | undefined = {
			Authorization: "Bearer old",
		}
		const hook: CredentialResolver = {
			resolve: vi.fn(async () => currentValue),
		}

		const result1 = await resolveCredentials(driverScope, undefined, [hook])
		expect(result1).toEqual({ Authorization: "Bearer old" })

		currentValue = { Authorization: "Bearer new" }
		const result2 = await resolveCredentials(driverScope, undefined, [hook])
		expect(result2).toEqual({ Authorization: "Bearer new" })
	})
})
