# Loreweave Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (inline execution chosen — single implementer holds full context; subagent-per-task would fragment a tightly-coupled core). Steps use checkbox syntax.

**Goal:** Build Loreweave v0.1.0 — a temporal knowledge engine for markdown vaults (library + `lore` CLI + MCP server) per `docs/superpowers/specs/2026-08-05-loreweave-design.md`.

**Architecture:** Markdown vault is source of truth; SQLite (`.lore/index.db`) is a rebuildable cache. Hybrid retrieval (FTS5 BM25 + optional dense + 2-iteration Personalized PageRank fused via RRF, boosted by FSRS retrievability/importance). Bitemporal fact layer with supersession. Idle-time consolidation ("dream") emits reviewable reports.

**Tech Stack:** TypeScript (ES2022, NodeNext), Node ≥20, better-sqlite3, gray-matter, wink-nlp (+ wink-eng-lite-web-model), commander, @modelcontextprotocol/sdk, zod, vitest, tsup.

## Global Constraints

- Node `>=20`; ESM only (`"type": "module"`).
- User markdown files are NEVER mutated; engine writes only append/create under `lore/` namespace in the vault.
- No network calls unless a provider is explicitly configured.
- Every derived row carries provenance (note path, anchor, content hash).
- `lore index --full` must reproduce identical logical state (determinism test).
- All timestamps stored as ISO-8601 UTC strings; valid-time may be date-only.
- Package name `loreweave`, bins `lore` + `loreweave`, license MIT.

---

### Task 1: Scaffold
**Files:** `package.json`, `tsconfig.json`, `vitest.config.ts`, `tsup.config.ts`, `.gitignore`, `LICENSE`, `src/types.ts`
**Produces:** shared domain types — `Note {path, title, frontmatter, tags, links[], blocks[], hash, mtimeMs}`, `Block {anchor, heading, order, text, hash}`, `WikiLink {raw, target, alias?, heading?, blockAnchor}`, `LoreConfig` (zod-validated).
- [x] npm init + install deps; tsconfig strict; vitest configured; `npm test` runs empty suite green; commit.

### Task 2: Vault layer
**Files:** `src/vault/parse.ts`, `src/vault/scan.ts`, `tests/vault.test.ts`, fixture `tests/fixtures/vault/**`
**Produces:** `parseNote(path, raw, mtimeMs): Note` — frontmatter via gray-matter (fail-soft), heading-bounded blocks split at ~350 words, wiki-links `[[Target|alias]]` / `[[Target#Heading]]`, `#tags`, per-block sha1 `hash`. `scanVault(root, ignore?): Promise<VaultFile[]>` skipping `.lore/`, dotdirs, non-md.
**Tests:** unicode filenames, broken frontmatter doesn't throw, nested headings produce stable anchors `path#h1/h2@n`, link/alias/heading parse matrix, oversized section splits.
- [x] failing tests → implement → green → commit.

### Task 3: Store layer
**Files:** `src/store/schema.ts`, `src/store/db.ts`, `tests/store.test.ts`
**Produces:** `openStore(dbPath): Store` with migrations table (`schema_version`), WAL, integrity check; tables `notes, blocks, links, entities, mentions, edges, facts, fact_links, embeddings, access_log, meta` + `blocks_fts` (FTS5, porter, contentless-delete or external content synced by triggers in code). Typed DAO methods used by later tasks (upsert/delete by note path; transactional).
**Tests:** migration idempotence, FTS row lifecycle follows block upsert/delete, foreign-key cascade note→blocks→mentions.
- [x] TDD cycle; commit.

### Task 4: Incremental indexer
**Files:** `src/index/indexer.ts`, `tests/indexer.test.ts`
**Consumes:** vault + store. **Produces:** `indexVault(store, root, {full?}): IndexReport {added, updated, removed, unchanged, warnings}` — diff by (mtimeMs, note hash); block-level replace on change; removes vanished notes.
**Tests:** second run all-unchanged; edit one note → 1 updated; delete file → rows gone; `--full` after manual DB tamper restores truth.
- [x] TDD cycle; commit.

### Task 5: Entities
**Files:** `src/entities/extract.ts`, `src/entities/normalize.ts`, `tests/entities.test.ts`
**Produces:** `extractEntities(note): EntityMention[]` — sources ranked by confidence: wiki-link targets (1.0), tags (0.9), frontmatter `aliases/name` (0.9), wink-nlp proper-noun chunks (0.6). `normalizeEntity(s): string` (NFKC, casefold, trim punctuation, collapse ws). Mentions carry block anchor.
**Tests:** "Sarah Chen" in prose + `[[Sarah Chen]]` unify to one entity key; tag `#machine-learning` normalizes; no stopword junk.
- [x] TDD cycle; commit.

### Task 6: Graph + PPR
**Files:** `src/graph/build.ts`, `src/graph/ppr.ts`, `tests/graph.test.ts`
**Produces:** `buildGraph(store): LoreGraph` (CSR arrays over node ids = blocks ∪ entities; edge types LINK 1.0, MENTION 0.7, COOCCUR 0.4, SIMILAR 0.8·cos, TAG 0.5 — weights in config). `ppr(graph, seeds: Map<nodeId, mass>, {alpha=0.5, iterations=2}): Float64Array`.
**Tests:** hand-built 6-node graph — PPR ranks 2-hop neighbor above disconnected node; damping honored; empty seeds → zeros.
- [x] TDD cycle; commit.

### Task 7: Embeddings (pluggable)
**Files:** `src/embed/provider.ts`, `src/embed/ollama.ts`, `src/embed/openai.ts`, `src/embed/index.ts`, `tests/embed.test.ts`
**Produces:** `EmbeddingProvider {name, dims, embed(texts): Promise<Float32Array[]>}`; `resolveProvider(config): EmbeddingProvider | null` (`none` default); `embedMissingBlocks(store, provider)`; `denseTopK(store, qvec, k)` brute-force cosine over BLOBs; `buildSimilarEdges(store, threshold=0.8, topk=5)`.
**Tests:** mocked fetch for both providers; cosine math; absence of provider → all call-sites no-op cleanly.
- [x] TDD cycle; commit.

### Task 8: Dynamics
**Files:** `src/dynamics/fsrs.ts`, `src/dynamics/importance.ts`, `tests/dynamics.test.ts`
**Produces:** `retrievability(daysSinceAccess, stabilityDays): number` = (1+(19/81)·t/S)^(−0.5); `reinforce(S, D, R): number` (FSRS growth, bounded); `importanceHeuristic({inDegree, outDegree, isHub, frontmatterPriority?, recencyDays}): number` ∈[0,1]; access logging + citation marking (`markUsed`).
**Tests:** R(S,S)≈0.9; reinforcement largest when R low; monotonicity; importance bounds.
- [x] TDD cycle; commit.

### Task 9: Retrieval pipeline
**Files:** `src/retrieve/search.ts`, `tests/retrieve.test.ts`
**Consumes:** graph, embed, dynamics, store. **Produces:** `search(ctx, query, {k=8, asOf?, since?, mode?}): SearchResult[]` — FTS5 top-40 + dense top-40 (if provider) + entity-seeded PPR (seed mass: matched query entities + dense block scores, HippoRAG-2 style) → RRF (k=60) → boost = w_rel·rrf + w_ret·R + w_imp·imp → provenance-rich results (path, anchor, snippet, score breakdown, connecting entities).
**Tests:** fixture multi-hop trap — query mentions A and C where A—B—C only connect via links/entities and BM25 top-1 is a decoy: PPR fusion must surface the bridge note; time filters exclude/include correctly; graceful no-embeddings path.
- [x] TDD cycle; commit.

### Task 10: Fact layer
**Files:** `src/facts/model.ts`, `src/facts/journal.ts`, `tests/facts.test.ts`
**Produces:** `assertFact(ctx, {subject, predicate, object, validFrom?, validUntil?, confidence?, source})` → same-slot check (normalized subject+predicate, overlapping validity) → supersession (`updates` link, old fact `valid_until`+`superseded_by` set) or `extends`; never delete. `invalidateFact(id, when)`. `queryFacts({subject?, predicate?, asOf?, includeSuperseded?})` deterministic freshness (newest valid_from; provenance tiebreak). `aggregateFacts({predicate, groupBy?, count?, range?})`. Journal write-back: appended `- [fact] s :: p :: o {valid_from=…}` lines in `lore/journal/YYYY-MM-DD.md`; parser side: journal fact lines re-ingested on index (round-trip).
**Tests:** contradict → supersede chain; `asOf` mid-window returns old truth; aggregates count date-ranged; journal round-trip (assert → reindex from files → same facts).
- [x] TDD cycle; commit.

### Task 11: Dream engine
**Files:** `src/dream/dream.ts`, `src/dream/report.ts`, `tests/dream.test.ts`
**Produces:** `dream(ctx, {apply?}): DreamReport` with passes: `duplicates` (FTS/token-shingle Jaccard ≥0.85 + SIMILAR edges), `contradictions` (same-slot overlapping-validity facts), `stale` (importance ≥0.6 && R <0.3 → "still true?"), `linkSuggestions` (high co-occurrence/similarity, no wiki-link), `orphans`, `digest` (markdown summary of recent notes/facts/graph deltas). `--apply` writes ONLY safe artifacts: digest note + review-queue note under `lore/`; never edits user prose.
**Tests:** each pass on crafted fixtures; apply writes only under `lore/`; report deterministic.
- [x] TDD cycle; commit.

### Task 12: CLI
**Files:** `src/cli/main.ts` (+ `src/cli/context.ts`), `tests/cli.test.ts`
**Produces:** `lore init | index [--full] | search <q> [--json --k --as-of --since] | ask <q> | facts <query…> | assert | invalidate | capture | dream [--apply] | digest | doctor | stats | graph export [--format json|graphml|dot] | serve [--mcp]`. `ask` without LLM = extractive top passages + facts (honest labeling).
**Tests:** command-level integration via direct program invocation on temp vault; one spawned smoke test of built binary.
- [x] TDD cycle; commit.

### Task 13: MCP server
**Files:** `src/mcp/server.ts`, `tests/mcp.test.ts`
**Produces:** stdio MCP server, tools: `lore_search`, `lore_context_pack` (index-first progressive disclosure), `lore_read_note`, `lore_assert_fact`, `lore_invalidate_fact`, `lore_query_facts`, `lore_capture`, `lore_mark_used`, `lore_dream_report`, `lore_stats` — zod schemas, behavior-hinted descriptions.
**Tests:** in-memory transport pair from SDK; call each tool against temp vault; schema validation errors surface as MCP errors not crashes.
- [x] TDD cycle; commit.

### Task 14: E2E + docs + CI
**Files:** `tests/e2e.test.ts`, `README.md`, `.github/workflows/ci.yml`
**Produces:** determinism test (index twice → identical logical dump), full-journey E2E, README (philosophy, quickstart, architecture, research citations, comparison table), CI Node 20/22 × ubuntu/macos.
- [x] All green locally; commit.

### Task 15: Publish + adversarial review
- [x] Create GitHub repo `lets-order-some-fries/loreweave` (public), push.
- [x] Ultracode adversarial review workflow over the codebase (correctness, robustness, API design, test gaps); fix confirmed findings; re-run suite; push.

## Self-Review (done)
- Spec coverage: every spec module maps to a task (vault→2, store→3, index→4, entities→5, graph→6, embed→7, dynamics→8, retrieve→9, facts→10, dream→11, CLI→12, MCP→13, testing/CI→14, publish→15). ✓
- Interfaces named consistently across tasks (Store, LoreGraph, EmbeddingProvider, ctx). ✓
- No placeholders; test intents are concrete and falsifiable. ✓
