// '/slash'-command type declarations (§ 6 Kernel API, one-line doc comment).
// Types only — no runtime logic.
//
// CROSS-TASK COORDINATION NOTE: TASK_0002's scope originally covered every
// shared type under src/types/, but the command-specific shapes
// (`BHZAICommandDefinition`, `BHZAICommandContext`) were not landed in that
// task's barrel before TASK_0010 started. Per TASK_0010's dependency
// instructions ("add it to `bhzai/src/types/` if not already present; if
// TASK_0002 hasn't declared it, this task adds it and flags the addition,
// same pattern as TASK_0009's note about `BHZAIDriver`"), TASK_0010 adds them
// here — in the canonical types home, not as duplicated stubs — and flags the
// gap so TASK_0002's owner can reconcile. The shapes match ARCHITECTURE.md § 6
// verbatim where the doc is explicit; the inferred `BHZAICommandContext` is
// documented below as an explicit design decision (the doc gives zero detail
// on command `ctx`).
//
// SPEC SURFACE (ARCHITECTURE.md § 6, lines 211-213) — this is the ENTIRE spec
// text for `addCommand`:
//   > '/slash' commands for chat/CLI hosts.
//   > def = { description, handler(args, ctx), complete?(prefix) }
//   > — the completion hook powers autocomplete in TUI/chat hosts
//   >   (pi's getArgumentCompletions).
// There is NO dedicated "Commands" section elsewhere in the architecture doc
// (unlike Tools § 9 or Drivers § 10). Everything beyond `def`'s literal
// `{ description, handler(args, ctx), complete?(prefix) }` shape in this file
// is TASK_0010's own inferred design, marked inline as such — see the
// per-field TSDoc and the `BHZAICommandContext` block comment.

import type { BHZAIConversation } from "./tool.js"

/**
 * Per-invocation context handed to a command `handler` (§ 6).
 *
 * **INFERRED, NOT SPECIFIED.** The architecture doc gives zero detail on the
 * shape of a command `ctx`. This interface is TASK_0010's own design decision,
 * inferred by analogy with `ToolInvocation` (§ 9.1 lines 612-618), which gives
 * host-invoked tool executions access to `conversation` and an abort `signal`.
 * Commands are not tools and § 9.1 does not literally specify command `ctx`;
 * it is cited purely as the closest existing precedent in the doc for "a
 * per-invocation context object passed to a host-invoked handler."
 *
 * Field-by-field rationale (every field here is a guess this task is explicitly
 * taking responsibility for, not a spec requirement):
 *
 * - `conversation?` is OPTIONAL (`?`), unlike `ToolInvocation.conversation`
 *   which is required. A tool call always happens inside a conversation's
 *   tool-call loop, so a conversation always exists; a command may plausibly
 *   be invoked from a host context with no active conversation yet (e.g. a
 *   `/new` command that creates one), so requiring it would be wrong.
 * - `signal?` is included by analogy with `ToolInvocation.signal`, on the
 *   reasoning that any host-invoked action benefits from cancellability. Since
 *   no host loop exists yet in this task group to actually abort it, this
 *   field may go unused for now — that's acceptable; it's forward-looking
 *   scaffolding, not a claim that cancellation is fully wired end-to-end in
 *   TASK_0010.
 *
 * Do NOT add further fields (no `bh` reference, no arbitrary host-injected
 * data) beyond these two without flagging the addition as a further inferred
 * extension — keep the invented surface minimal.
 */
export interface BHZAICommandContext {
	/** The active conversation the command was invoked against, if any. */
	conversation?: BHZAIConversation
	/** Allows a long-running command handler to be cancelled. */
	signal?: AbortSignal
}

/**
 * A '/slash'-command definition (§ 6 Kernel API).
 *
 * The literal spec shape is `{ description, handler(args, ctx),
 * complete?(prefix) }`. Field-by-field:
 *
 * - `description` — required, per the doc comment's literal shape.
 * - `handler(args, ctx)` — required. **EXPLICIT ASSUMPTION (the doc does not
 *   specify)**: `args` is a pre-tokenized `string[]` — a whitespace-tokenized
 *   argument list. The host is responsible for the initial `/name ...` parsing
 *   and hands this registry only the arguments AFTER the command name, already
 *   split on whitespace. Quoting/escaping rules are explicitly NOT this
 *   registry's concern and are left to whatever host eventually wires real
 *   input (e.g. a future CLI/TUI host task). A handler may be sync or async;
 *   the registry does not inspect or interfere with the return value.
 * - `complete?(prefix)` — optional, per the doc comment's `complete?(prefix)`.
 *   Return type is unspecified in the doc; this type documents it as `unknown`
 *   (deferring to whatever the eventual autocomplete-consuming host expects —
 *   likely `string[]` of suggestions, but since no host UI exists yet in this
 *   task group, do not over-commit to a return shape beyond `unknown`).
 *
 * The stored shape is identical whether it arrives via the imperative
 * `bh.addCommand(name, def)` path or via the capability-object `commands:`
 * key resolved during `use()`/`init()` (§ 7.2 line 272) — wiring the
 * capability-object path into this registry is TASK_0003/0005's job, not
 * TASK_0010's; this type simply ensures both arrival paths store the same
 * shape so future wiring is trivial.
 */
export interface BHZAICommandDefinition {
	/** Human-readable summary shown in `/help`-style listings. */
	description: string
	/**
	 * Invoked when a host dispatches `/name <args...>`. `args` is a
	 * whitespace-tokenized argument list (the host owns the `/name` parsing).
	 */
	handler(args: string[], ctx: BHZAICommandContext): unknown | Promise<unknown>
	/**
	 * Optional autocomplete hook (pi's `getArgumentCompletions`). Return type
	 * is `unknown` since no host UI exists yet to pin a concrete shape.
	 */
	complete?(prefix: string): unknown | Promise<unknown>
}
