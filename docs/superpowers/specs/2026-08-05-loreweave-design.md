# Loreweave — Design Spec

**Date:** 2026-08-05
**Status:** Approved for implementation (autonomous session; decisions documented in lieu of interactive review)

## What it is

Loreweave is a **temporal knowledge engine for markdown vaults**. It turns a folder of
plain markdown notes (Obsidian-compatible, but any markdown works) into a living memory:
it indexes, links, retrieves, remembers, forgets, and dreams — all locally, all
re-derivable from the files themselves.

One npm package: a core library, a CLI (`lore`), and an MCP server so any AI agent
(Claude Code, Cursor, Desktop, …) can use the vault as long-term memory through typed
tools instead of prompt conventions.

## Why (and why not the same product as obsidian-wiki)

[Ar9av/obsidian-wiki](https://github.com/Ar9av/obsidian-wiki) is a *prompt pack*: 39
markdown "skills" that a host coding agent interprets to maintain a vault. Its own issue
tracker shows the failure class: prose/code drift (#134-136), no migrations (#146),
grep-only retrieval, everything pull-based, no temporal model, no memory lifecycle.

Loreweave is the opposite bet, backed by 2024-2026 research (87 findings surveyed; see
`docs/research/`): **invariants live in code, prompts only orchestrate.** The engine is
real software with a schema, migrations, tests, and deterministic algorithms; the LLM
(usually the MCP caller) supplies judgment only where judgment is needed.

## Approaches considered

1. **Prompt-pack v2** (better prompts, same architecture as the friend's tool) —
   rejected: inherits the drift/fragility class the research identifies as the central
   weakness; not differentiated.
2. **Python engine** (spaCy NLP, his ML stack) — rejected: distribution friction
   (pip/uv/venv) versus `npx`, weaker MCP story, and the strongest NLP dependency
   (spaCy) is replaceable by wink-nlp + vault conventions at personal scale.
3. **TypeScript engine, npx-distributed, MCP-first** — **chosen**: zero-friction
   install, first-class MCP SDK, single native dep (better-sqlite3), consistent with
   the author's existing npm product (trovark).

## Research foundations (what the evidence says; each choice cited)

- **Markdown is the substrate; SQLite is a disposable cache.** Anthropic's memory tool,
  Basic Memory, and Karpathy's LLM-wiki pattern all converged here. Every derived row
  carries provenance (file, anchor, content hash); `lore index --full` rebuilds
  everything.
- **Relation-free graph, shallow PPR retrieval.** LLM relation extraction is the
  unstable, expensive step (LinearRAG ICLR'26, AtomicRAG '26, LazyGraphRAG). A vault
  already IS a graph: wiki-links + tags + entity mentions + co-occurrence + optional
  embedding-synonym edges. Retrieval fuses BM25 + dense + Personalized PageRank with
  dense reset probabilities (HippoRAG 2, ICML'25); 2-iteration PPR suffices (NodeRAG).
  GraphRAG-Bench (ICLR'26): this recipe wins multi-hop at vanilla-RAG query cost, and
  fusion prevents the simple-QA regression every other graph method pays.
- **No index-time community summarization.** The single worst quality-per-dollar
  component in the space (LazyGraphRAG: same quality at 0.1% of the cost).
- **Bitemporal facts, supersede-never-delete.** Zep/Graphiti's four timestamps
  (valid_from/valid_until, recorded_at/superseded_at); typed version links
  `updates`/`extends`/`derives` (Supermemory, SOTA on LongMemEval). Freshness is
  resolved deterministically — newest valid_from wins — never by asking an LLM
  (arXiv 2606.01435).
- **Memory dynamics: FSRS power law, reinforce on use.** Retrievability
  R(t,S) = (1 + (19/81)·t/S)^(-0.5); stability grows FSRS-style only when a memory is
  actually *cited/used* (RMM, ACL'25), not merely retrieved. Ranking =
  relevance + retrievability + importance (Generative Agents). Decay demotes to
  archive, never deletes.
- **Consolidation is idle-time work ("dreaming").** Letta sleep-time compute (~5x
  test-time savings), OpenAI/Anthropic both shipped it in 2026. `lore dream` runs
  dedup, contradiction, staleness, link-suggestion, and digest passes — emitting a
  reviewable report; destructive ops never auto-apply.
- **Never rewrite whole files with an LLM.** ACE (2025): context collapse + brevity
  bias. All mutations are delta operations on itemized units.
- **Computable facts beat similarity for aggregates.** "How many X last year?" —
  retrieval scores 6-43%, executed structured memory ~99% (User as Code, 2026). The
  fact layer is a queryable SQLite table with date-range/count/group-by.
- **The graveyard problem is a push problem.** The dominant PKM failure is
  capture-without-resurfacing. Loreweave pushes: context packs at session start (MCP),
  digests, stale-fact review queues, link suggestions.

## Architecture

```
vault/*.md  ──parse──▶  Vault layer (notes, blocks, wiki-links, tags, hashes)
                          │ incremental (mtime+hash)
                          ▼
                 SQLite (.lore/index.db)  ◀── migrations, schema v1
   notes · blocks · links · entities · mentions · edges · facts ·
   fact_links · embeddings · access_log · fts5(blocks) · meta
                          │
        ┌─────────────────┼──────────────────┐
        ▼                 ▼                  ▼
   Graph layer       Retrieval           Fact layer
   (CSR in-memory,   BM25 + dense +      bitemporal, same-slot
   PPR α=0.5, 2 it)  PPR fusion, RRF,    detection, supersession,
        │            dynamics boost,      deterministic freshness,
        │            time filters         aggregate queries
        └────────┬────────┴───────┬──────────┘
                 ▼                ▼
          Dream engine       Interfaces
          (dedup, contradiction,  CLI `lore` · MCP server
          stale, links, digest)   (typed tools, progressive disclosure)
```

### Units and boundaries

| Module | One purpose | Depends on |
|---|---|---|
| `src/vault` | Parse markdown files into Notes/Blocks/Links/Tags with stable anchors + hashes | nothing |
| `src/store` | SQLite schema, migrations, typed queries | nothing (better-sqlite3) |
| `src/index` | Incremental sync: vault ⟶ store diff | vault, store |
| `src/entities` | Entity extraction (links/tags/frontmatter + wink-nlp proper nouns), normalization, aliasing | vault |
| `src/graph` | Build CSR graph from store; Personalized PageRank | store |
| `src/embed` | Pluggable providers: none / ollama / openai-compatible; cosine top-k | store |
| `src/dynamics` | FSRS retrievability, importance heuristics, access/citation log | store |
| `src/retrieve` | Hybrid pipeline: FTS + dense + PPR → RRF → dynamics boost → time filter | graph, embed, dynamics, store |
| `src/facts` | Bitemporal fact CRUD, supersession, freshness, aggregates; journal write-back | store, vault |
| `src/dream` | Consolidation passes; report + safe-apply | all above |
| `src/cli` | Commands | all |
| `src/mcp` | MCP stdio server, typed tools | all |

### Key data decisions

- **Block = retrieval unit** (heading-bounded section, split at ~200-400 words), with
  anchor = `path#heading` + sequence. LongMemEval: fine granularity wins.
- **Facts are re-derivable from markdown.** Facts asserted through the engine are
  appended to `lore/journal/YYYY-MM-DD.md` as observation lines
  (`- [fact] subject :: predicate :: object {valid_from=…}`) — Basic Memory's trick —
  so the DB stays a cache. Facts extracted from notes carry their source anchor.
- **User files are never mutated** except append-only writes to `lore/`-namespaced
  notes (journal, digests) and explicit capture commands.
- **Zero-config degradation ladder:** no LLM + no embeddings → lexical + graph engine
  (fully functional); + embeddings (Ollama/API) → dense retrieval + synonym edges +
  clustering; + LLM caller via MCP → extraction, importance rating, dream synthesis.

### Error handling

- Malformed markdown/frontmatter: parse best-effort, record warnings, never crash the
  scan; `lore doctor` reports.
- DB corruption: detected via `PRAGMA integrity_check` on open → offer rebuild.
- Embedding/LLM provider failures: degrade to lexical+graph, warn once.
- All CLI commands exit non-zero on error with actionable one-line messages.

### Testing

- Unit tests per module (vitest), fixture vault in `tests/fixtures/vault/` with
  deliberate traps: unicode names, nested headings, broken links, duplicate titles,
  contradicting facts, date-ranged facts.
- E2E: index fixture → multi-hop query that BM25 alone fails but PPR resolves →
  assert/supersede facts → point-in-time query → dream report → full rebuild
  determinism (two rebuilds byte-identical rows).
- CI: GitHub Actions, Node 20/22, macOS + Linux.

## Not building (YAGNI)

- No GUI/web app (CLI + MCP + the user's own Obsidian).
- No sync service (git is the sync layer).
- No LLM relation extraction, no index-time community summaries (evidence: cost sinks).
- No learned reranker at v1 — but every (query, retrieved, used) tuple is logged so one
  can be trained later without a cold start (Memory-R1 lesson).
- No npm publish in this session (repo ready; publish is a later explicit step).

## Success criteria

1. `npx loreweave init && lore index` works on a real Obsidian vault with zero config.
2. Multi-hop retrieval demonstrably better than grep/BM25 on the fixture (tested).
3. Facts: assert → contradict → supersede → "what was true on DATE?" all correct (tested).
4. `lore dream` produces a useful, safe, reviewable report.
5. MCP server usable from Claude Code as a memory backend.
6. Full test suite green; deterministic rebuilds; no network unless configured.
