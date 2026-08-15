/**
 * External benchmark: BEIR, scored with published baselines to compare against.
 *
 *   node eval/beir.mjs /path/to/scifact
 *
 * The three corpora in eval/run.mjs are ours — we wrote the notes AND the
 * questions, which makes them useful for regression and useless for "is this
 * actually good". BEIR is the standard retrieval benchmark, its qrels are
 * third-party, and its BM25 baselines are published, so this measures
 * loreweave against a number nobody here chose:
 *
 *   SciFact   BM25 (BEIR paper, Anserini)  nDCG@10 0.665
 *   NFCorpus  BM25                         nDCG@10 0.325
 *
 * It also runs loreweave's OWN lexical channel over the same data, which
 * answers a second question the private corpora cannot: is the FTS5 setup
 * competitive with a real BM25 implementation, or is the graph compensating
 * for a weak lexical baseline?
 *
 * Caveat stated up front: BEIR documents are abstracts with no links, tags,
 * frontmatter, or dates — none of the structure loreweave is built to exploit.
 * A vault engine on a link-free corpus is being measured with one hand tied,
 * and that is exactly why the comparison is worth publishing rather than
 * hiding.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const DATA = process.argv[2];
if (!DATA || !existsSync(join(DATA, 'corpus.jsonl'))) {
  console.error('usage: node eval/beir.mjs /path/to/beir-dataset   (needs corpus.jsonl, queries.jsonl, qrels/test.tsv)');
  process.exit(2);
}
const dist = join(REPO, 'dist/index.js');
if (!existsSync(dist)) {
  console.error('dist/ not built — run `npm run build` first.');
  process.exit(2);
}
const WITH_EMBED = process.argv.includes('--embed');
const WITH_RERANK = process.argv.includes('--rerank');
const { openContext, indexVault, search, embedMissingBlocks, buildSimilarEdges } = await import(pathToFileURL(dist).href);

const lines = (f) => readFileSync(f, 'utf8').split('\n').filter(Boolean);

// ── load ──────────────────────────────────────────────────────────────────
const corpus = lines(join(DATA, 'corpus.jsonl')).map((l) => JSON.parse(l));
const queries = new Map(lines(join(DATA, 'queries.jsonl')).map((l) => {
  const q = JSON.parse(l);
  return [String(q._id), q.text];
}));
const qrels = new Map(); // qid -> Map(docId -> rel)
for (const row of lines(join(DATA, 'qrels/test.tsv')).slice(1)) {
  const [qid, did, rel] = row.split('\t');
  const r = Number(rel);
  if (!r) continue;
  const m = qrels.get(qid) ?? new Map();
  m.set(did, r);
  qrels.set(qid, m);
}
console.log(`corpus ${corpus.length} docs · ${qrels.size} scored queries`);

// ── build a vault out of it ───────────────────────────────────────────────
// Per-process so concurrent arms (--embed, --rerank) cannot delete each
// other's files mid-write. See the note in longmemeval.mjs.
const VAULT = join(tmpdir(), `beir-vault-${process.pid}`);
process.on('exit', () => {
  try {
    rmSync(VAULT, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});
rmSync(VAULT, { recursive: true, force: true });
mkdirSync(join(VAULT, 'docs'), { recursive: true });
const pathToDoc = new Map();
for (const d of corpus) {
  const rel = `docs/${d._id}.md`;
  pathToDoc.set(rel, String(d._id));
  const title = (d.title || `Document ${d._id}`).replace(/\n/g, ' ');
  writeFileSync(join(VAULT, rel), `# ${title}\n\n${d.text ?? ''}\n`);
}
mkdirSync(join(VAULT, '.lore'), { recursive: true });
  const cfgObj = {};
  if (WITH_EMBED) {
    cfgObj.embedding = { provider: 'ollama', model: 'nomic-embed-text', url: 'http://localhost:11434' };
  }
  if (WITH_RERANK) {
    cfgObj.rerank = { provider: 'transformers', model: 'Xenova/ms-marco-MiniLM-L-6-v2', topK: 30 };
  }
  if (Object.keys(cfgObj).length) {
    writeFileSync(join(VAULT, '.lore', 'config.json'), JSON.stringify(cfgObj, null, 2));
  }

const ctx = openContext(VAULT);
const t0 = Date.now();
await indexVault(ctx.store, VAULT, { full: true });
if (WITH_EMBED) {
  if (!ctx.provider) { console.error('--embed: no provider (is Ollama running?)'); process.exit(2); }
  await embedMissingBlocks(ctx.store, ctx.provider, ctx.config.embedding.batchSize);
  buildSimilarEdges(ctx.store, ctx.config);
}
ctx.invalidateGraph();
console.log(`indexed in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

// ── metrics ───────────────────────────────────────────────────────────────
const K = 10;
function ndcgAt(rankedDocs, rels, k) {
  let dcg = 0;
  for (let i = 0; i < Math.min(k, rankedDocs.length); i++) {
    const rel = rels.get(rankedDocs[i]) ?? 0;
    if (rel) dcg += (2 ** rel - 1) / Math.log2(i + 2);
  }
  const ideal = [...rels.values()].sort((a, b) => b - a).slice(0, k);
  let idcg = 0;
  ideal.forEach((rel, i) => (idcg += (2 ** rel - 1) / Math.log2(i + 2)));
  return idcg > 0 ? dcg / idcg : 0;
}
const recallAt = (rankedDocs, rels, k) => {
  const hit = rankedDocs.slice(0, k).filter((d) => rels.has(d)).length;
  return rels.size ? hit / rels.size : 0;
};

const blockMeta = new Map(
  ctx.store.db.prepare('SELECT id, note_path FROM blocks').all().map((r) => [r.id, r.note_path]),
);
const dedupe = (paths) => {
  const seen = new Set();
  const out = [];
  for (const p of paths) {
    const d = pathToDoc.get(p);
    if (!d || seen.has(d)) continue;
    seen.add(d);
    out.push(d);
  }
  return out;
};

const withWeights = (over) => ({
  ...ctx,
  config: { ...ctx.config, retrieval: { ...ctx.config.retrieval, weights: { ...ctx.config.retrieval.weights, ...over } } },
});
const systems = {
  hybrid: async (q) => dedupe((await search(ctx, q, { k: K, noLog: true })).map((r) => r.notePath)),
  'hybrid−graph': async (q) =>
    dedupe((await search(withWeights({ graph: 0 }), q, { k: K, noLog: true })).map((r) => r.notePath)),
  'hybrid−graph−exp': async (q) =>
    dedupe((await search(withWeights({ graph: 0, expansion: 0 }), q, { k: K, noLog: true })).map((r) => r.notePath)),
  'lexical only': (q) =>
    dedupe(ctx.store.searchLexical(q, 100).map((h) => blockMeta.get(h.blockId)).filter(Boolean)),
};

const scores = {};
for (const [name, fn] of Object.entries(systems)) {
  let ndcg = 0;
  let recall = 0;
  let n = 0;
  const t = Date.now();
  for (const [qid, rels] of qrels) {
    const text = queries.get(qid);
    if (!text) continue;
    const ranked = await fn(text);
    ndcg += ndcgAt(ranked, rels, K);
    recall += recallAt(ranked, rels, K);
    n++;
  }
  scores[name] = {
    ndcg10: +(ndcg / n).toFixed(4),
    recall10: +(recall / n).toFixed(4),
    queries: n,
    msPerQuery: +((Date.now() - t) / n).toFixed(1),
  };
}

console.log('\n══ BEIR ════════════════════════════════════════════');
console.log(`  ${'system'.padEnd(16)}${'nDCG@10'.padStart(9)}${'Recall@10'.padStart(11)}${'ms/query'.padStart(10)}`);
for (const [name, s] of Object.entries(scores)) {
  console.log(`  ${name.padEnd(16)}${String(s.ndcg10).padStart(9)}${String(s.recall10).padStart(11)}${String(s.msPerQuery).padStart(10)}`);
}
console.log('');
ctx.close();
rmSync(VAULT, { recursive: true, force: true });
writeFileSync(join(HERE, 'beir-last.json'), JSON.stringify(scores, null, 2) + '\n');
