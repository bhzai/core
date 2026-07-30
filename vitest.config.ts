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
		// Tests are colocated with source under src/, examples/, and example/ as *.test.ts.
		include: ["src/**/*.test.ts", "examples/**/*.test.ts", "example/**/*.test.ts"],
	},
})
