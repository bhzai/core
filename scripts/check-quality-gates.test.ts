import ts from "typescript"
import { describe, expect, it } from "vitest"
import {
	checkFileLength,
	checkNarration,
	checkSourceFile,
	checkTestImports,
} from "./check-quality-gates.mjs"

describe("checkNarration", () => {
	it("detects TASK_XXXX narration", () => {
		const content = "// Implements TODO(TASK_0027) loop termination"
		const errors = checkNarration("src/kernel/foo.ts", content)
		expect(errors.length).toBe(1)
		expect(errors[0]).toContain("Forbidden TASK_XXXX narration")
	})

	it("detects §-spec narration", () => {
		const content = "// Complies with ARCHITECTURE.md § 7.2"
		const errors = checkNarration("src/kernel/foo.ts", content)
		expect(errors.length).toBe(1)
		expect(errors[0]).toContain("Forbidden §-spec narration")
	})

	it("passes on clean documentation", () => {
		const content = "/** Dispatches an event across subscribers. */"
		const errors = checkNarration("src/kernel/foo.ts", content)
		expect(errors.length).toBe(0)
	})
})

describe("checkFileLength", () => {
	it("fails files exceeding the line limit", () => {
		const content = new Array(505).fill("const x = 1;").join("\n")
		const errors = checkFileLength("src/kernel/long.ts", content, 500)
		expect(errors.length).toBe(1)
		expect(errors[0]).toContain("exceeds maximum allowed of 500 lines")
	})

	it("passes files within the line limit", () => {
		const content = new Array(400).fill("const x = 1;").join("\n")
		const errors = checkFileLength("src/kernel/short.ts", content, 500)
		expect(errors.length).toBe(0)
	})
})

describe("checkTestImports", () => {
	it("fails tests importing _-prefixed symbols", () => {
		const code = `import { _steerQueue, publicFn } from "./kernel";`
		const sf = ts.createSourceFile("src/kernel/foo.test.ts", code, ts.ScriptTarget.ES2022, true)
		const errors = checkTestImports("src/kernel/foo.test.ts", sf)
		expect(errors.length).toBe(1)
		expect(errors[0]).toContain('imports private/internal symbol "_steerQueue"')
	})

	it("fails tests importing private modules", () => {
		const code = `import { helper } from "./_private_helpers";`
		const sf = ts.createSourceFile("src/kernel/foo.test.ts", code, ts.ScriptTarget.ES2022, true)
		const errors = checkTestImports("src/kernel/foo.test.ts", sf)
		expect(errors.length).toBe(1)
		expect(errors[0]).toContain('imports private module "./_private_helpers"')
	})

	it("passes tests importing only public symbols", () => {
		const code = `import { BHZAI, createHarness } from "./kernel";`
		const sf = ts.createSourceFile("src/kernel/foo.test.ts", code, ts.ScriptTarget.ES2022, true)
		const errors = checkTestImports("src/kernel/foo.test.ts", sf)
		expect(errors.length).toBe(0)
	})
})

describe("checkSourceFile", () => {
	it("fails exported symbols missing JSDoc", () => {
		const code = "export function run() { return 1; }"
		const sf = ts.createSourceFile("src/kernel/foo.ts", code, ts.ScriptTarget.ES2022, true)
		const errors = checkSourceFile("src/kernel/foo.ts", sf, false)
		expect(errors.length).toBe(1)
		expect(errors[0]).toContain('Exported symbol "run" is missing required JSDoc')
	})

	it("passes exported symbols with JSDoc", () => {
		const code = `
/**
 * Executes a run cycle.
 */
export function run() { return 1; }
`
		const sf = ts.createSourceFile("src/kernel/foo.ts", code, ts.ScriptTarget.ES2022, true)
		const errors = checkSourceFile("src/kernel/foo.ts", sf, false)
		expect(errors.length).toBe(0)
	})

	it("ignores internal unexported functions missing JSDoc", () => {
		const code = "function helper() { return 1; }"
		const sf = ts.createSourceFile("src/kernel/foo.ts", code, ts.ScriptTarget.ES2022, true)
		const errors = checkSourceFile("src/kernel/foo.ts", sf, false)
		expect(errors.length).toBe(0)
	})

	it("fails functions exceeding the line limit", () => {
		const body = new Array(80).fill("  const a = 1;").join("\n")
		const code = `
/**
 * A large function.
 */
export function large() {
${body}
}
`
		const sf = ts.createSourceFile("src/kernel/foo.ts", code, ts.ScriptTarget.ES2022, true)
		const errors = checkSourceFile("src/kernel/foo.ts", sf, false)
		expect(errors.some((e) => e.includes("exceeds maximum allowed of 75 lines"))).toBe(true)
	})
})
