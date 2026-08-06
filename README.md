<h1 align="center">Loreweave</h1>

<p align="center">
  <strong>A temporal knowledge engine for markdown vaults.</strong><br>
  It indexes, links, remembers, forgets, and dreams — locally, over files you own.
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

## Measured, not asserted

Loreweave ships its own benchmark — `npm run eval` — over a purpose-built
100-note vault where multi-hop answers deliberately share **no vocabulary**
with the query. 40 gold questions across lookup / multi-hop / temporal /
aggregate, scored against two baselines:

| system | finds the answer | right note in top 5 | MRR |
|---|---|---|---|
| **hybrid** (shipped) | **95%** | **75%** | **0.538** |
| BM25 only | 75% | 65% | 0.532 |
| graph only | 88% | 43% | 0.222 |

On multi-hop specifically: **hybrid finds 80%, BM25 finds 0%**. Lexical search
cannot reach a note that shares no words with your query — at any depth. That
gap is the entire reason the graph exists.

The honest caveat: hybrid scores lower on `ans@5` (0.45 vs 0.55) — the metric
for "did the returned *block* literally contain the answer string". Promoting
linked notes into the top 5 costs some block-level precision to buy note-level
reach. If your vault is small and lexical search already finds everything, set
`retrieval.weights.expansion: 0` and you get pure BM25 behaviour.

Run it yourself: `npm run eval`. `npm run eval:gate` fails the build on
regression, and CI enforces it on every push.

## What makes it different

**1. Knowledge that has a timeline.** Facts are bitemporal: when they were true in the
world (`valid_from`/`valid_until`) and when the system learned them (`recorded_at`).
Contradictions **supersede** rather than overwrite, so history stays queryable.

```bash
$ lore assert "Ledger Format" status draft --valid-from 2026-01-01
$ lore assert "Ledger Format" status final --valid-from 2026-08-01
✓ Ledger Format :: status :: final
  superseded: "draft" (now valid until 2026-08-01)

$ lore facts --subject "Ledger Format"
Ledger Format :: status :: final  (2026-08-01 → now)

$ lore facts --subject "Ledger Format" --as-of 2026-03-01
Ledger Format :: status :: draft  (2026-01-01 → 2026-08-01)  [superseded]
```

Which fact wins is decided **deterministically** (newest valid-time, provenance as
tiebreak) — never by asking a language model which one looks fresher.

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
• 2025-03-14-standup.md#Standup@0  [all terms]
```

Both files were written seconds ago, so an mtime filter could not tell them
apart. `lore watch` keeps the index current so you never have to remember to
reindex.

**8. Built for agents.** An MCP server exposes 12 typed tools so Claude Code, Cursor, or
any MCP client can use your vault as durable memory — with a session context pack,
fact assertion, point-in-time queries, and a reinforcement signal.

## The CLI

| Command | What it does |
|---|---|
| `lore init` | create `.lore/` with a default config |
| `lore index [--full] [--no-nlp] [--rebuild-similar]` | incremental sync of vault → index |
| `lore search <q> [-k] [--since] [--until] [--json]` | hybrid retrieval with provenance |
| `lore ask <q>` | extractive answer: current facts + top passages (no LLM needed) |
| `lore facts [--subject] [--predicate] [--as-of] [--history]` | query the fact store |
| `lore assert <s> <p> <o…> [--valid-from]` | record a fact (journalled, supersedes) |
| `lore invalidate <s> <p>` | close the current fact in a slot |
| `lore count [--predicate] [--group-by] [--since]` | aggregate over fact history |
| `lore capture <text…>` | append a timestamped line to `lore/inbox.md` |
| `lore dream [--apply]` | consolidation pass + optional digest/review queue |
| `lore watch` | reindex automatically as the vault changes |
| `lore mark-used <note> [anchor]` | reinforce a passage that proved useful |
| `lore graph export --format json\|graphml\|dot` | export the graph |
| `lore doctor` / `lore stats` | health check / vault statistics |
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
`lore_invalidate_fact`, `lore_query_facts`, `lore_aggregate_facts`, `lore_capture`,
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
npm test          # 124 tests
npm run eval      # retrieval benchmark vs BM25 baseline
npm run typecheck
npm run build
```

Requires Node ≥ 20. Single native dependency (`better-sqlite3`).

## License

MIT © Ambuj Upadhyay
