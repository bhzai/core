import { fileURLToPath } from "node:url"
import { defineConfig } from "vitest/config"

export default defineConfig({
	resolve: {
		// Examples import the package by its published name, as a consumer would.
		// Resolve those specifiers to src/ so tests never require a prior build
		// (CI runs `pnpm test` without `pnpm build`, so dist/ does not exist there).
		// Order matters: more specific subpath patterns must come first.
		alias: [
			{
				find: /^@bhzai\/core\/plugins\/(.*)$/,
				replacement: fileURLToPath(new URL("./src/plugins/$1/index.ts", import.meta.url)),
			},
			{
				find: /^@bhzai\/core\/core$/,
				replacement: fileURLToPath(new URL("./src/core/index.ts", import.meta.url)),
			},
			{
				find: /^@bhzai\/core$/,
				replacement: fileURLToPath(new URL("./src/index.ts", import.meta.url)),
			},
		],
	},
	test: {
		// Kernel-level tests need no DOM. Driver/plugin tests that require browser
		// globals are that driver's task's concern and override `environment` locally.
		environment: "node",
		// Tests are colocated with source under src/, examples/, example/, and scripts/ as *.test.ts.
		include: [
			"src/**/*.test.ts",
			"examples/**/*.test.ts",
			"example/**/*.test.ts",
			"scripts/**/*.test.ts",
		],
		coverage: {
			provider: "v8",
			reporter: ["text", "json-summary", "html"],
			include: ["src/v2/**/*.ts"],
			exclude: [
				"src/v2/**/*.test.ts",
				"src/v2/**/index.ts",
				"src/v2/**/types.ts",
				"src/v2/**/types/**",
			],
			thresholds: {
				lines: 80,
				branches: 80,
				functions: 80,
				statements: 80,
				"src/v2/kernel/**": {
					lines: 90,
					branches: 90,
					functions: 90,
					statements: 90,
				},
				"src/v2/loop/**": {
					lines: 90,
					branches: 90,
					functions: 90,
					statements: 90,
				},
			},
		},
	},
})
