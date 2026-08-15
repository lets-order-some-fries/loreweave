# External benchmarks

The three corpora in `eval/run.mjs` are ours — we wrote the notes *and* the
questions. That makes them good for regression and worthless as evidence that
the engine is any good, because we chose the exam. These are the public ones,
with third-party relevance labels and published baselines.

Everything here is reproducible: download the dataset, run one command.

## Reproduce

```bash
npm run build

# BEIR / SciFact — the standard IR benchmark (published BM25: nDCG@10 0.665)
curl -sLO https://public.ukp.informatik.tu-darmstadt.de/thakur/BEIR/datasets/scifact.zip
unzip -q scifact.zip
node eval/beir.mjs ./scifact

# LongMemEval (ICLR 2025) — 500 questions, ~50-session history each
curl -sL -o longmemeval_s \
  https://huggingface.co/datasets/xiaowu0162/longmemeval/resolve/main/longmemeval_s
node --max-old-space-size=8192 eval/longmemeval.mjs ./longmemeval_s

# LoCoMo — 10 long conversations, turn-level evidence labels
curl -sLO https://raw.githubusercontent.com/snap-research/locomo/main/data/locomo10.json
node eval/locomo.mjs ./locomo10.json
```

## What is being measured

loreweave is a **retrieval** engine: it finds the evidence, it does not write
the answer. So these report retrieval metrics, not QA accuracy — the same
quantity each benchmark's own retrieval ablations report. Numbers here are
**not comparable to end-to-end QA scores** quoted by systems that put an LLM
after retrieval; those measure a different thing, and comparing them would be
the kind of apples-to-oranges claim this file exists to avoid.

Runs default to the **model-free configuration**: no LLM, no embeddings, no
network. That is the floor, and the floor is what ships by default. Append
`--embed` to any harness to add local dense vectors (Ollama +
`nomic-embed-text`) — measured on SciFact that takes nDCG@10 from 0.682 to
**0.729**, at roughly 9× the per-query cost (12 ms → 106 ms).

## Adapting the data

- **BEIR**: each document becomes a note (title as `# H1`, body as prose).
- **LongMemEval**: each session becomes a note dated with its real timestamp;
  the task is finding the session(s) holding the evidence.
- **LoCoMo**: each conversational turn becomes a note dated by its session;
  evidence labels are turn-level (`D1:3`), so retrieval is scored per turn.

These are honest translations, and they are also handicaps worth stating:
**none of these corpora have links, tags, or frontmatter** — the structure
loreweave exists to exploit. A vault engine on a link-free corpus is working
with one hand tied. That is precisely why the results were worth measuring:
they exposed a real defect (the graph channel was trusted even with no graph
to walk), which is fixed in 0.32.0 and improved every external number.
