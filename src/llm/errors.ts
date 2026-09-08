/**
 * Thrown when an LLM call exceeds the maximum context window of the model.
 */
export class ContextOverflowError extends Error {
	/** Underlying error or response payload that indicated context overflow. */
	readonly details?: unknown

	/**
	 * Creates a new ContextOverflowError.
	 * @param message Description of the overflow condition.
	 * @param details Raw driver error or response details.
	 */
	constructor(message: string, details?: unknown) {
		super(message)
		this.name = "ContextOverflowError"
		this.details = details
	}
}

/**
 * Thrown when a bare model ID matches models across multiple drivers.
 */
export class AmbiguousModelError extends Error {
	/** List of qualified model references matching the ambiguous bare ID. */
	readonly alternatives: string[]

	/**
	 * Creates a new AmbiguousModelError.
	 * @param bareId The ambiguous bare model identifier.
	 * @param alternatives Qualified references that matched.
	 */
	constructor(bareId: string, alternatives: string[]) {
		super(
			`Model id "${bareId}" is ambiguous across drivers: ${alternatives.join(", ")}. Use a qualified reference instead.`,
		)
		this.name = "AmbiguousModelError"
		this.alternatives = alternatives
	}
}

/**
 * Thrown when a model reference is not found in the catalogue.
 */
export class ModelNotFoundError extends Error {
	/**
	 * Creates a new ModelNotFoundError.
	 * @param ref The unresolved model reference.
	 */
	constructor(ref: string) {
		super(`Model "${ref}" not found in the catalogue.`)
		this.name = "ModelNotFoundError"
	}
}

/**
 * Thrown when no default or explicit model is configured or resolvable.
 */
export class NoModelError extends Error {
	/**
	 * Creates a new NoModelError.
	 * @param message Optional custom error message.
	 */
	constructor(message = "No model configured or resolved for the request.") {
		super(message)
		this.name = "NoModelError"
	}
}

/**
 * Thrown when a driver identifier referenced in a qualified model ref is not registered.
 */
export class DriverNotFoundError extends Error {
	/**
	 * Creates a new DriverNotFoundError.
	 * @param driverId Identifier of the missing driver.
	 */
	constructor(driverId: string) {
		super(`Driver "${driverId}" is not registered.`)
		this.name = "DriverNotFoundError"
	}
}

const OVERFLOW_PATTERNS = [
	/context_length_exceeded/i,
	/maximum context length/i,
	/context window exceeded/i,
	/prompt is too long/i,
	/token limit exceeded/i,
	/input tokens exceed/i,
	/too many tokens/i,
	/exceeds context length/i,
	/exceeds maximum context/i,
]

function extractBodyStrings(body: unknown): string[] {
	if (!body || typeof body !== "object") {
		return typeof body === "string" ? [body] : []
	}
	const err = (body as { error?: { message?: string; code?: string } }).error
	if (!err) return []
	const res: string[] = []
	if (typeof err.message === "string") res.push(err.message)
	if (typeof err.code === "string") res.push(err.code)
	return res
}

function extractErrorStrings(error: unknown): string[] {
	if (typeof error === "string") return [error]
	if (!error || typeof error !== "object") return []

	const record = error as Record<string, unknown>
	const strings: string[] = []
	if (typeof record.message === "string") strings.push(record.message)
	if (typeof record.code === "string") strings.push(record.code)
	if (record.body) strings.push(...extractBodyStrings(record.body))
	return strings
}

/**
 * Inspects an error object to determine if it represents a context length overflow.
 * @param error The thrown error or rejected response to inspect.
 * @returns True if the error indicates context window exhaustion.
 */
export function isContextOverflowError(error: unknown): boolean {
	if (!error) return false
	if (error instanceof ContextOverflowError) return true

	const strings = extractErrorStrings(error)
	if (strings.includes("context_length_exceeded")) return true
	return strings.some((s) => OVERFLOW_PATTERNS.some((p) => p.test(s)))
}
