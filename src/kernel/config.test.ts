import { describe, expect, it } from "vitest"
import { validatePluginConfig } from "./config"
import { InvalidPluginConfigError } from "./errors"

describe("validatePluginConfig", () => {
	it("succeeds when no schema is specified", () => {
		expect(() => validatePluginConfig("test-plugin", undefined, { foo: "bar" })).not.toThrow()
	})

	it("succeeds when configuration satisfies schema", () => {
		const schema = {
			type: "object",
			properties: {
				apiKey: { type: "string" },
				timeoutMs: { type: "number", minimum: 100 },
			},
			required: ["apiKey"],
			additionalProperties: false,
		}

		expect(() =>
			validatePluginConfig("test-plugin", schema, {
				apiKey: "secret-key",
				timeoutMs: 500,
			}),
		).not.toThrow()
	})

	it("throws InvalidPluginConfigError when required field is missing", () => {
		const schema = {
			type: "object",
			properties: {
				endpoint: { type: "string" },
			},
			required: ["endpoint"],
		}

		expect(() => validatePluginConfig("http-plugin", schema, {})).toThrow(InvalidPluginConfigError)
	})

	it("throws InvalidPluginConfigError with detailed message on type mismatch", () => {
		const schema = {
			type: "object",
			properties: {
				retries: { type: "integer" },
			},
		}

		try {
			validatePluginConfig("retry-plugin", schema, { retries: "three" })
			expect.unreachable("should have thrown")
		} catch (err: unknown) {
			expect(err).toBeInstanceOf(InvalidPluginConfigError)
			const configErr = err as InvalidPluginConfigError
			expect(configErr.pluginName).toBe("retry-plugin")
			expect(configErr.validationErrors.length).toBeGreaterThan(0)
			expect(configErr.validationErrors[0]).toContain("must be integer")
		}
	})
})
