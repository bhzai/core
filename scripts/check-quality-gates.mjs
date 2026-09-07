#!/usr/bin/env node
import fs from "node:fs"
import path from "node:path"
import ts from "typescript"

const MAX_FILE_LINES = 500
const MAX_FUNCTION_LINES = 75

/**
 * Recursively find all files in a directory matching an optional filter.
 * @param {string} dir
 * @param {(filePath: string) => boolean} filter
 * @returns {string[]}
 */
function walkDir(dir, filter) {
	if (!fs.existsSync(dir)) return []
	const results = []
	const entries = fs.readdirSync(dir, { withFileTypes: true })
	for (const entry of entries) {
		const fullPath = path.join(dir, entry.name)
		if (entry.isDirectory()) {
			results.push(...walkDir(fullPath, filter))
		} else if (!filter || filter(fullPath)) {
			results.push(fullPath)
		}
	}
	return results
}

/**
 * Check if a file contains forbidden TASK_XXXX or §-spec narration.
 * @param {string} filePath
 * @param {string} content
 * @returns {string[]}
 */
export function checkNarration(filePath, content) {
	const errors = []
	const lines = content.split(/\r?\n/)
	const taskRegex = /\bTASK_\d{4}\b/
	const sectionRegex = /§\s*\d+/

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]
		if (taskRegex.test(line)) {
			errors.push(`${filePath}:${i + 1}: Forbidden TASK_XXXX narration found: "${line.trim()}"`)
		}
		if (sectionRegex.test(line)) {
			errors.push(`${filePath}:${i + 1}: Forbidden §-spec narration found: "${line.trim()}"`)
		}
	}
	return errors
}

/**
 * Check file length.
 * @param {string} filePath
 * @param {string} content
 * @param {number} maxLines
 * @returns {string[]}
 */
export function checkFileLength(filePath, content, maxLines = MAX_FILE_LINES) {
	const errors = []
	const lines = content.split(/\r?\n/)
	if (lines.length > maxLines) {
		errors.push(
			`${filePath}: File length of ${lines.length} lines exceeds maximum allowed of ${maxLines} lines`,
		)
	}
	return errors
}

/**
 * Check that test files do not import `_`-prefixed internal symbols.
 * @param {string} filePath
 * @param {ts.SourceFile} sourceFile
 * @returns {string[]}
 */
export function checkTestImports(filePath, sourceFile) {
	const errors = []

	ts.forEachChild(sourceFile, (node) => {
		if (ts.isImportDeclaration(node)) {
			const specifier = node.moduleSpecifier
			if (ts.isStringLiteral(specifier)) {
				const importPath = specifier.text
				const baseName = path.basename(importPath)
				if (baseName.startsWith("_")) {
					const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
					errors.push(
						`${filePath}:${line + 1}: Test imports private module "${importPath}". Tests must measure coverage through public surfaces.`,
					)
				}
			}

			const clause = node.importClause
			if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
				for (const element of clause.namedBindings.elements) {
					const importedName = element.propertyName ? element.propertyName.text : element.name.text
					if (importedName.startsWith("_")) {
						const { line } = sourceFile.getLineAndCharacterOfPosition(element.getStart(sourceFile))
						errors.push(
							`${filePath}:${line + 1}: Test imports private/internal symbol "${importedName}". Tests must measure coverage through public surfaces.`,
						)
					}
				}
			}
		}
	})

	return errors
}

/**
 * Check function size and JSDoc on exported symbols for TypeScript source files.
 * @param {string} filePath
 * @param {ts.SourceFile} sourceFile
 * @param {boolean} isTest
 * @returns {string[]}
 */
export function checkSourceFile(filePath, sourceFile, isTest) {
	const errors = []

	function getLineNumber(pos) {
		return sourceFile.getLineAndCharacterOfPosition(pos).line + 1
	}

	function checkNode(node) {
		// 1. Function size check (non-test files)
		if (!isTest) {
			const isFunction =
				ts.isFunctionDeclaration(node) ||
				ts.isFunctionExpression(node) ||
				ts.isArrowFunction(node) ||
				ts.isMethodDeclaration(node) ||
				ts.isConstructorDeclaration(node) ||
				ts.isGetAccessorDeclaration(node) ||
				ts.isSetAccessorDeclaration(node)

			if (isFunction) {
				const startLine = getLineNumber(node.getStart(sourceFile))
				const endLine = getLineNumber(node.getEnd())
				const lineCount = endLine - startLine + 1
				if (lineCount > MAX_FUNCTION_LINES) {
					let name = "anonymous function"
					if (node.name && ts.isIdentifier(node.name)) {
						name = `function "${node.name.text}"`
					} else if (ts.isMethodDeclaration(node) && node.name) {
						name = `method "${node.name.getText(sourceFile)}"`
					}
					errors.push(
						`${filePath}:${startLine}: ${name} length of ${lineCount} lines exceeds maximum allowed of ${MAX_FUNCTION_LINES} lines`,
					)
				}
			}
		}

		// 2. JSDoc on exported symbols (non-test files)
		if (!isTest && node.parent === sourceFile) {
			const hasExportModifier = (node.modifiers || []).some(
				(m) => m.kind === ts.SyntaxKind.ExportKeyword,
			)

			if (hasExportModifier) {
				const isDeclaration =
					ts.isFunctionDeclaration(node) ||
					ts.isClassDeclaration(node) ||
					ts.isInterfaceDeclaration(node) ||
					ts.isTypeAliasDeclaration(node) ||
					ts.isEnumDeclaration(node) ||
					ts.isVariableStatement(node)

				if (isDeclaration) {
					const jsDoc = ts.getJSDocCommentsAndTags(node)
					if (!jsDoc || jsDoc.length === 0) {
						let symbolDesc = "Exported declaration"
						if (node.name && ts.isIdentifier(node.name)) {
							symbolDesc = `Exported symbol "${node.name.text}"`
						} else if (ts.isVariableStatement(node)) {
							const names = node.declarationList.declarations
								.map((d) => d.name.getText(sourceFile))
								.join(", ")
							symbolDesc = `Exported symbol(s) "${names}"`
						}
						const line = getLineNumber(node.getStart(sourceFile))
						errors.push(
							`${filePath}:${line}: ${symbolDesc} is missing required JSDoc documentation comment`,
						)
					}
				}
			}
		}

		ts.forEachChild(node, checkNode)
	}

	checkNode(sourceFile)
	return errors
}

/**
 * Run all quality gate checks on given files or discovered files.
 * @param {string[]} [targetFiles]
 * @returns {number} exit code (0 for success, 1 for errors)
 */
export function runQualityGates(targetFiles) {
	let filesToCheck = targetFiles
	if (!filesToCheck || filesToCheck.length === 0) {
		const v2Files = walkDir("src/v2", (f) => f.endsWith(".ts"))
		const docFiles = walkDir("docs/v2", (f) => f.endsWith(".md"))
		filesToCheck = [...v2Files, ...docFiles]
	}

	const allErrors = []

	for (const rawFile of filesToCheck) {
		const filePath = path.normalize(rawFile)
		if (!fs.existsSync(filePath)) continue

		const isV2 = filePath.includes("src/v2")
		const isDocsV2 = filePath.includes("docs/v2")
		if (!isV2 && !isDocsV2) continue

		const content = fs.readFileSync(filePath, "utf-8")

		// 1. Narration check applies to both src/v2 and docs/v2
		allErrors.push(...checkNarration(filePath, content))

		if (isV2) {
			// 2. Max file length check
			allErrors.push(...checkFileLength(filePath, content, MAX_FILE_LINES))

			// 3. TypeScript AST checks
			if (filePath.endsWith(".ts")) {
				const sourceFile = ts.createSourceFile(filePath, content, ts.ScriptTarget.ES2022, true)
				const isTest = filePath.endsWith(".test.ts") || filePath.includes("__tests__")

				if (isTest) {
					allErrors.push(...checkTestImports(filePath, sourceFile))
				}
				allErrors.push(...checkSourceFile(filePath, sourceFile, isTest))
			}
		}
	}

	if (allErrors.length > 0) {
		console.error("❌ Quality Gate Violations:")
		for (const err of allErrors) {
			console.error(`  • ${err}`)
		}
		return 1
	}

	console.log(`✅ Quality gates passed (${filesToCheck.length} files checked).`)
	return 0
}

// Direct execution
if (import.meta.url === `file://${process.argv[1]}`) {
	const targets = process.argv.slice(2)
	const code = runQualityGates(targets.length > 0 ? targets : undefined)
	process.exit(code)
}
