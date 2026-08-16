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

Add `--embed` for the local-embedding arm, `--model=NAME` to pick the model
(`mxbai-embed-large` is the strongest we have measured; the default is
`nomic-embed-text`), and `--stride=N` to sample every Nth question. Sample with
a stride rather than a `limit`: the file is grouped by category, so the first N
questions are all one category and report a number that looks like the whole
benchmark.

### Restart the embedding server before a long run

**`ollama serve` degrades over hours of serving.** A full 500-question run that
had been managing 25 questions per 16 minutes dropped to 25 per *67* against a
server that had been up half a day — the embedding server was busy only 5% of
the time, and the run was simply waiting on it. Restarting `ollama serve`
restored the original rate exactly, with no other change.

Nothing in the totals would have shown this, which is why the client logs every
retry: a run that is silently waiting looks identical to one that is merely
slow. If `[loreweave] ... retrying in` starts appearing during a long index,
the server is stalling and wants a restart rather than a bigger
`embedding.timeoutMs`.

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
