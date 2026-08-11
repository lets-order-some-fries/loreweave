# Contributing to Loreweave

## Development setup

```bash
npm ci
npm run typecheck   # tsc --noEmit
npm test            # vitest run
npm run build       # tsup
npm run dev         # run the CLI from source
```

Node >= 20 required. `npm run eval:gate` runs the retrieval-quality gate; run it if your change touches search, ranking, or fact resolution.

## Workflow

All changes land through pull requests, including from the maintainer:

1. Branch from `main` (`feat/...`, `fix/...`, `docs/...`).
2. Keep commits scoped; conventional prefixes (`feat:`, `fix:`, `docs:`, `chore:`).
3. CI must be green before merge.

## Reporting issues

The most actionable reports include a minimal vault (a few markdown files), the exact command or MCP tool call, and observed vs expected output.
