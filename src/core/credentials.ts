// TASK_0021: Credential resolution chain (§ 10.4).
//
// `resolveCredentials` is a kernel-level function that drivers and the MCP
// client consult before any authenticated call, following a strict three-tier
// priority chain (runtime values → registered `auth` hooks in plugin order →
// unauthenticated) so that BHZAI never reads secrets from files/env itself and
// never persists credentials beyond a single resolution call.
//
// PATH NOTE: TASK_0021 specifies `bhzai/src/kernel/credentials.ts`, but the
// repo convention established by TASK_0002 is `src/core/` (see
// `src/core/AGENTS.md`). This file follows the existing convention; the
// behavioral contract is unchanged.
//
// ENVIRONMENT BOUNDARY (§ 5): this module is pure TypeScript — no I/O, no
// filesystem, no env reads, no global state. It is a side-effect-free async
// function that walks an ordered list of host-supplied resolvers. The kernel
// never stores or caches secrets beyond the resolver's own lifetime (§ 10.4).

/**
 * A deliberately unopinionated credential shape.
 *
 * Credential shapes are inherently host/auth-scheme-specific (bearer tokens,
 * API keys, OAuth token pairs, custom header maps). A bearer token might be
 * represented as `{ Authorization: 'Bearer ...' }`, an API key as
 * `{ 'x-api-key': '...' }`.
 *
 * This task does not attempt to model OAuth flows, token refresh, or expiry;
 * per § 10.4, "persistence and refresh (OAuth etc.) live behind the
 * resolver," meaning any such logic belongs inside a specific `auth` hook
 * implementation a host supplies, not in this generic resolution chain. If a
 * later task finds this shape too loose for a specific driver's needs (e.g.
 * it wants a discriminated union of auth schemes), that task should widen
 * this type — do not silently redefine `Credentials` in multiple places.
 */
export type Credentials = Record<string, string>

/**
 * The scope a credential resolution applies to.
 *
 * - `kind: 'driver'` — `id` is the driver's registered id (e.g. `'ollama'`,
 *   `'webllm'`, or a third-party driver's id).
 * - `kind: 'mcp'` — `id` is the MCP server's configured id/name.
 *
 * This function does not itself validate that `scope.id` corresponds to a
 * real registered driver/MCP server; that's the caller's concern.
 */
export interface CredentialScope {
	kind: "driver" | "mcp"
	id: string
}

/**
 * A plugin capability hook (§ 7.2 `auth` key) that resolves credentials for
 * a given scope. Registered via `bh.use({ auth: { resolve } })` in plugin-
 * registration order.
 *
 * Per § 10.4's exact signature: `resolve(scope) => Promise<Credentials |
 * undefined>`. Returning `undefined` means "this hook has no credentials for
 * this scope" — the chain falls through to the next hook or tier 3
 * (unauthenticated).
 */
export interface CredentialResolver {
	resolve(scope: CredentialScope): Promise<Credentials | undefined>
}

/**
 * Resolve credentials for a scope using the three-tier priority chain
 * (§ 10.4):
 *
 * 1. **Runtime value** (tier 1): if `runtimeValue` is defined, return it
 *    immediately without consulting any `auth` hook. Runtime values are
 *    those "passed in driver/MCP options (`new Ollama({ headers })`,
 *    `bh.addMcp({ headers })`)" — i.e. the caller supplies this value
 *    directly at the call site. `resolveCredentials` itself does no I/O or
 *    registry lookup for tier 1; it simply short-circuits. The value is
 *    never persisted by the kernel (used once and discarded from this
 *    function's perspective).
 *
 * 2. **Registered `auth` hooks** (tier 2): iterate the supplied
 *    `authHooks` list **sequentially** (awaited one at a time, not
 *    `Promise.all` — consistent with § 8.2's "handlers run in registration
 *    order and are awaited sequentially" convention). Return the first
 *    defined result; stop iterating once one is found.
 *
 * 3. **Unauthenticated** (tier 3): if no hook returns a defined value
 *    (including the case where zero `auth` hooks are registered), return
 *    `undefined`. This is **not an error condition** — § 10.4 explicitly
 *    calls tier 3 "correct behavior for local Ollama and WebLLM, which need
 *    no credentials at all."
 *
 * **No caching**: this function caches nothing across calls — every
 * invocation re-runs the full chain from scratch. This is the mechanism by
 * which "the kernel never stores or caches secrets beyond the resolver's own
 * lifetime" (§ 10.4) is satisfied: there is no kernel-side cache to
 * invalidate because there is no cache at all. Any caching/refresh behavior
 * (e.g. an OAuth token cached for its lifetime) is entirely the concern of
 * the specific `CredentialResolver` implementation a host supplies.
 *
 * @param scope The credential scope (driver id or MCP server id).
 * @param runtimeValue Tier-1 runtime value supplied directly at the call
 *   site (e.g. `new Ollama({ headers })`'s `headers`). The caller is
 *   responsible for passing its own already-known runtime value in; this
 *   function does not discover it from options the caller received.
 * @param authHooks Tier-2 registered `auth` hooks in plugin-registration
 *   order. The caller (typically the `BHZAI` kernel) supplies this list by
 *   reading its plugin registry; this function itself does not access the
 *   plugin registry, keeping it a pure function with no kernel coupling.
 * @returns The resolved credentials, or `undefined` if no tier produced a
 *   value (tier 3 — correct for unauthenticated drivers).
 */
export async function resolveCredentials(
	scope: CredentialScope,
	runtimeValue?: Credentials,
	authHooks?: ReadonlyArray<CredentialResolver>,
): Promise<Credentials | undefined> {
	// Tier 1: runtime value short-circuits the entire chain.
	if (runtimeValue !== undefined) {
		return runtimeValue
	}

	// Tier 2: iterate registered `auth` hooks in registration order,
	// sequentially (not Promise.all), returning the first defined result.
	if (authHooks) {
		for (const hook of authHooks) {
			const result = await hook.resolve(scope)
			if (result !== undefined) {
				return result
			}
		}
	}

	// Tier 3: no credentials found — not an error (§ 10.4).
	return undefined
}
