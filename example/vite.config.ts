import { defineConfig } from "vite"

/**
 * Vite config for the bhzai WebLLM example.
 *
 * This example consumes the workspace-linked `@bhzai/core` package's BUILT
 * `dist/` output (imported by its published subpath names, e.g.
 * `@bhzai/core`, `@bhzai/core/plugins/webllm` — never `../../src/*.ts`).
 * That's why the root `pnpm run preview` script runs `pnpm run build` first.
 *
 * @mlc-ai/web-llm's internal worker/wasm handling can cause dev-server
 * pre-bundling issues, so we exclude it from Vite's default esbuild
 * pre-bundling. MLC's engine does its own dynamic wasm/worker loading that
 * Vite's default esbuild pre-bundling can mishandle.
 *
 * Note: Cross-Origin-Opener-Policy (COOP) and Cross-Origin-Embedder-Policy
 * (COEP) headers are sometimes required for SharedArrayBuffer-based
 * WebGPU/WASM setups, but they are INTENTIONALLY LEFT OFF here by default
 * (would require `server.headers` config). The standard @mlc-ai/web-llm
 * WebGPU path does not require them for basic operation — this is a
 * tradeoff between simplicity and advanced features like SAB-based
 * threading. If you need SAB support, add:
 *
 *   server: {
 *     headers: {
 *       "Cross-Origin-Opener-Policy": "same-origin",
 *       "Cross-Origin-Embedder-Policy": "require-corp",
 *     },
 *   },
 */
export default defineConfig({
	// GitHub Pages serves project pages under /<repo>/, not /. The repo is
	// bhzai/core, so the site lives at https://bhzai.github.io/core/ and assets
	// must resolve under /core/ — NOT /bhzai/ (the org name), which 404'd every
	// JS and CSS file. Local dev and `pnpm run preview` leave GITHUB_PAGES unset
	// and keep serving from /.
	base: process.env.GITHUB_PAGES ? "/core/" : "/",
	optimizeDeps: {
		exclude: ["@mlc-ai/web-llm"],
	},
})
