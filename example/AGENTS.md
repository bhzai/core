# `example/` — WebLLM chat browser example

## Purpose & scope

A Lit 3 + TypeScript browser example demonstrating BHAI's core capabilities:
streaming responses, in-browser model execution via WebLLM, live telemetry
(decode/prefill tokens per second, time-to-first-token, context usage),
framework-side parsing of reasoning blocks (`` regions, via
`parseThink: true`), and runtime attachment of HTTP MCP servers with live
connection status, searchable tool discovery, and error inspection.

Consumes the WORKSPACE-LINKED, BUILT `dist/` output of `@lucasschirm/bhai` (via
`workspace:*` dependency + `pnpm run build` running first), never source imports
(`../../src/*.ts`). This ensures the example exercises the real published
subpath exports, the real `.d.ts` output, and tree-shaking behavior.

## Current state

Complete. The browser layer is TypeScript, split into reusable Lit custom
elements (`src/components/`) plus per-feature orchestration (`src/app/`), and a
single model-selection typeahead (`@lucasschirm/litjs-typeahead`).

## Key files

- **`package.json`** — `bhai-example` workspace member. Private. Depends on root
  `@lucasschirm/bhai` via `workspace:*`, `@mlc-ai/web-llm ^0.2.79`,
  `lit ^3.2.0`, and `@lucasschirm/litjs-typeahead ^0.0.1` as production
  dependencies; `@webgpu/types`, `happy-dom`, `typescript`, and `vite` as dev
  dependencies.
- **`tsconfig.json`** — Typechecks the example as its own project (`pnpm --filter
  bhai-example typecheck`, also covered by the root `pnpm typecheck`). Separate
  from the root config because it needs `experimentalDecorators: true` and
  `useDefineForClassFields: false` for Lit decorators and the DOM lib. Resolving
  `@lucasschirm/bhai` through the workspace link requires `pnpm run build` to have
  produced `dist/` first; keeping it separate stops that build dependency from
  leaking into the root typecheck.
- **`vite.config.ts`** — Minimal Vite config with `@mlc-ai/web-llm` pre-bundling
  excluded (MLC does its own wasm/worker loading). Comments explain the
  COOP/COEP header tradeoff.
- **`variables.css`** — The single source of truth for the dark theme's CSS
  variables (colors, typography, spacing). Imported first in `index.html`.
- **`styles.css`** — Layout and component styling; every value is read from
  `variables.css` via `var(--*)`.
- **`index.html`** — Semantic HTML5 structure plus the custom element tags:
  `<bhai-status-indicator>`, `<bhai-model-select id="model-select">`,
  `<bhai-conversation>`, `<bhai-cold-start>`, `<bhai-telemetry>`,
  `<bhai-mcp-add-form>`, `<bhai-mcp-error-dialog>`,
  `<bhai-mcp-server-list>`, and `<bhai-composer>`. Loads `variables.css` and
  `/src/main.ts`.
  - The telemetry rail is split into `#cold-start-host`, `#telemetry-stats`,
    and `<section id="mcp-panel">`. **This split is load-bearing**: the
    telemetry panel replaces `#telemetry-stats`'s children wholesale after every
    turn, so anything that must survive a turn has to live outside it.

### `src/main.ts` — bootstrap

The only file that knows the `index.html` id contract. Importing a component
module registers its custom element, so `main.ts` side-effect imports every
component and then resolves them with `byId()`. It seeds the model picker from
`bh.listModels()`, subscribes to `models.changed` to keep it reactive, and wires
the elements to the two orchestrators.

### `src/app/` — orchestration (no DOM)

- **`webllm-engine.ts`** — WebGPU capability check and `MLCEngine` creation
  with the cold-start progress callback. Exports `prebuiltAppConfig` from
  `@mlc-ai/web-llm` so the WebLLM driver can report a catalogue before the
  engine is warmed.
- **`chat-controller.ts`** — Conversation lifecycle, send/abort, TTFT
  measurement, and the `runtimeStatsText()` → telemetry pipeline. Narrows the
  `message.delta` payload at one boundary, because `ConversationEvents` carries
  an index signature and every payload arrives as `unknown`. Accepts a
  qualified model ref and reads `contextWindow` from the selected catalogue
  entry.
- **`mcp-controller.ts`** — Subscribes the server list to `McpManager`, wires
  the add-server form, persists the server list, and owns the card-level event
  listeners (`bhai-refresh`, `bhai-retry`, `bhai-remove`, `bhai-show-error`).
- **`fatal-error.ts`** — The one path that spans two components (telemetry +
  composer), so it belongs to neither.

### `src/components/` — one Lit custom element per DOM region

Every component is a `LitElement` subclass decorated with `@customElement`,
`@property`, `@state`, and `@query`. They are rendered in the **light DOM**
(`createRenderRoot() { return this }`) so the host page's global styles and
CSS variables continue to drive their appearance.

| Module | Custom element | Owns |
| --- | --- | --- |
| `status-indicator.ts` | `<bhai-status-indicator>` | statusbar dot + label |
| `model-select.ts` | `<bhai-model-select>` | reactive model picker, consumes `bh.listModels()` and `models.changed` |
| `composer.ts` | `<bhai-composer>` | Send/Stop state, text, keyboard |
| `conversation-view.ts` | `<bhai-conversation>` | user bubbles, assistant turns, inline errors |
| `cold-start-panel.ts` | `<bhai-cold-start>` | download gauge |
| `telemetry-panel.ts` | `<bhai-telemetry>` | per-turn readouts |
| `mcp-server-list.ts` | `<bhai-mcp-server-list>` | server cards, reactive filter + sort |
| `mcp-server-card.ts` | `<bhai-mcp-server-card>` | one server card |
| `mcp-tool-list.ts` | `<bhai-mcp-tool-list>` | one server's collapsible, filterable tool list |
| `mcp-add-form.ts` | `<bhai-mcp-add-form>` | add-server form |
| `mcp-error-dialog.ts` | `<bhai-mcp-error-dialog>` | error details dialog |

`conversation-view.ts`'s `beginAssistantTurn()` returns an object whose methods
close over that message's own nodes, rather than a string id the caller has to
look back up on every delta.

### `src/lib/` — pure helpers

- **`dom.ts`** — `el()`, `byId()`, `iconButton()`. `byId()` throws on a missing
  element rather than returning early: components are built once at startup
  against markup that ships in the same commit, so a missing node is a bug worth
  surfacing.
- **`stats.ts`** — `parseRuntimeStats()` → `{ prefillTps, decodeTps }`.
- **`thermal.ts`** — `thermalRatio(decodeTps)` → 0..1, `thermalColor(ratio)` →
  CSS color.
- **`format.ts`** — `formatTps`, `formatTokens`, `formatBytes`, `formatSeconds`.
- **`mcp-store.ts`** — `loadServers()` / `saveServers()` (localStorage, versioned
  payload, injectable backend so persistence is testable in Node),
  `parseHeaderLines()` (one `Key: Value` per line, first-colon split so values
  may contain colons), `validateServerUrl()` (http/https only), `errorHint()`
  (plain-language next step — notably mapping the opaque `TypeError: Failed to
  fetch` to the CORS explanation).

## Model selection

The bare `<select>` was replaced by a reactive `<bhai-model-select>` wrapper that
owns a `<lit-typeahead>` from `@lucasschirm/litjs-typeahead`. `main.ts` seeds
`bhai-model-select.models` from `bh.listModels()`, subscribes to `models.changed`
to refresh the list, and listens for the custom `bhai-change` event
(detail: `{ model: ModelInfo, ref: string }`) to switch conversations. The
default still prefers a Qwen3 model when available.

## MCP filtering and sorting

The server list and per-server tool lists are filtered/sorted **inside Lit**
rather than by an external library. `@state` drives the query, sort key, and
sort direction; `repeat(..., keyFn, ...)` preserves card instances so tool-
list expansion state survives unrelated re-renders. This keeps all DOM under
Lit's control and removes the List.js DOM-mutation conflicts that the prior
implementation had to absorb.

## CSS variables

All colors, typefaces, and key spacing tokens live in `variables.css` and are
imported in `index.html` before `styles.css`. Every component template uses the
same classes it always did (`.message`, `.telemetry-panel`, `.mcp-server`,
etc.), so the global stylesheet controls the look while the components control
the structure and behavior.

## Running the example

```bash
# From repo root:
pnpm install
pnpm run preview       # builds @lucasschirm/bhai, then starts Vite

# Or, iterative dev (rebuild the lib as you go):
pnpm run build
pnpm --filter bhai-example dev
```

Requirements:

- WebGPU-capable browser (Chrome/Edge 113+).
- Modern JavaScript (ES2022, custom elements, async/await, dynamic import).

## Consumers / Testing

- **Unit tests** (`pnpm test` from the root, `example/**/*.test.ts` is in the
  vitest `include`):
  - `src/lib/{format,stats,thermal,mcp-store}.test.ts` — pure functions, default
    `node` environment.
  - `src/components/conversation-view.test.ts` — delta routing, lazy Thought
    disclosure, independent concurrent turns.
  - `src/components/mcp-server-card.test.ts` — **the untrusted-text regression
    guard**: an `<img src=x onerror=…>` payload in the server name, tool names,
    and error message must land as text, with zero `img` elements produced.
  - `src/components/mcp-server-list.test.ts` — empty vs no-matches states,
    filtering by name and by indexed tool name, sorting by name/status with
    direction toggle, and expansion surviving an unrelated re-render.
- **DOM environment**: tests that touch the DOM carry `// @vitest-environment
  happy-dom` at the top of the file. The root `vitest.config.ts` stays
  `environment: "node"` by default.
- **Not unit-tested**: `main.ts`, `app/*`, and the thin components
  (`status-indicator`, `composer`, `cold-start-panel`, `telemetry-panel`,
  `mcp-add-form`, `mcp-error-dialog`). These are glue over APIs that are
  themselves tested; they are covered by the smoke run.
- **Smoke test**: `pnpm run preview` in a WebGPU browser — verify the
  typeahead populates, a message streams with its Thought region, telemetry
  fills in, and Stop then re-send works.
- **Smoke-testing the MCP panel** needs a reachable HTTP MCP server. Any local
  streamable-HTTP server with permissive CORS works; failing that, a throwaway
  Node script answering `initialize`, `notifications/initialized`, and
  `tools/list` is enough to exercise connect → tools → filter → sort → refresh
  → remove. For the error path, point at a port with nothing listening and open
  the error details. Note the WebGPU guard in `main.ts` returns before the MCP
  wiring runs, so a headless browser needs `navigator.gpu` stubbed to reach the
  panel at all.

## Conventions

- **Pure lib vs components vs orchestration**: `src/lib/*` are DOM-free pure
  functions except `dom.ts`, which is a DOM utility with no app knowledge.
  `src/components/*` own DOM and nothing else. `src/app/*` own kernel/engine
  calls and no DOM. `main.ts` is the only file that knows element ids.
- **Lit with light DOM**: every custom element renders into itself so the page's
  global CSS variables and selectors keep working. This is a deliberate trade-off
  — style encapsulation is sacrificed for the much simpler migration from the
  previous vanilla-JS components and for the CSS-variable requirement.
- **TypeScript throughout the example.** The demo's whole point is a typed
  kernel, so it consumes the public API the way a typed consumer would —
  including the places where that is uncomfortable (the `unknown` event payload,
  the engine's overload-set mismatch), both of which are narrowed once with a
  comment rather than papered over globally.
- **Relative imports carry an explicit `.js` extension** even from `.ts` files,
  matching the root package. TS (`moduleResolution: "Bundler"`), Vite, and
  Vitest all resolve these to the sibling `.ts` source.
- **Never assign `innerHTML`.** Every node in the example is built with
  `createElement` + `textContent` or Lit `html` bindings, which escape untrusted
  text. The MCP renderers are the security-critical case, but the rule holds
  everywhere so there is no exception to remember.
- **One-shot model load per model selection**: selecting a different model
  creates a fresh conversation rather than switching mid-conversation. Simplest
  correct behavior.
- **Thermal telemetry is data-driven**: the decode-gauge fill color and width
  come from live `engine.runtimeStatsText()` extraction each turn, not
  hardcoded.
- **MCP UI is a pure reflection of `McpManager` state**: `mcp-controller.ts`
  subscribes once and re-renders the whole list on every transition. Nothing
  about a server is tracked separately, including the persisted list (derived
  from `manager.list()` on write, so storage cannot drift from the screen).
- **MCP credentials are stored in plaintext**: `saveServers()` persists request
  headers, `Authorization` included, to `localStorage` so reconnect is one
  click. Acceptable for a local demo and called out in the form's UI; a
  production host should re-prompt instead.
- **No push updates for MCP tool lists**: the client holds no SSE stream, so
  `notifications/tools/list_changed` never arrives. Each connected server card
  carries a manual refresh (⟳) button that calls `McpManager.refresh()` →
  `pollToolsList()`.

## Rules

- **Workspace-linked package only**: never import from `../../src/core/*.ts` or
  `../../src/plugins/*/*.ts`. Always import from `@lucasschirm/bhai` subpaths.
- **Biome linting applies** (`pnpm exec biome check example/`).
- **No persistent state in `app/*`**: all conversation/model state lives in
  `bhai`/`conversation` instances; the UI is a pure reflection of that state
  (or in-flight changes).
- **A new DOM region means a new component**, not a new export on an existing
  one. The old `ui.js` grew to 21 exports across six unrelated regions; that is
  the failure mode this layout exists to prevent.
- **Always log captured exceptions to the console**, make them nice for the user, 
  but don't hide them for developers.
