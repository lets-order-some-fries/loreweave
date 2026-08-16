# Competitive scoreboard

What "better than the competition" means for this project, stated as numbers
that can be checked rather than adjectives that cannot. Every loreweave figure
here is reproducible with the commands in [`benchmarks.md`](benchmarks.md);
every competitor figure carries its source.

**The comparison trap, stated once.** Most published agent-memory numbers
(Mem0 92.5 on LoCoMo, Zep 63.8 on LongMemEval, Hindsight 94.6) are
**end-to-end QA accuracy**: retrieve, feed an LLM, have a judge grade the
written answer. loreweave's numbers are **retrieval metrics**. A system can
retrieve perfectly and answer badly, or retrieve poorly and get lucky. These
are different quantities and are not compared here — where no comparable
third-party retrieval number exists, this file says so instead of reaching for
the nearest number that looks similar.

## 1. Document retrieval — BEIR / SciFact, nDCG@10

| system | nDCG@10 | source |
|---|---|---|
| **loreweave + local embeddings** | **0.729** | `npm run bench:beir -- ./scifact --embed` |
| loreweave + embeddings + reranking | 0.695 | `… --embed --rerank` |
| loreweave, model-free | 0.681 | `npm run bench:beir -- ./scifact` |
| BM25 (Anserini) | 0.665 | BEIR paper |

**Status: won.** Ahead of the classical baseline model-free, and comfortably
ahead with the optional layer. Modern large embedding retrievers score higher
on SciFact than either figure; loreweave is competitive with, not ahead of,
2026 dense retrieval — and it gets there with a small local model and no
network.

## 2. Conversational memory — LongMemEval_S, session recall@5

| system | R@5 | source |
|---|---|---|
| MemPal (verbatim chunks + embeddings) | 96.6% | vendor benchmark |
| BM25 + vector hybrid | 95.2% | third-party benchmark repo |
| **loreweave, chunked + mxbai-embed-large** | **96.0%*** | `--stride=5 --chunk=8 --embed --model=mxbai-embed-large` |
| loreweave, chunked + nomic-embed-text | 94.7%* | `--stride=5 --chunk=8 --embed` |
| loreweave + embeddings (nomic) | 94.4%* | `--stride=5 --embed` |
| loreweave + embeddings + reranking | 93.6%* | `--stride=5 --embed --rerank` |
| loreweave, chunked, model-free | 92.6%* | `--stride=5 --chunk=8` |
| loreweave, model-free | 92.8%* / **89.9%** | sample / **full 500** |
| BM25 alone | 86.2% | third-party benchmark repo |

\* 100-question stratified sample. The one arm measured both ways scored 92.8%
sampled against 89.9% on the full 500, so **the sample runs ~3 points high** and
every starred figure should be read ~3 points lower. On that correction the best
configuration lands near **92% on the full set**.

**Status: not yet, and not close enough to claim otherwise.** Clearly ahead of
lexical-only retrieval, still behind hybrid systems by roughly 3 points.
**The open target remains R@5 ≥ 95.2% on the full 500.**

What was tried, so the next attempt does not repeat it: embeddings are worth
+1.6 points and are the single biggest lever; 8-turn session chunking adds +0.3
on top of embeddings and **nothing at all** model-free (92.6 vs 92.8), which
kills the theory that BM25 length normalisation was the problem; cross-encoder
reranking is **negative** here (−0.8) and on BEIR (−0.034 nDCG).

**The embedding model matters more than anything downstream of it.** Swapping
nomic-embed-text (137 M) for mxbai-embed-large (335 M) is worth +1.3 points on
the same sample — larger than chunking, fusion tuning and reranking put
together, and it needs no code change beyond the task prefixes the model
expects. Part of the gap to the published hybrids was never architectural; it
was that we benchmarked a small local embedder against systems using large
ones.

The definitive full-500 run of the best configuration is **still outstanding** —
it needs ~2 h and more free RAM than this machine had (two attempts died when
the embedding server was starved out at 6% free memory). The engine treats an
unreachable embedding server as a soft failure and falls back to lexical
retrieval, so a run that loses the provider partway reports a blended number
with nothing in the output saying so; check any long run for
`dense retrieval unavailable` before believing its totals.

## 3. Long-conversation retrieval — LoCoMo, turn-level recall

| | R@1 | R@5 |
|---|---|---|
| loreweave + reranking | 0.422 | 0.582 |
| loreweave, model-free | 0.337 | 0.538 |

**Status: no comparable number exists.** Everything published on LoCoMo by
memory vendors is QA accuracy over a different task definition. We report ours
so it can be beaten; we do not claim a win we cannot support.

## 4. Temporal correctness — perturbation-paired consistency

| system | consistency |
|---|---|
| **loreweave** | **100%** |
| BM25 baseline | 0% |

Same question, shifted window, *different* correct answer; consistent only when
both directions rank their answer first. **Status: won, and uncontested** — no
competitor publishes this metric at all. It is gated in CI, so it cannot
silently regress.

## 5. Properties no competitor number captures

- **Model-free by default.** Same vault, same query, same answer — forever, with
  no model in the loop. QMD is local but runs local *models*; Mem0 and Zep call
  out to LLMs at write time. The guarantee here is reproducibility, not privacy.
- **Markdown is the source of truth**, the index is a deletable cache, and every
  fact is a line you can read and `git diff`.
- **Scale is published** (20 000 notes: 22.5 s index, 38 ms p50 search) and
  reproducible with one command. No competitor publishes theirs.

## Definition of done

Two of five are won, one is uncontested, one has no valid comparison, and one is
open. The single remaining measurable target is **§2: LongMemEval_S R@5 ≥ 95.2%
on the full 500 questions**. Everything else on this board is either ahead or
unmeasurable against the field.

**Where that leaves the claim.** "Best in the market" is not supportable as a
blanket statement and this file will not make one. What the numbers support:
loreweave beats the classical baseline on public document retrieval, is the only
system publishing temporal-consistency or scale figures at all, and is the only
one that does any of it model-free and reproducibly. It is behind the vector
hybrids on conversational recall by about three points. Both halves of that are
true, and a scoreboard that printed only the first half would be worthless.
