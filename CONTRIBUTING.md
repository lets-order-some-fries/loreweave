# Contributing to Loreweave

## Development setup

```bash
npm ci
npm run typecheck   # tsc --noEmit
npm run build       # tsup; the stdio-server tests run the built CLI, and skip without it
npm test            # vitest run
npm run dev         # run the CLI from source
```

Node >= 22 required. `npm run eval:gate` runs the retrieval-quality gate; run it if your change touches search, ranking, or fact resolution.

On npm 12, `npm ci` skips better-sqlite3's install script, so the tests cannot open a database: run `npm approve-scripts better-sqlite3`, then `npm rebuild better-sqlite3`. The first records the approval under `allowScripts` in `package.json`.

## Workflow

This section describes what actually happens, not a policy the repository does not enforce.

- **The maintainer commits directly to `main`.** `main` is not a protected branch and there is no pull-request gate on the maintainer's own changes. The gate is local: `npm run typecheck` and `npm test` are green before the commit. CI runs on every push to `main`, but after the fact — it checks what landed; it does not stand in front of it.
- **Outside contributions arrive as pull requests.** Branch from `main` (`feat/...`, `fix/...`, `docs/...`), keep commits scoped with conventional prefixes (`feat:`, `fix:`, `docs:`, `chore:`), and CI must be green on the pull request before it is merged.

## Reporting issues

The most actionable reports include a minimal vault (a few markdown files), the exact command or MCP tool call, and observed vs expected output.
