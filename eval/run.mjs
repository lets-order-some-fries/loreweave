/**
 * Loreweave retrieval-quality benchmark.
 *
 *   npm run eval            # table
 *   npm run eval -- --json  # machine-readable
 *   npm run eval -- --gate  # exit non-zero if below the committed baseline
 *
 * Measures three systems over a purpose-built 100-note vault with deliberate
 * link discipline (multi-hop answers share NO vocabulary with the query):
 *
 *   hybrid     — the shipped pipeline (BM25 + graph PPR fusion)
 *   bm25       — lexical only, the honest baseline the graph must beat
 *   graph      — PPR only, to see what the graph contributes alone
 *
 * The point of this harness is to make "the graph earns its complexity" a
 * measured claim rather than an assertion. If hybrid does not beat bm25,
 * that is a finding, not a bug in the harness.
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const VAULT = join(HERE, 'vault');
const DEPTH = 50;

const args = new Set(process.argv.slice(2));
const asJson = args.has('--json');
const gate = args.has('--gate');
const log = (...a) => {
  if (!asJson) console.log(...a);
};

const dist = join(REPO, 'dist/index.js');
if (!existsSync(dist)) {
  console.error('dist/ not built — run `npm run build` first.');
  process.exit(2);
}
const { openContext, indexVault, search, ppr, matchQueryEntities } = await import(dist);
const { buildVault } = await import('./gen/build-vault.mjs');
const { questions } = await import('./questions.mjs');

// ── corpus ────────────────────────────────────────────────────────────────
rmSync(VAULT, { recursive: true, force: true });
buildVault(VAULT);
mkdirSync(join(VAULT, '.lore'), { recursive: true });

const ctx = openContext(VAULT);
const t0 = Date.now();
const report = await indexVault(ctx.store, VAULT, { full: true });
ctx.invalidateGraph();
const indexMs = Date.now() - t0;
const db = ctx.store.db;
const one = (sql) => db.prepare(sql).get().c;
const graph = ctx.graph();
const corpus = {
  notes: one('SELECT COUNT(*) c FROM notes'),
  blocks: one('SELECT COUNT(*) c FROM blocks'),
  entities: one('SELECT COUNT(*) c FROM entities'),
  links: one('SELECT COUNT(*) c FROM links'),
  facts: one('SELECT COUNT(*) c FROM facts'),
  edges: graph.neighbors.length / 2,
  indexMs,
  warnings: report.warnings.length,
};

const blockMeta = new Map(
  db
    .prepare('SELECT id, note_path, anchor, text FROM blocks')
    .all()
    .map((r) => [r.id, { notePath: r.note_path, anchor: r.anchor, text: r.text }]),
);

// ── the three systems ─────────────────────────────────────────────────────
async function hybrid(q) {
  const res = await search(ctx, q, { k: DEPTH, noLog: true });
  return res.map((r) => ({
    notePath: r.notePath,
    anchor: r.anchor,
    text:
      db.prepare('SELECT text FROM blocks WHERE note_path=? AND anchor=?').get(r.notePath, r.anchor)
        ?.text ?? '',
  }));
}

function bm25(q) {
  return ctx.store.searchLexical(q, DEPTH).map((h) => ({
    notePath: h.notePath,
    anchor: h.anchor,
    text: blockMeta.get(h.blockId)?.text ?? '',
  }));
}

function graphOnly(q) {
  const g = ctx.graph();
  const matched = matchQueryEntities(q, g.entityKeyIndex);
  if (matched.size === 0) return [];
  const seeds = new Map();
  for (const [idx, m] of matched) seeds.set(idx, m.mass * 2);
  const scores = ppr(g, seeds, {
    alpha: ctx.config.retrieval.pprAlpha,
    iterations: ctx.config.retrieval.pprIterations,
  });
  const out = [];
  for (let i = 0; i < g.blockCount; i++) if (scores[i] > 0) out.push({ i, s: scores[i] });
  out.sort((a, b) => b.s - a.s);
  return out.slice(0, DEPTH).map(({ i }) => blockMeta.get(g.nodeDbId[i]));
}

// ── scoring ───────────────────────────────────────────────────────────────
/** Collapse a block ranking to a note ranking (first appearance wins). */
function noteRanking(hits) {
  const seen = new Set();
  const out = [];
  for (const h of hits) {
    if (!h || seen.has(h.notePath)) continue;
    seen.add(h.notePath);
    out.push(h.notePath);
  }
  return out;
}

function scoreOne(hits, q) {
  const notes = noteRanking(hits);
  let rank = 0;
  for (let i = 0; i < notes.length; i++) {
    if (q.gold.includes(notes[i])) {
      rank = i + 1;
      break;
    }
  }
  // Did we return the block that literally states the answer?
  let answerRank = 0;
  if (q.answer) {
    const needle = q.answer.toLowerCase();
    for (let i = 0; i < hits.length; i++) {
      const h = hits[i];
      if (h && q.gold.includes(h.notePath) && (h.text ?? '').toLowerCase().includes(needle)) {
        answerRank = i + 1;
        break;
      }
    }
  }
  return { rank, answerRank };
}

const SYSTEMS = { hybrid, bm25, graph: graphOnly };
const cats = [...new Set(questions.map((q) => q.cat))];
const results = {};
const perQuestion = [];

for (const [name, fn] of Object.entries(SYSTEMS)) {
  results[name] = {};
  for (const cat of cats) results[name][cat] = { n: 0, r1: 0, r5: 0, mrr: 0, ans5: 0 };
  for (const q of questions) {
    const hits = await fn(q.q);
    const { rank, answerRank } = scoreOne(hits, q);
    const bucket = results[name][q.cat];
    bucket.n++;
    if (rank === 1) bucket.r1++;
    if (rank > 0 && rank <= 5) bucket.r5++;
    if (rank > 0) bucket.mrr += 1 / rank;
    if (answerRank > 0 && answerRank <= 5) bucket.ans5++;
    perQuestion.push({ system: name, id: q.id, cat: q.cat, rank, answerRank });
  }
}

const overall = {};
for (const name of Object.keys(SYSTEMS)) {
  const agg = { n: 0, r1: 0, r5: 0, mrr: 0, ans5: 0 };
  for (const cat of cats) {
    const b = results[name][cat];
    agg.n += b.n;
    agg.r1 += b.r1;
    agg.r5 += b.r5;
    agg.mrr += b.mrr;
    agg.ans5 += b.ans5;
    // normalize per-category in place
    results[name][cat] = {
      n: b.n,
      'r@1': +(b.r1 / b.n).toFixed(3),
      'r@5': +(b.r5 / b.n).toFixed(3),
      mrr: +(b.mrr / b.n).toFixed(3),
      'ans@5': +(b.ans5 / b.n).toFixed(3),
    };
  }
  overall[name] = {
    n: agg.n,
    'r@1': +(agg.r1 / agg.n).toFixed(3),
    'r@5': +(agg.r5 / agg.n).toFixed(3),
    mrr: +(agg.mrr / agg.n).toFixed(3),
    'ans@5': +(agg.ans5 / agg.n).toFixed(3),
  };
}

ctx.close();
rmSync(join(VAULT, '.lore'), { recursive: true, force: true });

// ── output ────────────────────────────────────────────────────────────────
const payload = { corpus, overall, byCategory: results, perQuestion };

if (asJson) {
  console.log(JSON.stringify(payload, null, 2));
} else {
  log(
    `\ncorpus: ${corpus.notes} notes · ${corpus.blocks} blocks · ${corpus.entities} entities · ` +
      `${corpus.links} links · ${corpus.edges} edges · ${corpus.facts} facts · indexed in ${corpus.indexMs}ms\n`,
  );
  const pad = (s, n) => String(s).padEnd(n);
  const num = (v) => String(v.toFixed(3)).padStart(6);
  for (const cat of [...cats, 'OVERALL']) {
    log(`── ${cat} ${'─'.repeat(Math.max(0, 46 - cat.length))}`);
    log(`   ${pad('system', 10)}${pad('r@1', 8)}${pad('r@5', 8)}${pad('mrr', 8)}${pad('ans@5', 8)}`);
    for (const name of Object.keys(SYSTEMS)) {
      const m = cat === 'OVERALL' ? overall[name] : results[name][cat];
      log(
        `   ${pad(name, 10)}${num(m['r@1'])}  ${num(m['r@5'])}  ${num(m.mrr)}  ${num(m['ans@5'])}`,
      );
    }
    log('');
  }
  const delta = overall.hybrid.mrr - overall.bm25.mrr;
  log(
    delta >= 0
      ? `✓ hybrid beats BM25 by ${delta.toFixed(3)} MRR — the graph earns its complexity`
      : `✗ hybrid LOSES to BM25 by ${(-delta).toFixed(3)} MRR — the graph is currently a net negative`,
  );
}

writeFileSync(join(HERE, 'last-run.json'), JSON.stringify(payload, null, 2) + '\n');

// ── regression gate ───────────────────────────────────────────────────────
if (gate) {
  const baselinePath = join(HERE, 'baseline.json');
  if (!existsSync(baselinePath)) {
    console.error('no eval/baseline.json — record one with: npm run eval:baseline');
    process.exit(2);
  }
  const baseline = JSON.parse(await import('node:fs').then((fs) => fs.readFileSync(baselinePath, 'utf8')));
  const TOL = 0.02;
  let failed = false;
  for (const name of Object.keys(SYSTEMS)) {
    for (const metric of ['r@1', 'r@5', 'mrr', 'ans@5']) {
      const now = overall[name][metric];
      const was = baseline.overall?.[name]?.[metric];
      if (was === undefined) continue;
      if (now < was - TOL) {
        console.error(`REGRESSION ${name}.${metric}: ${was} → ${now}`);
        failed = true;
      }
    }
  }
  if (failed) process.exit(1);
  log('✓ no regression against eval/baseline.json');
}
