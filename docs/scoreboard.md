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
| **loreweave + embeddings** | **94.4%*** | `bench:longmemeval -- --stride=5 --embed` |
| loreweave, model-free | 89.9% | full 500 questions |
| BM25 alone | 86.2% | third-party benchmark repo |

\* 100-question stratified sample, which runs ~3 points above the full set
(92.8% vs 89.9% model-free on the same arm) — so the true full-set figure with
embeddings is nearer 91–92%.

**Status: not yet.** Clearly ahead of lexical-only retrieval, still behind
hybrid systems. **This is the open target: R@5 ≥ 95.2% on the full 500.**

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
