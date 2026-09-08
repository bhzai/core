import Ajv from "ajv"
import { InvalidPluginConfigError } from "./errors"

const ajv = new Ajv({ allErrors: true, strict: false })

/**
 * Validates a plugin configuration object against its JSON-Schema definition.
 * @param pluginName Name of the plugin being validated.
 * @param schema The JSON-Schema specification, if any.
 * @param config The user-supplied configuration object.
 * @throws {InvalidPluginConfigError} When the configuration does not satisfy the schema.
 */
export function validatePluginConfig(
	pluginName: string,
	schema: Record<string, unknown> | undefined,
	config: unknown,
): void {
	if (!schema) {
		return
	}

	const validate = ajv.compile(schema)
	const valid = validate(config ?? {})

	if (!valid) {
		const errorDetails = (validate.errors || []).map((err) => {
			const path = err.instancePath ? err.instancePath : "/"
			return `${path} ${err.message ?? "validation failed"}`
		})
		throw new InvalidPluginConfigError(pluginName, errorDetails)
	}
}
