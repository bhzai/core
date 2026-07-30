// TC39 stage-3 class decorators for plugin form 3 (ARCHITECTURE.md § 7.2,
// lines 282-316). `@Plugin(name)` stamps a class as a BHZAI plugin;
// `@On(event)` subscribes a method to a kernel/conversation event;
// `@Tool(name, schema)` registers a method as a tool against the
// `ToolRegistrar` seam. `bh.use(new MyDecoratedClass())` detects the stamped
// metadata and normalizes it into the exact same canonical `{ name, setup(bh)
// }` shape forms 1 and 2 already produce (§ 7.1) — there is no separate
// "decorated plugin" storage path in the kernel.
//
// NATIVE DECORATORS ONLY (§ 7.2): this file uses the TC39 stage-3 decorator
// API (decorator functions receiving `(target, context)` with `context.kind`
// and `context.metadata`), which is the TypeScript ≥ 5.0 default. There is
// deliberately NO `experimentalDecorators` compatibility path — `tsconfig.json`
// does not enable that flag, and dual builds are explicitly rejected by the
// spec (double the test matrix; legacy semantics differ subtly in metadata
// and initializer order).
//
// ENVIRONMENT BOUNDARY (§ 5): web-standard APIs only. This file touches
// nothing outside of plain TypeScript — no `fetch`, no `crypto`, no Node
// built-ins. It is runtime-agnostic.
//
// PATH NOTE: TASK_0007 specifies `bhzai/src/kernel/decorators.ts`, but the
// package layout established by TASK_0002/TASK_0003 places the kernel under
// `src/core/` (see `src/core/index.ts`). This file follows the existing repo
// convention; the behavioral contract is unchanged.

import type { JSONSchema } from "../types/content.js"

/**
 * Marker interface implemented by decorator-based plugin classes (form 3,
 * § 7.2). Carries no required members.
 *
 * EXPLICIT ASSUMPTION: § 7.2's example has `MyPlugin implements BHPlugin`
 * with no interface members shown being used — the doc does not spell out
 * what, if anything, `BHPlugin` requires. `BHPlugin` is therefore an EMPTY
 * MARKER INTERFACE (structurally satisfied by any class), not a behavioral
 * contract with required methods. The actual contract is enforced by the
 * `@Plugin` decorator's runtime metadata stamping (see {@link Plugin}), not
 * by TypeScript's structural typing of `BHPlugin` itself. The interface
 * exists so `implements BHPlugin` documents intent and gives future tooling
 * (e.g. a lint rule) something to check against.
 */
// biome-ignore lint/suspicious/noEmptyInterface: intentional empty marker interface (§ 7.2); the contract is enforced by @Plugin's runtime stamping, not by structural typing.
export interface BHPlugin {}

/**
 * Per-class metadata stamped by `@Plugin` onto the decorated class's
 * prototype and read by `BHZAI.use()` to normalize a decorated instance into
 * the canonical plugin shape. Stored under the well-known
 * {@link BHZAI_PLUGIN_META} symbol; every instance of a decorated class
 * inherits it via the prototype chain.
 */
export interface PluginMetadata {
	/** The plugin name passed to `@Plugin(name)`. */
	name: string
	/** `{ methodName, event }` entries collected from `@On`-decorated methods. */
	onHandlers: Array<{ methodName: string; event: string }>
	/** `{ methodName, name, schema }` entries collected from `@Tool`-decorated methods. */
	tools: Array<{ methodName: string; name: string; schema: JSONSchema }>
}

/**
 * Well-known `Symbol` under which {@link PluginMetadata} is stamped on each
 * constructed instance by `@Plugin`'s `context.addInitializer` callback.
 * Exported so `BHZAI.use()` (in `bhzai.ts`) can read it without re-deriving the
 * key, and so external tooling/tests can introspect a decorated instance.
 */
export const BHZAI_PLUGIN_META: unique symbol = Symbol("BHZAI.plugin.meta")

/**
 * Seam interface satisfied by TASK_0008's real tool registry. Until that
 * lands, `BHZAI` supplies a temporary in-memory stub object satisfying this
 * interface so `@Tool`-decorated methods have somewhere to register against
 * without this task's code needing to change later.
 *
 * INTERFACE AGREEMENT (for TASK_0008's author/reviewer): the real tool
 * registry must expose a `register(toolDef)` method accepting exactly this
 * shape — `{ name, schema, execute }`. `BHZAI.toolRegistrar` is the property
 * the decorator-generated `setup()` calls `register` on; TASK_0008 may back
 * that property with the real registry (or make `BHZAI.addTool` itself satisfy
 * this shape) without touching `decorators.ts`. The `execute` signature is
 * loosely typed here because `ToolInvocation`'s full type is TASK_0008's to
 * define.
 */
export interface ToolRegistrar {
	register(toolDef: {
		name: string
		schema: JSONSchema
		execute: (...args: unknown[]) => unknown
	}): void
}

// ---------------------------------------------------------------------------
// Internal helpers for reading/writing the shared `context.metadata` object.
//
// TC39 stage-3 decorators give every decorator on a class the SAME
// `context.metadata` object (the value that becomes `Symbol.metadata` on the
// class). Method decorators (`@On`/`@Tool`) run before the class decorator
// (`@Plugin`) — see the ordering note on {@link Plugin} — so they push their
// entries into `context.metadata` arrays, and `@Plugin` then reads those
// arrays when stamping per-instance metadata. This avoids any fragile
// cross-decorator ordering assumption beyond "members decorate before the
// class", which the spec guarantees.
// ---------------------------------------------------------------------------

type PluginDecoratorMetadata = {
	onHandlers?: Array<{ methodName: string; event: string }>
	tools?: Array<{ methodName: string; name: string; schema: JSONSchema }>
}

function ensureOnHandlers(
	meta: PluginDecoratorMetadata,
): Array<{ methodName: string; event: string }> {
	if (!meta.onHandlers) meta.onHandlers = []
	return meta.onHandlers
}

function ensureTools(
	meta: PluginDecoratorMetadata,
): Array<{ methodName: string; name: string; schema: JSONSchema }> {
	if (!meta.tools) meta.tools = []
	return meta.tools
}

// A class constructor — the `target` of a TC39 stage-3 class decorator.
type Class = abstract new (...args: unknown[]) => unknown

/**
 * Class decorator marking the class as a BHZAI plugin and stamping its name
 * (§ 7.2 form 3). Returns the class unchanged (native decorators may replace
 * the class; we do not need to).
 *
 * Stamps {@link PluginMetadata} onto `target.prototype` under the
 * {@link BHZAI_PLUGIN_META} symbol, so every constructed instance inherits it
 * via the prototype chain and `getPluginMetadata(instance)` can read it
 * without any per-instance work. (The TC39 stage-3 class-decorator
 * `context.addInitializer` runs once with `this` bound to the *class*, not
 * per-instance, so it is not suitable for per-instance stamping; stamping the
 * prototype directly is simpler and correct, since the metadata is the same
 * for every instance of a decorated class.)
 *
 * ORDERING ASSUMPTION: TC39 decorator evaluation order is — member decorators
 * (methods, including `@On`/`@Tool`) evaluate top-to-bottom as written, then
 * class decorators (`@Plugin`) evaluate. Because `@On`/`@Tool` push into the
 * shared `context.metadata` arrays during member decoration (which completes
 * before the class decorator runs), `@Plugin` reliably sees the fully-
 * populated arrays when it copies them into the per-class
 * {@link PluginMetadata}. We do NOT rely on the relative order of multiple
 * `addInitializer` callbacks across decorators — only on the spec-guaranteed
 * "members decorate before the class", which is sufficient.
 */
export function Plugin(name: string) {
	// biome-ignore lint/suspicious/noConfusingVoidType: TC39 stage-3 class decorators may return a replacement class or void (keep original); this is the spec'd signature.
	return <C extends Class>(target: C, context: ClassDecoratorContext<C>): C | void => {
		if (context.kind !== "class") {
			throw new Error("@Plugin: must be applied to a class")
		}
		const meta = context.metadata as PluginDecoratorMetadata
		const pluginMeta: PluginMetadata = {
			name,
			onHandlers: [...(meta.onHandlers ?? [])],
			tools: [...(meta.tools ?? [])],
		}
		// Stamp on the prototype so every instance inherits it. Non-enumerable
		// so it doesn't show up in `Object.keys(instance)` / spread copies.
		Object.defineProperty(target.prototype, BHZAI_PLUGIN_META, {
			value: pluginMeta,
			writable: false,
			enumerable: false,
			configurable: false,
		})
		// Return nothing — native decorators may return a replacement class;
		// we keep the original `target`.
	}
}

/**
 * Method decorator subscribing the method to a kernel or conversation event
 * (§ 7.2 form 3). At `bh.use()` time, the decorator-generated `setup()`
 * calls `bh.on(event, method.bind(instance))`, so the method runs whenever
 * that event is dispatched — including reserved kernel events like
 * `initialize` (a `@On('initialize')` method fires during `bh.init()` at the
 * same ordering position a capability-object `initialize` hook would, because
 * both become ordinary `bh.on('initialize', ...)` subscriptions).
 */
export function On(event: string) {
	return <This, F extends (this: This, ...args: unknown[]) => unknown>(
		target: F,
		context: ClassMethodDecoratorContext<This, F>,
		// biome-ignore lint/suspicious/noConfusingVoidType: TC39 stage-3 method decorators may return a replacement function or void (keep original); this is the spec'd signature.
	): F | void => {
		if (context.kind !== "method") {
			throw new Error("@On: must be applied to a method")
		}
		const meta = context.metadata as PluginDecoratorMetadata
		ensureOnHandlers(meta).push({ methodName: String(context.name), event })
		// Return nothing — native method decorators may return a replacement
		// function; we keep the original method.
	}
}

/**
 * Method decorator registering the method as a tool (§ 7.2 form 3). At
 * `bh.use()` time, the decorator-generated `setup()` calls
 * `bh.toolRegistrar.register({ name, schema, execute: method.bind(instance) })`
 * against the {@link ToolRegistrar} seam.
 *
 * The decorated method receives the same `ToolInvocation` payload any other
 * tool executor receives (per § 7.2's example). Since `ToolInvocation`'s
 * full type is TASK_0008's to define, the method signature is typed loosely
 * here and narrowed later.
 * // TODO(TASK_0008): narrow to the real `ToolInvocation<P>` type once it lands.
 */
export function Tool(name: string, schema: JSONSchema) {
	return <This, F extends (this: This, ...args: unknown[]) => unknown>(
		target: F,
		context: ClassMethodDecoratorContext<This, F>,
		// biome-ignore lint/suspicious/noConfusingVoidType: TC39 stage-3 method decorators may return a replacement function or void (keep original); this is the spec'd signature.
	): F | void => {
		if (context.kind !== "method") {
			throw new Error("@Tool: must be applied to a method")
		}
		const meta = context.metadata as PluginDecoratorMetadata
		ensureTools(meta).push({ methodName: String(context.name), name, schema })
	}
}

/**
 * Read the {@link PluginMetadata} stamped by `@Plugin` off an instance, or
 * return `undefined` if the instance is not a decorated plugin. Exported for
 * `BHZAI.use()` to detect form-3 instances without re-deriving the symbol key.
 */
export function getPluginMetadata(instance: unknown): PluginMetadata | undefined {
	if (instance && typeof instance === "object" && BHZAI_PLUGIN_META in instance) {
		return (instance as { [BHZAI_PLUGIN_META]: PluginMetadata })[BHZAI_PLUGIN_META]
	}
	return undefined
}
