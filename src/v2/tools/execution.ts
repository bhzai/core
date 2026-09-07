import Ajv, { type ValidateFunction } from "ajv"
import type { CallToolResult, JSONSchema } from "../../types/content"
import type { EventBus } from "../kernel/types"
import type { ToolRegistry } from "./registry"
import type {
	ToolExecuteCall,
	ToolExecuteResult,
	ToolPostExecuteContext,
	ToolPreExecuteContext,
	ToolPreExecutePayload,
} from "./types"

const ajv = new Ajv({ allErrors: true, strict: false })
const schemaValidatorCache = new WeakMap<object, ValidateFunction>()

/**
 * Normalizes any tool executor return value into a standard CallToolResult.
 * @param result Raw executor result (CallToolResult, string, null, or undefined).
 */
export function normalizeToolResult(result: ToolExecuteResult): CallToolResult {
	if (typeof result === "string") {
		return { content: [{ type: "text", text: result }] }
	}
	if (result === undefined || result === null) {
		return { content: [] }
	}
	if (
		typeof result === "object" &&
		"content" in result &&
		Array.isArray((result as { content: unknown }).content)
	) {
		return result as CallToolResult
	}
	return { content: [{ type: "text", text: String(result) }] }
}

/**
 * Parses raw JSON string arguments into an object record.
 * @param toolName Target tool name.
 * @param rawJson JSON string to parse.
 */
export function parseJsonArguments(
	toolName: string,
	rawJson: string,
): { params?: Record<string, unknown>; error?: string } {
	try {
		const parsed = JSON.parse(rawJson)
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
			const typeDesc = Array.isArray(parsed) ? "array" : typeof parsed
			return {
				error: `Invalid arguments for tool "${toolName}": expected JSON object, got ${typeDesc}.`,
			}
		}
		return { params: parsed as Record<string, unknown> }
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err)
		return {
			error: `Invalid JSON arguments for tool "${toolName}": ${message}.`,
		}
	}
}

/**
 * Parses tool input arguments from a string or object into an argument record.
 * @param toolName Target tool name.
 * @param rawArguments Input arguments parameter.
 */
export function parseToolArguments(
	toolName: string,
	rawArguments: unknown,
): { params?: Record<string, unknown>; error?: string } {
	if (typeof rawArguments === "string") {
		return parseJsonArguments(toolName, rawArguments)
	}

	if (typeof rawArguments === "object" && rawArguments !== null && !Array.isArray(rawArguments)) {
		return { params: { ...(rawArguments as Record<string, unknown>) } }
	}

	if (rawArguments === undefined || rawArguments === null) {
		return { params: {} }
	}

	return {
		error: `Invalid arguments type for tool "${toolName}": expected object, got ${typeof rawArguments}.`,
	}
}

/**
 * Validates tool arguments against the provided JSON schema.
 * @param schema JSON schema definition.
 * @param params Tool arguments to validate.
 */
export function validateToolParams(
	schema: JSONSchema | undefined,
	params: unknown,
): string | undefined {
	if (!schema || typeof schema !== "object") {
		return undefined
	}

	let validate = schemaValidatorCache.get(schema)
	if (!validate) {
		validate = ajv.compile(schema)
		schemaValidatorCache.set(schema, validate)
	}

	if (!validate(params)) {
		return (validate.errors || [])
			.map((err) => `${err.instancePath || "/"} ${err.message || "validation failed"}`)
			.join("; ")
	}

	return undefined
}

/**
 * Executes a function while racing against an abort signal.
 * @param fn Function to execute.
 * @param signal Optional abort signal.
 */
export async function runWithAbort<T>(fn: () => Promise<T> | T, signal?: AbortSignal): Promise<T> {
	if (!signal) {
		return await fn()
	}

	if (signal.aborted) {
		throw new Error("Tool execution aborted.")
	}

	return await new Promise<T>((resolve, reject) => {
		const onAbort = () => {
			signal.removeEventListener("abort", onAbort)
			reject(new Error("Tool execution aborted."))
		}

		signal.addEventListener("abort", onAbort)

		Promise.resolve(fn()).then(
			(res) => {
				signal.removeEventListener("abort", onAbort)
				resolve(res)
			},
			(err) => {
				signal.removeEventListener("abort", onAbort)
				reject(err)
			},
		)
	})
}

/**
 * Resolves tool, runs pre-execute waterfall, and validates parameters.
 * @param registry Tool registry.
 * @param events Unified event bus.
 * @param call Tool execution parameters.
 * @param parsedParams Parsed arguments record.
 */
export async function prepareToolExecution(
	registry: ToolRegistry,
	events: EventBus,
	call: ToolExecuteCall,
	parsedParams: Record<string, unknown>,
): Promise<{
	tool?: ToolRegistry extends { get(name: string): infer T } ? T : never
	params?: Record<string, unknown>
	errorResult?: CallToolResult
}> {
	const tool = registry.get(call.toolName)
	if (!tool) {
		return {
			errorResult: {
				content: [{ type: "text", text: `Tool "${call.toolName}" not found.` }],
				isError: true,
			},
		}
	}

	const prePayload: ToolPreExecutePayload = {
		callId: call.callId,
		toolName: call.toolName,
		params: parsedParams,
	}
	const preContext: ToolPreExecuteContext = {
		callId: call.callId,
		toolName: call.toolName,
		sessionId: call.sessionId,
	}

	const preResult = await events.runWaterfall("tool/pre-execute", prePayload, preContext)
	if (preResult.block) {
		return {
			errorResult: {
				content: [{ type: "text", text: preResult.reason || "Tool execution blocked." }],
				isError: true,
			},
		}
	}

	const effectiveParams = preResult.params ?? parsedParams
	const validationError = validateToolParams(tool.inputSchema, effectiveParams)
	if (validationError) {
		return {
			errorResult: {
				content: [
					{
						type: "text",
						text: `Schema validation failed for tool "${tool.name}": ${validationError}`,
					},
				],
				isError: true,
			},
		}
	}

	return { tool, params: effectiveParams }
}

/**
 * Executes a tool invocation through argument parsing, pre-execute waterfall,
 * JSON schema validation, execution with abort signal racing, and post-execute waterfall.
 *
 * @param registry Tool registry containing available tools.
 * @param events Unified event bus.
 * @param call Tool execution parameters.
 * @returns Final CallToolResult.
 */
export async function executeTool(
	registry: ToolRegistry,
	events: EventBus,
	call: ToolExecuteCall,
): Promise<CallToolResult> {
	const parsed = parseToolArguments(call.toolName, call.arguments)
	if (parsed.error) {
		return { content: [{ type: "text", text: parsed.error }], isError: true }
	}

	const prep = await prepareToolExecution(registry, events, call, parsed.params ?? {})
	if (prep.errorResult || !prep.tool || !prep.params) {
		return (
			prep.errorResult ?? {
				content: [{ type: "text", text: "Tool preparation failed." }],
				isError: true,
			}
		)
	}

	const { tool, params: effectiveParams } = prep
	let rawResult: ToolExecuteResult
	try {
		rawResult = await runWithAbort(
			() =>
				tool.execute({
					callId: call.callId,
					toolName: call.toolName,
					params: effectiveParams,
					signal: call.signal,
					sessionId: call.sessionId,
					progress: call.progress,
				}),
			call.signal,
		)
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err)
		const text = message === "Tool execution aborted." ? message : `Tool error: ${message}`
		return {
			content: [{ type: "text", text }],
			isError: true,
		}
	}

	const postPayload = normalizeToolResult(rawResult)
	const postContext: ToolPostExecuteContext = {
		callId: call.callId,
		toolName: call.toolName,
		sessionId: call.sessionId,
		params: effectiveParams,
	}

	const postResult = await events.runWaterfall("tool/post-execute", postPayload, postContext)
	return normalizeToolResult(postResult)
}
