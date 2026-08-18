# Evaluation: methodology, internal corpora, and negative results

This is the long-form record behind the README's benchmark section: how the
internal corpora are built, what they caught, and the experiments that
*failed* — kept because a negative result someone can read is worth more than
a clean-looking README. Reproduction commands for every public number live in
[`benchmarks.md`](benchmarks.md); the field comparison with its
apples-to-oranges traps called out lives in [`scoreboard.md`](scoreboard.md).

## The internal corpora

Loreweave ships its own benchmark — `npm run eval` — over **three**
purpose-built vaults, scored against a BM25 baseline and a graph-only
baseline: **kestrel** (multi-hop questions over a prose vault), **northwind**
(the anti-overfitting corpus), and **meridian** (the temporal corpus).

Kestrel is the original development corpus: linked project notes whose
multi-hop questions require following `[[wiki links]]` to notes sharing no
vocabulary with the query. Northwind exists to catch overfitting: it is
deliberately unlike kestrel in every dimension the config could have been
tuned to (markdown links instead of `[[wiki links]]`, deep nesting, filenames
unrelated to titles, real engineering note shapes). Meridian measures **time**
instead of topicality:
facts change across dated notes, every date lives only in frontmatter where
BM25 cannot see it, and each windowed question is paired with a
shifted-window twin whose correct answer is a *different* note — the
perturbation test that exposes systems faking temporal competence through
lexical overlap.

| corpus | system | finds the answer | in top 5 | MRR | answer shown |
|---|---|---|---|---|---|
| kestrel (40 q) | hybrid | **100%** | **75%** | 0.545 | 55% |
| | BM25 | 75% | 65% | 0.532 | 55% |
| northwind (24 q) | hybrid | **96%** | **92%** | **0.690** | **83%** |
| | BM25 | 63% | 58% | 0.521 | 54% |
| meridian (18 q) | hybrid | **100%** | **94%** | **0.952** | **94%** |
| | BM25 | 94% | 83% | 0.437 | 83% |

("answer shown" is the strictest measure: not just the right note, but a
returned passage that literally contains the answer. These are author-written
questions over author-written notes — good for regression, worthless as proof,
which is why the README leads with the public benchmarks instead.)

Multi-hop is where the graph earns its keep: **BM25 finds 0% on both prose
corpora** — it cannot reach a note that shares no words with your query, at
any depth — while hybrid finds 90% and 100%. Time is where the temporal
machinery earns its keep: on meridian's windowed questions hybrid ranks the
right note **first 100% of the time vs BM25's 0%**, and on the paired
perturbation test (same question, shifted window, different correct answer,
both directions must rank first) hybrid scores **100% vs BM25's 0%**. The
consistency number is computed and regression-gated by `npm run eval`, not
hand-derived.

The same shipped config wins on all three corpora, and by more on the ones it
was never tuned against. If you prefer pure lexical behaviour, set
`retrieval.weights.expansion: 0`. `npm run eval:gate` fails the build on any
regression across all three corpora, and CI enforces it on every push.

## What lexical + graph retrieval cannot do

The kestrel multi-hop questions use words like "hardware" and "outpost" that
appear in *zero* notes — the vault says "instrument" and "station". No
statistic derived from the vault (co-occurrence, PPMI, LSA) can bridge that,
because there are no occurrences to derive one from. Those answers are still
*found* by following links; ranking them first needs semantics from outside
the vault.

## Embeddings, and the prefix bug

Embeddings supply that outside semantics — once the model is asked correctly.
`npm run eval -- --embed` reruns everything with local dense vectors (Ollama).
For three releases that measured *worse* than no embeddings at all, and the
cause turned out to be ours: `nomic-embed-text` is an asymmetric model trained
with task prefixes (`search_query:` / `search_document:`), and we were sending
raw text for both — so queries and passages landed in the same region of the
space and the dense channel stopped discriminating. With the prefixes sent:

| corpus | | r@5 | MRR | answer shown |
|---|---|---|---|---|
| kestrel | model-free | 0.750 | 0.545 | 0.550 |
| | + embeddings | **0.825** | **0.572** | **0.575** |
| northwind | model-free | 0.917 | 0.690 | 0.833 |
| | + embeddings | **0.958** | 0.681 | **0.875** |
| meridian | either | 0.944 | 0.951 | 0.944 |

Prefixes are inferred from the model name (nomic, E5, BGE, mixedbread and
Arctic families are known) and overridable with `embedding.queryPrefix` /
`documentPrefix`. Getting them wrong silently costs more than the model choice
does.

**The model choice matters more than any tuning downstream of it.** Swapping
`nomic-embed-text` (137 M) for `mxbai-embed-large` (335 M) moved LongMemEval_S
R@5 from 0.947 to 0.960 on an identical 100-question stratified sample, and
BEIR/SciFact nDCG@10 from 0.727 to 0.742 — on each benchmark a bigger gain
than chunking, fusion tuning and reranking combined. The full-500 LongMemEval
run of the winning configuration confirmed the sample almost exactly: **0.959**,
which is the number the README quotes.
The exception that bounds the finding: on LoCoMo's turn-level task the same
swap measures **flat** (R@5 0.529 vs 0.532, R@20 0.707 vs 0.705) with rank 1
slightly worse — single turns are too short for the larger model to
differentiate, so the lever is a document- and session-scale effect.

## Cross-encoder reranking: measured, and mostly rejected

A cross-encoder reads query and passage together, which retrieval scoring
never does. It is **off by default**, needs the optional
`@huggingface/transformers` package, and after measurement its role is
narrower than hoped.

Where it helps — measured on LoCoMo (1 982 evidence-labelled questions). The
full arm comparison, including the embeddings arm the README's table shows:

| | R@1 | R@5 | R@10 | R@20 | multi-hop R@1 |
|---|---|---|---|---|---|
| model-free | 0.337 | 0.538 | 0.610 | 0.656 | 0.087 |
| + embeddings | 0.318 | 0.532 | 0.627 | 0.705 | — |
| + mxbai embeddings | 0.286 | 0.529 | 0.628 | 0.707 | — |
| + reranking | **0.422** | **0.582** | 0.628 | 0.661 | **0.164** |

(Embeddings trade a little rank-1 for the deep list; reranking does the
reverse. Which one you want depends on whether you consume one passage or
twenty.)

Overall R@1 rises 25% relative, and multi-hop — the weakest category — nearly
doubles against its achievable ceiling. On the internal corpora it moves
kestrel r@1 0.400 → 0.575.

The costs, all measured:

- It sharpens rank 1 and scatters ranks 2-5 (northwind r@5 0.917 → 0.667). A
  rank-sum blend with retrieval recovers most of that but gives up most of the
  r@1 gain, so the trade is taken deliberately: an agent hands one passage to a
  model, and rank 1 is the product. If you consume a list of five, leave this
  off.
- It costs 200-850 ms per query depending on passage length, against 3-38 ms
  without.
- It is **skipped on temporally-scoped queries**. A cross-encoder cannot see a
  date, so on "status in 2026" it scores every passage about the subject alike
  and discards what the temporal machinery just established — measured,
  meridian r@1 0.944 → 0.278 when it was allowed to overrule that. Where the
  query names a time or asks for the current state, retrieval order stands and
  temporal consistency stays at 100%.
- **Stacking it on embeddings loses on both public benchmarks.** LongMemEval_S
  R@5 goes 0.944 → 0.936 with reranking added on top of embeddings, and
  BEIR/SciFact nDCG@10 goes 0.729 → 0.695. The two layers fix the same failure
  and then fight: the cross-encoder re-sorts a pool the embeddings had already
  ordered well and demotes correct passages out of the window. **Turn on one
  or the other, not both** — and if you consume a list rather than a single
  passage, embeddings alone is the configuration that wins.

## The rank-1 problem, and what failed

Across all three public benchmarks, recall is strong and top-of-ranking is
not: LoCoMo R@20 0.705 against R@1 0.337, LongMemEval R@10 0.983 against R@1
0.590, BEIR Recall@10 0.884 against nDCG@10 0.742. The right answer reliably
reaches the candidate pool; putting it *first* is the open problem.

Four attempts, three of which failed on measurement:

1. **Pseudo-relevance feedback** — flat on LoCoMo, kept only where it
   measured positive internally.
2. **Scoring the coverage signal directly** — harmful at every weight tried
   (meridian r@1 0.944 → 0.722 at the mildest); the comment in `search.ts`
   records it so nobody re-tries it.
3. **Cross-encoder reranking** — sharpens rank 1, loses R@5 once embeddings
   are on (above); off by default.
4. **A larger embedding model** — the one that worked, and it is upstream of
   all the others.

The current state: a known weakness, three ruled-out fixes, and no candidate
that improves rank 1 without costing recall.

## What benchmarking found and fixed

None of the public corpora have links, tags, or frontmatter — the structure
this engine exists to exploit — so it is measured with one hand tied; that is
the cost of using benchmarks we didn't design. And measuring them found a real
defect: the graph channel was trusted even on corpora with no graph to walk,
which cost 0.024 nDCG@10 on SciFact and 6 points of R@5 on LoCoMo. Fixed in
0.32.0. The fix is *not* uniformly better — LongMemEval's model-free R@10
moved 0.955 → 0.943 — and the trade is recorded here rather than hidden.

## Unevaluated, and said so

The FSRS memory dynamics (stability, retrievability, use-gated reinforcement)
and the `dream` consolidation pass have **no benchmark**: no third-party
corpus exists with labels for "what should resurface" or "which duplicate
matters". They are covered by unit tests and used daily, but they carry no
measured quality claim, and this file would rather say that than imply one.
