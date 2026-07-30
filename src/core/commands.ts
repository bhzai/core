// '/slash'-command registry — host-invocable commands (ARCHITECTURE.md § 6).
//
// Scope of THIS file (TASK_0010): a `CommandRegistry` class backing
// `bh.addCommand(name, def)` and an internal `listCommands()` accessor for
// tests + future host integrations. It does NOT parse raw user input
// (e.g. `"/mycommand foo bar"`), does NOT dispatch to stored handlers from any
// CLI/chat host loop, and does NOT wire the capability-object `commands:` key
// resolution during `use()`/`init()` (that is TASK_0003/0005's job — this
// registry only ensures the stored `BHZAICommandDefinition` shape is identical
// regardless of arrival path, so future wiring is trivial).
//
// ENVIRONMENT BOUNDARY (§ 5): web-standard APIs only. This file touches nothing
// outside of plain TypeScript — no `fetch`, no `crypto`, no Node built-ins. It
// is runtime-agnostic.
//
// PATH NOTE: TASK_0010 specifies `bhzai/src/kernel/commands.ts`, but the package
// layout already established by TASK_0002/TASK_0003 places the kernel under
// `src/core/` (see `src/core/index.ts` and the `./core` subpath export in
// `package.json`). This file follows the existing repo convention to keep one
// kernel directory; the behavioral contract is unchanged.
//
// UNDER-SPECIFICATION CALLOUT (read first): unlike every other kernel
// registry in this task group, `addCommand` has no dedicated section, no
// worked example, and no companion event row in § 8.1's framework-events
// table (there is no `command.registered` event anywhere in the doc). The
// entire spec surface is the one-line § 6 doc comment reproduced in
// `src/types/command.ts`. Everything beyond that literal shape in this file
// is TASK_0010's own inferred design, marked inline as such.

import type { BHZAICommandDefinition } from "../types/index.js"

/**
 * The '/slash'-command registry (§ 6). Stores {@link BHZAICommandDefinition}
 * records keyed by `name` in a `Map`. Owns the duplicate-name policy and the
 * `listCommands()` test/host accessor. Has NO event-bus integration: § 8.1
 * defines no `command.registered`/`command.removed` event pair, so — exactly
 * as with TASK_0009's driver registry — this registry is a pure storage
 * structure and fires nothing on registration or replacement.
 */
export class CommandRegistry {
	/** Commands keyed by `name`; last registration wins (shadowing). */
	private readonly commands: Map<string, BHZAICommandDefinition> = new Map()

	/**
	 * Predicate deciding whether a command name is currently visible, injected
	 * by the kernel to implement plugin activation. `undefined` (the default)
	 * means no gating — a registry constructed without a kernel behaves exactly
	 * as it did before plugin activation existed.
	 *
	 * The registry stays plugin-unaware on purpose: it knows only "some names
	 * may be filtered out", never why.
	 */
	private isActive: ((commandName: string) => boolean) | undefined

	/** Install the visibility predicate. Called once by the `BHZAI` constructor. */
	setActivePredicate(predicate: (commandName: string) => boolean): void {
		this.isActive = predicate
	}

	/**
	 * Add (or replace) a command — imperative `bh.addCommand(name, def)` path
	 * (§ 6). Stores `def` under `name`.
	 *
	 * SHADOWING CONVENTION (cross-referenced to TASK_0008/TASK_0009): the
	 * architecture doc says nothing about duplicate `addCommand()` calls with
	 * the same name. This registry adopts the IDENTICAL convention
	 * TASK_0008 established for tool-name shadowing and TASK_0009 echoed for
	 * drivers: **last registration wins** — a duplicate
	 * `addCommand(name, def)` call silently replaces the earlier entry under
	 * that name, for consistency across all of BHZAI's registries (tools,
	 * drivers, commands). Rationale: same as TASK_0008's — conceptually the
	 * host still sees "a command named X" continuously across the shadowing;
	 * nothing was removed, only updated.
	 *
	 * NO EVENT FIRED (deliberate, not an oversight): unlike TASK_0008's tool
	 * registry, there is no `command.registered`/`command.removed` event pair
	 * defined anywhere in § 8.1, so this registry must NOT invent one. This
	 * mirrors TASK_0009's drivers, which likewise fire nothing on
	 * registration/replacement because § 8.1 defines no `driver.removed` row.
	 */
	addCommand(name: string, def: BHZAICommandDefinition): void {
		this.commands.set(name, def)
	}

	/**
	 * Snapshot of registered commands as `{ name, def }` entries, in
	 * registration (insertion) order.
	 *
	 * REASONABLE ADDITION beyond the literal § 6 text (which names only
	 * `addCommand`): § 6 gives no accessor for reading back registered
	 * commands. This registry needs to be testable, and a future
	 * host-integration task will need *some* way to enumerate available
	 * commands (e.g. to build a `/`-prefix autocomplete menu). This accessor
	 * is the obvious parallel to `listTools()` (§ 6 line 186) applied to
	 * commands — it would be an obvious oversight not to have any way to
	 * enumerate registered commands. If a later task (host CLI/TUI
	 * integration) needs a different shape (e.g. sorted, or filtered by
	 * prefix), that task should extend this accessor rather than fork a
	 * parallel one.
	 *
	 * Returns a fresh array each call so mutating it does not affect later
	 * calls (same snapshot-freshness guarantee `ToolRegistry.listTools`
	 * provides).
	 */
	listCommands(): Array<{ name: string; def: BHZAICommandDefinition }> {
		const out: Array<{ name: string; def: BHZAICommandDefinition }> = []
		for (const [name, def] of this.commands) {
			// A command contributed by a deactivated plugin stays registered but
			// drops out of every read path, so it cannot be listed or resolved.
			if (this.isActive !== undefined && !this.isActive(name)) continue
			out.push({ name, def })
		}
		return out
	}

	/**
	 * Look up a registered command by `name`, or `undefined` if not registered
	 * — or if its contributing plugin is currently deactivated.
	 */
	get(name: string): BHZAICommandDefinition | undefined {
		if (this.isActive !== undefined && !this.isActive(name)) return undefined
		return this.commands.get(name)
	}

	/** Number of currently-visible commands. Convenience accessor. */
	get size(): number {
		if (this.isActive === undefined) return this.commands.size
		return this.listCommands().length
	}
}
