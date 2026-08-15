<h1 align="center">Loreweave</h1>

<p align="center">
  <strong>A temporal knowledge engine for markdown vaults.</strong><br>
  It indexes, links, remembers, forgets, and dreams — locally, over files you own.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/loreweave"><img src="https://img.shields.io/npm/v/loreweave" alt="npm"></a>
  <a href="https://github.com/lets-order-some-fries/loreweave/actions/workflows/ci.yml"><img src="https://github.com/lets-order-some-fries/loreweave/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <img src="https://img.shields.io/badge/node-%E2%89%A520-brightgreen" alt="node >= 20">
  <img src="https://img.shields.io/npm/l/loreweave" alt="MIT">
</p>

<p align="center">
  <a href="#quickstart">Quickstart</a> ·
  <a href="#what-makes-it-different">Different how?</a> ·
  <a href="#the-cli">CLI</a> ·
  <a href="#use-it-as-agent-memory-mcp">Agent memory</a> ·
  <a href="#how-it-works">How it works</a> ·
  <a href="#research-lineage">Research</a>
</p>

---

<p align="center">
  <img src="docs/demo.gif" alt="loreweave demo: temporal search, timeline, as-of facts, session resume" width="720">
</p>

Most knowledge tools are **write-only**. You capture diligently, the vault grows, and
six months later you can't find the thing you know you wrote — because retrieval is
keyword search over prose, nothing ever resurfaces on its own, and nothing notices when
what you wrote last year stopped being true.

Loreweave is the layer that fixes that. Point it at a folder of markdown (Obsidian or
plain) and it builds a knowledge graph, a bitemporal fact store, and a memory model over
your notes — then hands them to you through a CLI and to your AI agents through MCP.

Your files stay exactly as they are. **The vault is the source of truth; the index is a
cache you can delete at any time.**

```bash
npx loreweave init && npx loreweave index
```

## Quickstart

```bash
cd ~/my-vault
npx loreweave init          # creates .lore/
npx loreweave index         # incremental; ~seconds for thousands of notes

npx loreweave search "why did we drop the queue design"
npx loreweave ask "what's the status of project atlas"
npx loreweave dream         # what's duplicated, contradicted, stale, unlinked
```

Zero configuration required and no network calls: out of the box it runs on BM25 +
knowledge-graph spreading activation. Add embeddings when you want them:

```jsonc
// .lore/config.json
{ "embedding": { "provider": "ollama", "model": "nomic-embed-text" } }
```

Everything degrades gracefully — no embedding provider means lexical + graph retrieval,
still fully functional.

Works with non-English vaults: Chinese, Japanese and Korean text is segmented per
character so it is searchable at all, and other scripts index as written.

## Measured, not asserted

Loreweave ships its own benchmark — `npm run eval` — over **three** purpose-built
vaults, scored against a BM25 baseline and a graph-only baseline.

The second corpus exists to catch overfitting: it is deliberately unlike the
first in every dimension the config could have been tuned to (markdown links
instead of `[[wiki links]]`, deep nesting, filenames unrelated to titles, real
engineering note shapes). The third measures **time** instead of topicality:
facts change across dated notes, every date lives only in frontmatter where
BM25 cannot see it, and each windowed question is paired with a
shifted-window twin whose correct answer is a *different* note — the
perturbation test that exposes systems faking temporal competence through
lexical overlap.

| corpus | system | finds the answer | in top 5 | MRR | answer shown |
|---|---|---|---|---|---|
| kestrel (40 q) | **hybrid** | **100%** | **75%** | **0.545** | **55%** |
| | BM25 | 75% | 65% | 0.532 | 55% |
| northwind (24 q) | **hybrid** | **96%** | **92%** | **0.690** | **83%** |
| | BM25 | 63% | 58% | 0.521 | 54% |
| meridian (18 q) | **hybrid** | **100%** | **94%** | **0.952** | **94%** |
| | BM25 | 94% | 83% | 0.437 | 83% |

Multi-hop is where the graph earns its keep: **BM25 finds 0% on both prose
corpora** — it cannot reach a note that shares no words with your query, at
any depth — while hybrid finds 90% and 100%. Time is where the temporal
machinery earns its keep: on meridian's windowed questions hybrid ranks the
right note **first 100% of the time vs BM25's 0%** — and on the paired
perturbation test (same question, shifted window, different correct answer,
both directions must rank first) hybrid scores **100% vs BM25's 0%**. The
consistency number is computed and regression-gated by `npm run eval`, not
hand-derived.

"answer shown" is the strictest measure: not just the right note, but a
returned passage that literally contains the answer. Results are one per note,
showing whichever of that note's sections best covers your query — ranking
decides which notes matter, coverage decides which part of them you see.

The same shipped config wins on all three corpora, and by more on the ones it
was never tuned against. If you prefer pure lexical behaviour, set
`retrieval.weights.expansion: 0`.

Run it yourself: `npm run eval`. `npm run eval:gate` fails the build on any
regression across all three corpora, and CI enforces it on every push.

**What lexical + graph retrieval cannot do**, stated precisely: the kestrel
multi-hop questions use words like "hardware" and "outpost" that appear in
*zero* notes — the vault says "instrument" and "station". No statistic derived
from the vault (co-occurrence, PPMI, LSA) can bridge that, because there are no
occurrences to derive one from. Those answers are still *found* (90%) by
following links, but ranking them first needs external semantic knowledge —
which is exactly what enabling embeddings supplies.

## What makes it different

**1. Knowledge that has a timeline.** Facts are bitemporal: when they were true in the
world (`valid_from`/`valid_until`) and when the system learned them (`recorded_at`).
Contradictions **supersede** rather than overwrite, so history stays queryable.

```bash
$ lore assert "Ledger Format" status draft --valid-from 2026-01-01
$ lore assert "Ledger Format" status final --valid-from 2026-08-01
✓ Ledger Format :: status :: final
  superseded: "draft" (now valid until 2026-08-01)
  journal: lore/journal/2026-08-01.md

$ lore facts --subject "Ledger Format"
Ledger Format :: status :: final  (2026-08-01 → now)
    asserted · lore/journal/2026-08-01.md

$ lore facts --subject "Ledger Format" --as-of 2026-03-01
Ledger Format :: status :: draft  (2026-01-01 → 2026-08-01)  [superseded]
    asserted · lore/journal/2026-08-01.md
```

Both axes are queryable, which is the part that makes it bitemporal rather than
merely historical. `--as-of` asks what was *true* then; `--as-known-at` asks what
was *believed* then, excluding anything recorded later however far back it was
backdated. They disagree exactly when you learn something after the fact — which
is when you most need to reconstruct what a past decision was actually based on:

```bash
$ lore facts --subject Vendor --as-of 2024-06-01
Vendor :: reliability :: poor — outage postmortem  (2024-01-01 → now)

$ lore facts --subject Vendor --as-known-at 2024-06-01
Vendor :: reliability :: good  (2024-01-01 → 2024-01-01)  [superseded]
```

Which fact wins is decided **deterministically** (newest valid-time, provenance as
tiebreak) — never by asking a language model which one looks fresher.

And the whole history of anything is one command — every value change from the
fact store merged chronologically with the dated prose that mentions it:

```bash
$ lore timeline Project Atlas
2024-01-15  status: planning  (until 2024-09-01)
2024-02-10  • [[Project Atlas]] kicked off with a three-person crew.  [kickoff.md]
2024-09-01  status: planning → active
2025-06-20  • The [[Project Atlas]] midpoint review went long but well.  [review.md]
```

"What was X before it changed" is the query temporal-graph products market as
their flagship — built there by running an LLM over every ingested document.
Here the supersede chain has been maintained all along, so it is a read-side
join: no LLM, no network, same answer every time.

**2. Retrieval that follows connections, not just words.** Queries fuse BM25, dense
similarity (when configured), and Personalized PageRank over the vault's own graph —
wiki-links, shared entities, tags, co-occurrence. Two-hop neighbors surface even when
they share no vocabulary with your query, and every result tells you *why*:

```
• data/glacier-dataset.md#@0  (0.0327)  ⟨via amara osei⟩
  The Glacier Dataset holds meltwater sensor readings from 2019-2024.
```

**3. Memory with dynamics.** Every passage carries FSRS-style stability and
retrievability — a power-law forgetting curve. Passages that actually get *used* (not
merely retrieved) decay slower; important-but-fading knowledge gets surfaced for review
instead of silently rotting. Nothing is ever deleted.

**4. It dreams.** `lore dream` is an idle-time consolidation pass that reviews the vault
and reports duplicate passages, contradicted facts, stale knowledge, missing links
between notes that clearly belong together, and orphans. With `--apply` it writes a
digest and a review queue — **append-only, under `lore/`**. It never rewrites your prose:
LLM-driven whole-file rewriting is a documented failure mode (context collapse), so the
architecture forbids it.

**5. Questions retrieval can't answer.** Counting, grouping, and date-range queries run
as deterministic SQL over the fact store, not as vibes over embeddings:

```bash
$ lore count --predicate trip_to --since 2025-01-01 --until 2025-12-31
    2  Japan
    1  Kenya
```

**6. Facts come from your notes, not from a form.** The fact store used to be
empty on any real vault — nobody hand-writes `- [fact] X :: y :: z`. It now
mines the conventions vaults already use:

```yaml
status: shipped              # frontmatter
- owner:: Priya              # Dataview inline field
- [location] Hyderabad       # Basic Memory observation
```

Only unambiguous field syntax is accepted automatically. Prose formatting like
`- **Owner:** Priya` is precise on entity notes and noisy on report notes, so
it is opt-in (`facts.extract: "all"`) — or an agent can review candidates via
`lore_propose_facts` and assert the real ones. Judgement stays out of the index.

**7. Time means when it happened, not when you saved the file.** `--since` and
`--until` filter on *content* time — taken from frontmatter dates, dated
filenames (`2025-03-14-standup.md`), or dates in the text — falling back to
file mtime only when a note carries no date of its own:

```bash
$ lore search ledger --since 2025-01-01 --until 2025-12-31
• 2025-03-14-standup.md › Standup  [all terms]
  Discussed the ledger migration.
```

Both files were written seconds ago, so an mtime filter could not tell them
apart. `lore watch` keeps the index current so you never have to remember to
reindex.

**8. Built for agents.** An MCP server exposes 15 typed tools so Claude Code, Cursor, or
any MCP client can use your vault as durable memory — with a session context pack,
fact assertion, point-in-time queries, and a reinforcement signal. Session
continuity is a query, not a paraphrase: `lore resume` returns exactly what
changed since the agent last connected, computed from record time —

```bash
$ lore resume
since 2026-08-11 15:55
~ lore/journal/2026-08-11.md
+ Project Atlas :: status :: shipped (since 2026-08-11)
± Project Atlas :: status: active → shipped

$ lore resume
since 2026-08-11 15:56
nothing changed
```

— where the popular alternatives run an LLM over the previous session and
inject the summary: a paraphrase, unreproducible, wrong exactly when it
matters.

## The CLI

| Command | What it does |
|---|---|
| `lore init` | create `.lore/` with a default config |
| `lore index [--full] [--no-nlp] [--rebuild-similar]` | incremental sync of vault → index |
| `lore search <q> [-k] [--since] [--until] [--tag] [--folder] [--json]` | hybrid retrieval with provenance |
| `lore ask <q>` | extractive answer: current facts + top passages (no LLM needed) |
| `lore facts [--subject] [--predicate] [--as-of] [--as-known-at] [--history]` | query the fact store |
| `lore timeline <entity> [--since] [--until]` | chronological history: fact changes merged with dated mentions |
| `lore resume [--since]` | what changed since the last resume: notes, facts, supersessions |
| `lore review [--threshold] [--limit]` | important-but-fading knowledge to revisit or archive |
| `lore assert <s> <p> <o…> [--valid-from]` | record a fact (journalled, supersedes) |
| `lore invalidate <s> <p>` | close the current fact in a slot |
| `lore count [--predicate] [--group-by] [--since]` | aggregate over fact history |
| `lore capture <text…>` | append a timestamped line to `lore/inbox.md` |
| `lore dream [--apply]` | consolidation pass + optional digest/review queue |
| `lore watch` | reindex automatically as the vault changes |
| `lore mark-used <note> [anchor]` | reinforce a passage that proved useful |
| `lore graph export --format json\|graphml\|dot` | export the graph |
| `lore doctor` | health check: broken links, integrity, coverage |
| `lore stats` | vault statistics and top entities |
| `lore serve --mcp` | start the MCP server on stdio |

## Use it as agent memory (MCP)

```jsonc
// Claude Code: .mcp.json  (or claude_desktop_config.json)
{
  "mcpServers": {
    "loreweave": {
      "command": "npx",
      "args": ["-y", "loreweave", "--vault", "/path/to/vault", "serve", "--mcp"]
    }
  }
}
```

Tools: `lore_search`, `lore_context_pack`, `lore_read_note`, `lore_assert_fact`,
`lore_invalidate_fact`, `lore_query_facts`, `lore_timeline`, `lore_resume`, `lore_review`, `lore_aggregate_facts`, `lore_capture`,
`lore_mark_used`, `lore_propose_facts`, `lore_dream_report`, `lore_index`.

Facts asserted through MCP are written back to `lore/journal/YYYY-MM-DD.md` as readable
markdown lines, so an agent's memory is something you can open, read, edit, and
`git diff`:

```markdown
- [fact] Ledger Format :: status :: final {valid_from=2026-08-01, confidence=0.9, source=stated}
```

Delete `.lore/` and reindex — every fact and edge is reconstructed from those files.

## How it works

```
vault/*.md ──parse──▶ notes · blocks · wiki-links · tags · entities
                            │  (incremental: mtime + content hash)
                            ▼
                  SQLite .lore/index.db  ── disposable cache, rebuildable
                            │
        ┌───────────────────┼────────────────────┐
        ▼                   ▼                    ▼
   graph (CSR)         retrieval             facts
   blocks ∪ entities   BM25 + dense + PPR    bitemporal, supersession,
   2-iteration PPR     → weighted RRF        deterministic freshness,
   α = 0.5             → FSRS boosts         aggregates
        └─────────┬─────────┴──────────┬─────────┘
                  ▼                    ▼
             dream (idle-time)     CLI · MCP
```

Design rules the code enforces:

- **Files win.** User markdown is never mutated. The engine only appends, and only under
  `lore/`.
- **Invariants in code, not prompts.** Schema, migrations, graph construction, and
  supersession are typed, versioned, and tested — no LLM re-specifies them at runtime.
- **No LLM required anywhere in the core.** Indexing and retrieval use zero tokens.
  Language models are consumers of this engine, not dependencies of it.
- **Everything is re-derivable.** A full rebuild reproduces byte-identical derived state
  (there's a test for that).

## Research lineage

Every significant choice traces to 2024-2026 literature; the full 87-finding survey lives
in [`docs/research/`](docs/research/) and the reasoning in
[`docs/superpowers/specs/`](docs/superpowers/specs/).

| Choice | Source |
|---|---|
| Dense-sparse fusion + PPR with dense reset probabilities | HippoRAG 2 (ICML 2025), [2502.14802](https://arxiv.org/abs/2502.14802) |
| Shallow 2-iteration PPR, heterogeneous nodes | NodeRAG (2025), [2504.11544](https://arxiv.org/abs/2504.11544) |
| Relation-free graph — no LLM triple extraction | LinearRAG (ICLR 2026), [2510.10114](https://arxiv.org/abs/2510.10114); AtomicRAG (2026) |
| No index-time community summarization | LazyGraphRAG (Microsoft, 2024) — same quality at 0.1% index cost |
| Route/fuse instead of graph-everything | GraphRAG-Bench (ICLR 2026), [2506.05690](https://arxiv.org/abs/2506.05690) |
| Bitemporal facts, invalidate-never-delete | Zep/Graphiti (2025), [2501.13956](https://arxiv.org/abs/2501.13956) |
| Typed version links (`updates`/`extends`/`derives`) | Supermemory, SOTA on LongMemEval |
| Deterministic freshness, not LLM-judged | "Don't Ask the LLM to Track Freshness" (2026) |
| Power-law forgetting, use-gated reinforcement | FSRS; RMM (ACL 2025), [2503.08026](https://arxiv.org/abs/2503.08026) |
| Consolidation as idle-time work | Sleep-time compute (Letta, 2025), [2504.13171](https://arxiv.org/abs/2504.13171) |
| Never let an LLM rewrite whole memory files | ACE (2025), [2510.04618](https://arxiv.org/abs/2510.04618) |
| Computable facts for aggregation | User as Code (2026), [2606.16707](https://arxiv.org/abs/2606.16707) |
| Fine-grained indexing + fact-augmented keys | LongMemEval (ICLR 2025), [2410.10813](https://arxiv.org/abs/2410.10813) |

## Library use

```ts
import { openContext, indexVault, search, assertFact, queryFacts, dream } from 'loreweave';

const ctx = openContext('/path/to/vault');
await indexVault(ctx.store, ctx.root);
const hits = await search(ctx, 'streaming compaction', { k: 5 });
assertFact(ctx, { subject: 'Atlas', predicate: 'status', object: 'shipped', validFrom: '2026-08-01' });
const asOfMarch = queryFacts(ctx.store, { subject: 'Atlas', asOf: '2026-03-01' });
const report = dream(ctx);
ctx.close();
```

## Development

```bash
npm install
npm test          # 419 tests
npm run eval      # retrieval benchmark vs BM25 baseline
npm run typecheck
npm run build
```

Requires Node ≥ 20. Single native dependency (`better-sqlite3`). Tested in CI on
Linux, macOS and Windows across Node 20 and 22.

## License

MIT © Ambuj Upadhyay
