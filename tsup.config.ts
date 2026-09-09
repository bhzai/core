// Build config for @bhzai/core.
//
// tsup is used (rather than hand-rolled tsc + a bundler, or heavier tools like
// Rollup/unbuild/tsdown) because it is purpose-built for exactly this package
// shape: multiple subpath entry points, ESM-only output, and automatic `.d.ts`
// generation via a bundled dts step — all with near-zero configuration. If a
// future task hits a tsup limitation (e.g. native-decorator metadata emission),
// that task must document the switch and the reason; do not silently swap tools.
//
// Each entry key maps 1:1 to a `package.json` `exports` subpath:
//   `index`                        -> `.`
//   `core/index`                   -> `./core`
//   `plugins/webllm/index`         -> `./plugins/webllm`
//   `plugins/ollama/index`         -> `./plugins/ollama`
//   `plugins/lmstudio/index`       -> `./plugins/lmstudio`
//   `plugins/openai/index`         -> `./plugins/openai`
//   `plugins/vllm/index`           -> `./plugins/vllm`
//   `plugins/mcp/index`            -> `./plugins/mcp`
//   `plugins/idb-conversations/index` -> `./plugins/idb-conversations`
//   `plugins/interop/pi/index`     -> `./plugins/interop/pi`
//   `plugins/interop/opencode/index` -> `./plugins/interop/opencode`
//
// When adding a subpath, update all three together per packaging rules:
// `package.json` exports, this `entry` map, and the matching `src/**/index.ts`.
import { defineConfig } from "tsup"

export default defineConfig({
	entry: {
		index: "src/index.ts",
		"plugins/webllm/index": "src/plugins/webllm/index.ts",
		"plugins/ollama/index": "src/plugins/ollama/index.ts",
		"plugins/lmstudio/index": "src/plugins/lmstudio/index.ts",
		"plugins/openai/index": "src/plugins/openai/index.ts",
		"plugins/vllm/index": "src/plugins/vllm/index.ts",
		"plugins/mcp/index": "src/plugins/mcp/index.ts",
		"plugins/idb/index": "src/plugins/idb/index.ts",
		"plugins/idb-conversations/index": "src/plugins/idb-conversations/index.ts",
		"plugins/examples/index": "src/plugins/examples/index.ts",
	},
	format: ["esm"],
	dts: true,
	sourcemap: true,
	clean: true,
	splitting: false,
})
