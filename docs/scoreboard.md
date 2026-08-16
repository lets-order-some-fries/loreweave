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

| system | R@5 | questions | source |
|---|---|---|---|
| MemPalace raw (vector-only) | 96.6% | 500 | [agentmemory][lme] |
| **loreweave, chunked + mxbai-embed-large** | **95.9%** | **all 500** | `--chunk=8 --embed --model=mxbai-embed-large` |
| agentmemory BM25+Vector hybrid | 95.2% | 500 | [agentmemory][lme] |
| loreweave, chunked + nomic-embed-text | 94.7%* | 100 | `--stride=5 --chunk=8 --embed` |
| loreweave + embeddings (nomic) | 94.4%* | 100 | `--stride=5 --embed` |
| loreweave + embeddings + reranking | 93.6%* | 100 | `--stride=5 --embed --rerank` |
| loreweave, chunked, model-free | 92.6%* | 100 | `--stride=5 --chunk=8` |
| loreweave, model-free | 89.9% | all 500 | — |
| agentmemory BM25-only | 86.2% | 500 | [agentmemory][lme] |

[lme]: https://github.com/rohitg00/agentmemory/blob/main/benchmark/LONGMEMEVAL.md

Full run, all 500 questions: R@1 0.590 · R@3 0.897 · **R@5 0.959** · R@10 0.983.

**The two columns are not computed identically, and the difference favours
them.** The published figures use `recall_any@K` — a question scores 1 if *any*
gold session appears in the top K. loreweave's harness scores the *fraction* of
gold sessions retrieved (`found / gold.size`), so a question with three gold
sessions and two retrieved scores 0.67 here and 1.0 there. The two definitions
coincide only where a question has a single gold session. Our number is
therefore the conservative one: under `recall_any@5` loreweave would score at
or above 95.9%, never below. The comparison is left in the stricter form rather
than restated in the flattering one, but no claim here should be read as
precise to a tenth of a point across systems.

**Status: ahead of the published hybrid, behind the pure-vector system** — with
the metric caveat above, which means the gap to the hybrid is real but its size
is not precise. Every earlier version of this file discounted the
sampled figures by ~3 points, on the evidence of the single arm then measured
both ways (92.8% sampled vs 89.9% full). **That correction did not generalise:**
the best configuration scored 96.0% sampled and 95.9% on the full 500, so the
stratified sample was accurate to a tenth of a point here. Starred figures above
are still 100-question samples and are left starred rather than silently
promoted.

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

The target this board was written to set — **§2: LongMemEval_S R@5 ≥ 95.2% on
the full 500** — is **met, at 95.9%**. Of five sections, three are won, one is
uncontested, and one has no valid comparison to make.

**Where that leaves the claim.** Still not "best in the market", and this file
still will not say it. One system on this board is ahead of us: MemPal reports
96.6% on §2, and we are 0.7 points behind it. What the numbers do support is
narrower and more defensible — loreweave beats the published BM25+vector hybrid
on conversational recall and the classical baseline on document retrieval, and
it is the only system here publishing temporal-consistency or scale figures at
all, or doing any of it model-free and reproducibly. A board that dropped the
MemPal row on the day we passed the hybrid would be advertising, not measurement.

**What is worth doing next**, in order of expected value: §1 and §3 were both
measured with the *small* embedder, and the model swap that won §2 was worth
+1.3 points there, so those numbers likely understate the engine and should be
re-run with `--model=mxbai-embed-large` before anyone quotes them. §3 still has
no comparable third-party retrieval number to beat, which is a gap in the
field rather than in this engine.
