# typescript-lsp

Repository-local Claude Code plugin that gives Claude a real TypeScript language
server for this project, so it sees `tsc` diagnostics as it edits instead of
finding out at `pnpm typecheck` time.

## What's in here

| File | Purpose |
| --- | --- |
| `.claude-plugin/plugin.json` | Plugin manifest. |
| `.lsp.json` | Language server definition — command, args, and the file extensions it owns. |
| `hooks/hooks.json` | Registers the `SessionStart` hook. |
| `hooks/ensure-typescript-lsp.sh` | The hook: installs dependencies if `typescript-language-server` is missing. |

## How it gets loaded

`.claude/settings.json` registers the repository as a plugin marketplace
(`.claude-plugin/marketplace.json`) and enables `typescript-lsp@bhzai`, so anyone
who clones the repo and trusts the folder gets it — nothing to install by hand.

The marketplace source is the directory `"."`, which Claude Code resolves
against the working directory, so start `claude` from the repository root. From
a subdirectory the marketplace won't be found; `claude --plugin-dir
.claude/plugins/typescript-lsp` loads the plugin directly if you need that.

## How it starts

1. On session start the hook checks for `node_modules/.bin/typescript-language-server`
   and `node_modules/typescript`. If either is missing it runs `pnpm install`
   (falling back to `corepack pnpm`, then `npx pnpm@9.15.0`) and smoke-tests the
   binary. When everything is already installed it exits silently.
2. Claude Code spawns the server itself, lazily, the first time it touches a
   file whose extension is listed in `extensionToLanguage`. Diagnostics come
   back scoped by `tsconfig.json`, so the rules match `pnpm typecheck`.

## Changing the server

Both `typescript` and `typescript-language-server` are ordinary devDependencies
in the root `package.json`; bump them there. The `${CLAUDE_PROJECT_DIR}` prefix
in `.lsp.json` is expanded by Claude Code, which is what keeps the plugin
pointed at the project's own copy rather than a global install.
