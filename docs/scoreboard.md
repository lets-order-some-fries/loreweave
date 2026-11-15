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
| **loreweave + mxbai-embed-large** | **0.742** | `… --embed --model=mxbai-embed-large` |
| loreweave + nomic-embed-text | 0.727 | `npm run bench:beir -- ./scifact --embed` |
| loreweave + embeddings + reranking | 0.695 | `… --embed --rerank` |
| loreweave, model-free | 0.681 | `npm run bench:beir -- ./scifact` |
| BM25 (Anserini) | 0.665 | BEIR paper |

**Status: above the BEIR paper's BM25.** loreweave scores 0.681 model-free
against Anserini BM25's 0.665, and 0.742 with a local embedder. SciFact
abstracts have no links and almost no tags, so the graph channel, whose
candidates enter the ranking only when links, tagged notes and facts together
reach one per 50 notes, is gated off and these rows do not measure it; the
model-free row is in effect loreweave's own BM25, which scores 0.6815 run alone
(0.6808 hybrid). The embedding-model lever from §2 generalises:
mxbai over nomic is worth +1.5 nDCG here (and Recall@10 0.865 → 0.884), the
same-sized lift it gave conversational recall. Modern large embedding
retrievers still score higher on SciFact; loreweave is competitive with, not
ahead of, 2026 dense retrieval — and it gets there with a local model and no
network. (The nomic figure was first published as 0.729; re-measured at 0.727
on 2026-08-17 — embedding-batch nondeterminism of ±0.002, worth knowing when
reading any figure here to the third decimal.)

## 2. Conversational memory — LongMemEval_S, session recall@5

| system | R@5 | questions | source |
|---|---|---|---|
| **loreweave, chunked + mxbai-embed-large** | **95.9%** | **all 500** | `--chunk=8 --embed --model=mxbai-embed-large` |
| loreweave, chunked + nomic-embed-text | 94.7%* | 100 | `--stride=5 --chunk=8 --embed` |
| loreweave + embeddings (nomic) | 94.4%* | 100 | `--stride=5 --embed` |
| loreweave + embeddings + reranking | 93.6%* | 100 | `--stride=5 --embed --rerank` |
| loreweave, chunked, model-free | 92.6%* | 100 | `--stride=5 --chunk=8` |
| loreweave, model-free | 89.9% | all 500 | — |

Full run, all 500 questions: R@1 0.590 · R@3 0.897 · **R@5 0.959** · R@10 0.983.

Historical, any-hit, not comparable with the rows above:

| system | R@5 (any-hit) | questions | source |
|---|---|---|---|
| MemPalace raw (vector-only) | 96.6% | 500 | [agentmemory][lme] |
| agentmemory BM25+Vector hybrid | 95.2% | 500 | [agentmemory][lme] |
| agentmemory BM25-only | 86.2% | 500 | [agentmemory][lme] |

[lme]: https://github.com/rohitg00/agentmemory/blob/main/benchmark/LONGMEMEVAL.md

loreweave's harness scores the *fraction* of gold sessions in the top K
(`found / gold.size`); the historical figures use `recall_any@K`, which scores
a question 1 if *any* gold session is in the top K.

**Status: no ranking claimed.** The published figures are historical: any-hit
scoring, an older input pipeline and, for the vector rows, the all-MiniLM-L6-v2
embedder; their author's [current evaluation (2026-10-28)][lme-eval] says the
95.2% cannot be compared with strict recall-all, and loreweave's figure is
fractional recall, which that evaluation also reports (91.7% for agentmemory's
BM25 component, 470 answerable questions, a different input pipeline). Every
earlier version of this file discounted the sampled figures by ~3 points, on
the evidence of the single arm then measured both ways (92.8% sampled vs 89.9%
full). **That correction did not generalise:** the best configuration scored
96.0% sampled and 95.9% on the full 500, so the stratified sample was accurate
to a tenth of a point here. Starred figures above are still 100-question
samples and are left starred rather than silently promoted.

[lme-eval]: https://github.com/rohitg00/agentmemory/blob/main/docs/benchmarks/2026-10-28-retrieval-evaluation.md

What was tried, so the next attempt does not repeat it: embeddings are worth
+1.6 points and are the single biggest lever; 8-turn session chunking adds +0.3
on top of embeddings and **nothing at all** model-free (92.6 vs 92.8), which
kills the theory that BM25 length normalisation was the problem; cross-encoder
reranking is **negative** here (−0.8) and on BEIR (−0.034 nDCG).

**The embedding model matters more than anything downstream of it.** Swapping
nomic-embed-text (137 M) for mxbai-embed-large (335 M) is worth +1.3 points on
the same sample — larger than chunking, fusion tuning and reranking put
together, and it needs no code change beyond the task prefixes the model
expects.

Reproducing this takes ~3 h and it took five attempts, four of which died
mid-run: a request that hung forever with no timeout, memory exhaustion that
starved the embedding server, one transient stall with no retry, and a
degraded server crawling at 5% duty cycle. Each failure was a real defect and
each fix shipped — `embedding.timeoutMs`, bounded retry with backoff and
per-retry logging, and a harness that releases each transcript after use. The
successful run needed exactly one retry, at almost the point where the
un-retried attempt had died.

Two traps worth knowing before trusting a long run's totals. The engine treats
an unreachable embedding server as a *soft* failure and falls back to lexical
retrieval, so a run that loses its provider partway reports a blended number
with nothing in the output saying so — grep for `dense retrieval unavailable`.
And restart `ollama serve` first: it degrades over hours of serving, which cost
one run a 4× slowdown that looked exactly like ordinary slowness.

## 3. Long-conversation retrieval — LoCoMo, turn-level recall

| | R@1 | R@5 | R@20 |
|---|---|---|---|
| loreweave + reranking | 0.422 | 0.582 | 0.661 |
| loreweave, model-free | 0.337 | 0.538 | 0.656 |
| loreweave + nomic embeddings | 0.318 | 0.532 | 0.705 |
| loreweave + mxbai embeddings | 0.286 | 0.529 | 0.707 |

**Status: no comparable number exists.** Everything published on LoCoMo by
memory vendors is QA accuracy over a different task definition. We report ours
so it can be beaten; we do not claim a win we cannot support.

Worth recording: the embedding-model lever that lifted §1 and §2 is **flat
here** — mxbai against nomic moves R@5 by −0.003 and R@20 by +0.002, noise
both — and slightly worse at rank 1. Single conversation turns are short
enough that the larger model has nothing extra to grip; the lever is a
document- and session-scale effect, not a universal one.

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

## Where that leaves the claim

This board was first written with a target, §2 R@5 ≥ 95.2% on the full 500, and
the §2 configuration was then chosen on 100-question samples of those same
questions. The full run reached 95.9%; for the reasons in §2 that is not a
ranking against the published figures.

Still not "best in the market", and this file still will not say it. What the
numbers do support is narrower: on SciFact loreweave scores above the BEIR
paper's BM25 (0.681 model-free, which with the graph channel gated off there is
in effect its own BM25, and 0.742 with a local embedder), and it is the only
system here publishing temporal-consistency or scale figures at all, or doing
any of it model-free and reproducibly. The §2 rows from agentmemory's report
stay on the board as context, in their own table, not as a ranking.
