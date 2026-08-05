# `example/` — WebLLM chat browser example

## Purpose & scope

A Lit 3 + TypeScript browser example demonstrating bhzai's core capabilities:
streaming responses, in-browser model execution via WebLLM, runtime attachment
of HTTP providers (Ollama, LM Studio, vLLM and OpenAI) through the providers panel, live
telemetry (decode/prefill tokens per second, time-to-first-token, context
usage), framework-side parsing of reasoning blocks (`` regions, via
`parseThink: true`), runtime attachment of HTTP MCP servers with live
connection status, searchable tool discovery, and error inspection, and
durable conversation persistence via the IndexedDB conversation-store plugin
with a sidebar for browsing, loading, and deleting past conversations.

Consumes the WORKSPACE-LINKED, BUILT `dist/` output of `@bhzai/core` (via
`workspace:*` dependency + `pnpm run build` running first), never source imports
(`../../src/*.ts`). This ensures the example exercises the real published
subpath exports, the real `.d.ts` output, and tree-shaking behavior.

## Current state

Complete. The browser layer is TypeScript, split into reusable Lit custom
elements (`src/components/`) plus per-feature orchestration (`src/app/`), and a
single model-selection typeahead (`@lucasschirm/litjs-typeahead`).

## Key files

- **`package.json`** — `bhzai-example` workspace member. Private. Depends on root
  `@bhzai/core` via `workspace:*`, `@mlc-ai/web-llm ^0.2.79`,
  `lit ^3.2.0`, and `@lucasschirm/litjs-typeahead ^0.0.1` as production
  dependencies; `@webgpu/types`, `happy-dom`, `typescript`, and `vite` as dev
  dependencies.
- **`tsconfig.json`** — Typechecks the example as its own project (`pnpm --filter
  bhzai-example typecheck`, also covered by the root `pnpm typecheck`). Separate
  from the root config because it needs `experimentalDecorators: true` and
  `useDefineForClassFields: false` for Lit decorators and the DOM lib. Resolving
  `@bhzai/core` through the workspace link requires `pnpm run build` to have
  produced `dist/` first; keeping it separate stops that build dependency from
  leaking into the root typecheck.
- **`vite.config.ts`** — Minimal Vite config with `@mlc-ai/web-llm` pre-bundling
  excluded (MLC does its own wasm/worker loading). Comments explain the
  COOP/COEP header tradeoff. Also sets the GitHub Pages `base` path: when
  `GITHUB_PAGES` is set the base is `/core/`, matching the repo name in
  `bhzai/core` (the site is served at https://bhzai.github.io/core/). It is NOT
  the org name `bhzai` — that mismatch previously 404'd every JS and CSS file.
  Local dev and `preview` leave `GITHUB_PAGES` unset and serve from `/`.
- **`variables.css`** — The single source of truth for the dark theme's CSS
  variables (colors, typography, spacing). Imported first in `index.html`.
- **`styles.css`** — Layout and component styling; every value is read from
  `variables.css` via `var(--*)`.
- **`index.html`** — Semantic HTML5 structure plus the custom element tags:
  `<bhzai-status-indicator>`, `<bhzai-model-select id="model-select">`,
  `<bhzai-conversation-list id="conversation-list">` (left sidebar),
  `<bhzai-conversation>`, `<bhzai-cold-start>`, `<bhzai-telemetry>`,
  `<bhzai-mcp-add-form>`, `<bhzai-mcp-error-dialog>`,
  `<bhzai-mcp-server-list>`, and `<bhzai-composer>`. Loads `variables.css` and
  `/src/main.ts`. The layout is a 3-column grid on desktop (conversation
  sidebar + conversation + telemetry rail), collapsing to a single column on
  mobile.
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
  listeners (`bhzai-refresh`, `bhzai-retry`, `bhzai-remove`, `bhzai-show-error`).
- **`provider-controller.ts`** — Owns the lifecycle of the added local HTTP
  drivers (`Ollama`, `LMStudio`): wires the providers dialog's add/update/remove
  events, probes each connection with `listModels()` BEFORE calling
  `bh.addDriver`, persists the list, and refreshes the model picker via
  `onProvidersChanged`. Written against a structural `ProviderDriver` type
  rather than a `Ollama | LMStudio` union, so adding a kind is one line in
  `createDriver()`. Two documented limits: `bh.addDriver` shadows by
  `driver.id`, so only the last-added provider **of each kind** contributes
  models; and the kernel has no `removeDriver`, so removal disconnects our
  reference without unregistering the kernel's entry.
- **`fatal-error.ts`** — The one path that spans two components (telemetry +
  composer), so it belongs to neither.
- **`conversations-controller.ts`** — Orchestrates the conversation sidebar:
  subscribes to `idb-conversations.*` plugin events (load.success/error,
  conversation.deleted) and kernel events (conversation.created/loaded,
  conversation.message(sent)) to keep `<bhzai-conversation-list>` in sync.
  Wires the sidebar's New/Load/Delete/Load-more button events to
  `bh.conversations` and `chat-controller`. Never touches IndexedDB directly
  — all persistence goes through the kernel accessor and the plugin's events.

### `src/components/` — one Lit custom element per DOM region

Every component is a `LitElement` subclass decorated with `@customElement`,
`@property`, `@state`, and `@query`. They are rendered in the **light DOM**
(`createRenderRoot() { return this }`) so the host page's global styles and
CSS variables continue to drive their appearance.

| Module | Custom element | Owns |
| --- | --- | --- |
| `status-indicator.ts` | `<bhzai-status-indicator>` | statusbar dot + label |
| `provider-select.ts` | `<bhzai-provider-select>` | provider filter, to the left of the model picker; hidden unless more than one driver contributes models |
| `model-select.ts` | `<bhzai-model-select>` | reactive model picker, consumes `bh.listModels()` and `models.changed` |
| `composer.ts` | `<bhzai-composer>` | Send/Stop state, text, keyboard |
| `conversation-view.ts` | `<bhzai-conversation>` | user bubbles, assistant turns, inline errors |
| `conversation-list.ts` | `<bhzai-conversation-list>` | left-rail sidebar: past conversations, New/Load/Delete buttons, Load more |
| `cold-start-panel.ts` | `<bhzai-cold-start>` | download gauge |
| `telemetry-panel.ts` | `<bhzai-telemetry>` | per-turn readouts |
| `mcp-server-list.ts` | `<bhzai-mcp-server-list>` | server cards, reactive filter + sort |
| `mcp-server-card.ts` | `<bhzai-mcp-server-card>` | one server card |
| `mcp-tool-list.ts` | `<bhzai-mcp-tool-list>` | one server's collapsible, filterable tool list |
| `mcp-add-form.ts` | `<bhzai-mcp-add-form>` | add-server form |
| `mcp-error-dialog.ts` | `<bhzai-mcp-error-dialog>` | error details dialog |
| `provider-cog.ts` | `<bhzai-provider-cog>` | statusbar button that opens the providers dialog |
| `providers-dialog.ts` | `<bhzai-providers-dialog>` | providers list / add / edit views |

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
- **`format.ts`** — `formatTps`, `formatTokens`, `formatBytes`, `formatSeconds`,
  `formatRelativeTime` (used by the conversation sidebar for "2m", "3h", etc.).
- **`models.ts`** — `selectableModels()`: two narrow drops, both keyed on an
  **explicit** `meta` field. (1) `meta.state === 'not-loaded'` (LM Studio's
  downloaded-but-idle models), so the picker lists only warm models. (2) a
  `meta.type` that is not conversational (`chat`/`llm`/`vlm`) — OpenAI's
  `/v1/models` returns its whole multi-modal catalogue, so without this the
  picker fills with `dall-e-3` and `whisper-1`. Entries carrying neither field —
  every WebLLM and Ollama model — pass through. **Do not "simplify" either to a
  filter on `availability`**: the WebLLM driver reports `'downloadable'` for
  its entire catalogue, so that would empty the picker.
- **`provider-store.ts`** — `loadProviders()` / `saveProviders()` (localStorage
  key `bhzai.providers`, schema v2, injectable backend), the `ProviderKind`
  union and its `PROVIDER_KINDS` / `PROVIDER_LABELS` / `DEFAULT_PROVIDER_API`
  tables, `providerLabel()` / `providerKindFromLabel()` (the add form's
  typeahead shows display labels, not slugs), `normalizeBaseUrl()` (strips a
  trailing `/api/v0`, `/v1`, or `/api` so drivers get the server ROOT — `/v1`
  covers both LM Studio's compat surface and OpenAI's canonical address), and
  `validateApiUrl(url, kind)` (http/https only, messages named per provider).
  ⚠️ The persisted token is stored in plaintext; for an `openai` provider that
  is a real, billable API key, so use a throwaway spend-limited project key.
- **`mcp-store.ts`** — `loadServers()` / `saveServers()` (localStorage, versioned
  payload, injectable backend so persistence is testable in Node),
  `parseHeaderLines()` (one `Key: Value` per line, first-colon split so values
  may contain colons), `validateServerUrl()` (http/https only), `errorHint()`
  (plain-language next step — notably mapping the opaque `TypeError: Failed to
  fetch` to the CORS explanation).
- **`selection-store.ts`** — `loadSelection()` / `saveSelection()` (localStorage
  key `bhzai.selection`, schema v1, injectable backend), mirroring
  `provider-store.ts`'s shape. Persists `{ provider, modelId }` so the provider
  filter and model picker restore on the next visit.

## Model selection

The bare `<select>` was replaced by a reactive `<bhzai-model-select>` wrapper that
owns a `<lit-typeahead>` from `@lucasschirm/litjs-typeahead`. `main.ts` seeds
`bhzai-model-select.models` from `bh.listModels()` passed through
`selectableModels()` (see `lib/models.ts` — LM Studio's idle models are hidden),
subscribes to `models.changed`
to refresh the list, and listens for the custom `bhzai-change` event
(detail: `{ model: ModelInfo, ref: string }`) to switch conversations. The
default still prefers a Qwen3 model when available.

## Provider filter

`<bhzai-provider-select>` sits immediately to the left of `<bhzai-model-select>`
in `.center-container`, built the same way — a thin `LitElement` wrapper around
its own `<lit-typeahead>` — so it fires the same shape of custom event
(`bhzai-change`, detail `{ provider: string }` — a `ModelInfo.driver` id, or
`"all"`) rather than sharing a single generic element with the model picker.

It is a pure filter over the driver ids already present in the merged
catalogue, not a second source of provider truth: `main.ts`'s `refreshPicker()`
derives `providers` as `[...new Set(catalogue.map(m => m.driver))]` on every
`models.changed` refresh, and sets `hidden` whenever that set has one or fewer
entries — the element ships `hidden` in `index.html` so there is no flash
before the first refresh decides. `"All"` (`ALL_PROVIDERS` from
`provider-select.ts`) is always the first item and the default.

Selecting a provider narrows `bhzai-model-select.models` to that driver's
entries via `main.ts`'s `filterByProvider()`. If the currently active model
falls outside the new filter, `main.ts` picks a fresh default within it (same
Qwen3-first heuristic as initial load) and switches the conversation; if it is
still in the filtered list, the conversation is left untouched — narrowing the
list is not itself a reason to reload a working conversation.

Both the provider and the model choice are persisted via
`selection-store.ts` (`bhzai.selection`) on every `bhzai-change` from either
picker, and restored on the next visit. Restoration prefers an exact saved
model id from the full catalogue over the Qwen3 heuristic — the saved
provider's driver may not have finished reconnecting yet at that point in
`main.ts`'s startup sequence, so the fallback chain tries the current filter's
heuristic next and finally the whole catalogue's, guaranteeing a bootstrap
model is always found. If the resolved default ends up outside the saved
filter, the filter is dropped back to `"all"` rather than leave the picker
showing a selection that matches nothing in its own list.

## Providers panel

The cog next to the model picker opens `<bhzai-providers-dialog>`. It lists the
always-on **WebLLM (built-in)** row plus every provider the user has added, each
badged with its kind. Three kinds are addable, all plain-`fetch` drivers:

| Kind | Driver | Default address |
| --- | --- | --- |
| `ollama` | `Ollama` from `@bhzai/core/plugins/ollama` | `http://localhost:11434/api` |
| `lmstudio` | `LMStudio` from `@bhzai/core/plugins/lmstudio` | `http://localhost:1234` |
| `vllm` | `VLLM` from `@bhzai/core/plugins/vllm` | `http://localhost:8000/v1` |
| `openai` | `OpenAI` from `@bhzai/core/plugins/openai` | `https://api.openai.com/v1` |

The first three are self-hosted servers; `openai` is the hosted platform and is the only
kind whose **API token is required** — the form's token field is labelled
optional because the local kinds do not need one, but api.openai.com 401s
without it, so an OpenAI row added without a key shows red.

The add form's Type field is a `<lit-typeahead>` showing display labels
("Ollama", "LM Studio", "vLLM", "OpenAI"), mapped back to kind slugs by
`providerKindFromLabel()`.
Because the typeahead is a native `<input list>` + `<datalist>`, the browser
filters suggestions by the input's current value — pre-filled with "Ollama", the
dropdown lists only Ollama until the field is cleared. That is the intended
typeahead interaction: **clear the field to see every kind.**

Changing the type re-labels the address field and its placeholder, so an LM
Studio entry never ships with an Ollama default. The
entered address is normalized to the server ROOT before it reaches the driver
(`normalizeBaseUrl` strips a trailing `/api/v0`, `/v1`, or `/api`), because every
driver appends its own API path.

**A green row means the model-list endpoint answered — not that the token is
valid.** Some gateways serve their catalogue publicly (OpenRouter's
`/api/v1/models` returns 337 models with no key at all), so the probe succeeds
with a bad token and the first 401 lands on the first message instead. The edit
view's status line reports the same probe result, with the same caveat.

**The `'connect'` handler must not refresh the picker.** Drivers dispatch
`'connect'` from inside `listModels()`, and the picker refresh calls
`bh.listModels()`, which polls every driver — so refreshing from that handler
feeds back into another `'connect'`. `connectEntry()` refreshes after
`listModels()` has settled instead. The kernel now caps the damage (concurrent
`listModels()` callers join the in-flight poll), but the edge was also redundant:
`bh.addDriver()` dispatches `models.changed` on its own.

**Adding another kind** touches four places: `PROVIDER_KINDS` /
`PROVIDER_LABELS` / `DEFAULT_PROVIDER_API` in `provider-store.ts`, and the
`switch` in `provider-controller.ts`'s `createDriver()`. The dialog and the
controller are otherwise kind-agnostic.

The three self-hosted providers need CORS permitted on the server side to be
reachable from the browser (`OLLAMA_ORIGINS` for Ollama; the CORS toggle in LM
Studio's Developer settings; `--allowed-origins '["http://localhost:5173"]'` for
vLLM, which sends no CORS headers at all by default). Without it the probe fails
with the same opaque
`TypeError: Failed to fetch` the MCP panel maps to a CORS hint. api.openai.com
sends permissive CORS headers, so an OpenAI row failing that way is a network or
proxy problem, not a server setting.

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
pnpm run preview       # builds @bhzai/core, then starts Vite

# Or, iterative dev (rebuild the lib as you go):
pnpm run build
pnpm --filter bhzai-example dev
```

Requirements:

- WebGPU-capable browser (Chrome/Edge 113+).
- Modern JavaScript (ES2022, custom elements, async/await, dynamic import).

## Consumers / Testing

- **Unit tests** (`pnpm test` from the root, `example/**/*.test.ts` is in the
  vitest `include`):
  - `src/lib/{format,stats,thermal,mcp-store,provider-store,models,selection-store}.test.ts`
    — pure functions, default `node` environment.
  - `src/components/providers-dialog.test.ts` — list/add/edit view transitions,
    the kind badge and type typeahead, kind-aware field labels, the dispatched
    add/update/remove event details, and an untrusted-text guard on a
    provider's base URL.
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
  `mcp-add-form`, `mcp-error-dialog`, `provider-select`). These are glue over
  APIs that are themselves tested; they are covered by the smoke run.
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
  `../../src/plugins/*/*.ts`. Always import from `@bhzai/core` subpaths.
- **Biome linting applies** (`pnpm exec biome check example/`).
- **No persistent state in `app/*`**: all conversation/model state lives in
  `BHZAI`/`Conversation` instances; the UI is a pure reflection of that state
  (or in-flight changes).
- **A new DOM region means a new component**, not a new export on an existing
  one. The old `ui.js` grew to 21 exports across six unrelated regions; that is
  the failure mode this layout exists to prevent.
- **Always log captured exceptions to the console**, make them nice for the user, 
  but don't hide them for developers.
