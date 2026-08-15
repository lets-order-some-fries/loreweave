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
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const VAULT = join(HERE, 'vault');
const DEPTH = 50;

const args = new Set(process.argv.slice(2));
const asJson = args.has('--json');
const gate = args.has('--gate');
// --embed measures the CEILING: the same corpora with local dense embeddings
// enabled. Everything the README publishes is the FLOOR (lexical + graph, no
// models), which is the honest default but says nothing about how much the
// optional layer is worth. Requires a local Ollama with nomic-embed-text.
const withEmbed = args.has('--embed');
const withRerank = args.has('--rerank');
const log = (...a) => {
  if (!asJson) console.log(...a);
};

const dist = join(REPO, 'dist/index.js');
if (!existsSync(dist)) {
  console.error('dist/ not built — run `npm run build` first.');
  process.exit(2);
}
// Dynamic import of an ABSOLUTE path must go through a file:// URL: on
// Windows, `D:\...` is parsed as protocol "d:" and rejected by the ESM loader.
const { openContext, indexVault, search, ppr, matchQueryEntities, embedMissingBlocks, buildSimilarEdges } =
  await import(pathToFileURL(dist).href);
// Two corpora. The second exists to catch overfitting: same shipped config,
// a vault with different link syntax, note shapes and vocabulary. A config
// tuned to one benchmark will win there and lose here.
const CORPORA = [
  {
    name: 'kestrel',
    dir: 'vault',
    build: (await import('./gen/build-vault.mjs')).buildVault,
    questions: (await import('./questions.mjs')).questions,
  },
  {
    name: 'northwind',
    dir: 'vault2',
    build: (await import('./gen/build-vault2.mjs')).buildVault2,
    questions: (await import('./questions2.mjs')).questions,
  },
  // The third corpus measures TIME, not topicality: facts change across
  // dated notes, dates live only in frontmatter (invisible to BM25), and
  // the flip category perturbs each window so lexical pattern-matching can
  // score at most half of it.
  {
    name: 'meridian',
    dir: 'vault3',
    build: (await import('./gen/build-vault3.mjs')).buildVault3,
    questions: (await import('./questions3.mjs')).questions,
  },
];

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

// ── one corpus ────────────────────────────────────────────────────────────
async function evaluate(corpus) {
  const VAULT = join(HERE, corpus.dir);
  rmSync(VAULT, { recursive: true, force: true });
  corpus.build(VAULT);
  mkdirSync(join(VAULT, '.lore'), { recursive: true });
  const cfgObj = {};
  if (withEmbed) {
    cfgObj.embedding = { provider: 'ollama', model: 'nomic-embed-text', url: 'http://localhost:11434' };
  }
  if (withRerank) {
    cfgObj.rerank = { provider: 'transformers', model: 'Xenova/ms-marco-MiniLM-L-6-v2', topK: 30 };
  }
  if (Object.keys(cfgObj).length) {
    writeFileSync(join(VAULT, '.lore', 'config.json'), JSON.stringify(cfgObj, null, 2));
  }

  const ctx = openContext(VAULT);
  const t0 = Date.now();
  const report = await indexVault(ctx.store, VAULT, { full: true });
  let embedMs = 0;
  if (withEmbed) {
    if (!ctx.provider) {
      console.error('--embed asked for, but no embedding provider resolved (is Ollama running?)');
      process.exit(2);
    }
    const te = Date.now();
    await embedMissingBlocks(ctx.store, ctx.provider, ctx.config.embedding.batchSize);
    buildSimilarEdges(ctx.store, ctx.config);
    embedMs = Date.now() - te;
  }
  ctx.invalidateGraph();
  const indexMs = Date.now() - t0;
  const db = ctx.store.db;
  const one = (sql) => db.prepare(sql).get().c;
  const graph = ctx.graph();
  const stats = {
    notes: one('SELECT COUNT(*) c FROM notes'),
    blocks: one('SELECT COUNT(*) c FROM blocks'),
    entities: one('SELECT COUNT(*) c FROM entities'),
    links: one('SELECT COUNT(*) c FROM links'),
    facts: one('SELECT COUNT(*) c FROM facts'),
    edges: graph.neighbors.length / 2,
    indexMs,
    embedMs,
    warnings: report.warnings.length,
  };

  const blockMeta = new Map(
    db.prepare('SELECT id, note_path, anchor, text FROM blocks').all()
      .map((r) => [r.id, { notePath: r.note_path, anchor: r.anchor, text: r.text }]),
  );

  const hybrid = async (q) => {
    const res = await search(ctx, q, { k: DEPTH, noLog: true });
    return res.map((r) => ({
      notePath: r.notePath,
      anchor: r.anchor,
      text: db.prepare('SELECT text FROM blocks WHERE note_path=? AND anchor=?')
        .get(r.notePath, r.anchor)?.text ?? '',
    }));
  };
  const bm25 = (q) =>
    ctx.store.searchLexical(q, DEPTH).map((h) => ({
      notePath: h.notePath, anchor: h.anchor, text: blockMeta.get(h.blockId)?.text ?? '',
    }));
  const graphOnly = (q) => {
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
  };

  // Ablations: the same pipeline with one recall channel switched off. The
  // harness has always shown that hybrid beats BM25; it never showed which
  // PART of hybrid earned that, so a channel could quietly contribute nothing
  // and the headline number would look identical.
  const withWeights = (over) => ({
    ...ctx,
    config: {
      ...ctx.config,
      retrieval: {
        ...ctx.config.retrieval,
        weights: { ...ctx.config.retrieval.weights, ...over },
      },
    },
  });
  const ablate = (over) => async (q) => {
    const res = await search(withWeights(over), q, { k: DEPTH, noLog: true });
    return res.map((r) => ({
      notePath: r.notePath,
      anchor: r.anchor,
      text: blockMeta.get(
        db.prepare('SELECT id FROM blocks WHERE note_path=? AND anchor=?')
          .get(r.notePath, r.anchor)?.id,
      )?.text ?? '',
    }));
  };

  const SYSTEMS = {
    hybrid,
    bm25,
    graph: graphOnly,
    'hybrid−graph': ablate({ graph: 0 }),
    'hybrid−expand': ablate({ expansion: 0 }),
    // With --embed, sweep the dense weight: the default 1.0 gives the dense
    // list the same say as BM25, and an untuned weight is the first thing to
    // suspect when an optional channel makes results worse.
    ...(withEmbed
      ? {
          'dense=2.0': ablate({ dense: 2.0 }),
          'dense=1.5': ablate({ dense: 1.5 }),
          'dense=0.5': ablate({ dense: 0.5 }),
          'dense=0': ablate({ dense: 0 }),
        }
      : {}),
  };
  const cats = [...new Set(corpus.questions.map((q) => q.cat))];
  const results = {};
  const perQuestion = [];
  for (const [name, fn] of Object.entries(SYSTEMS)) {
    results[name] = {};
    for (const cat of cats) results[name][cat] = { n: 0, r1: 0, r5: 0, mrr: 0, ans5: 0, found: 0 };
    for (const q of corpus.questions) {
      const hits = await fn(q.q);
      const { rank, answerRank } = scoreOne(hits, q);
      const b = results[name][q.cat];
      b.n++;
      if (rank === 1) b.r1++;
      if (rank > 0 && rank <= 5) b.r5++;
      if (rank > 0) { b.mrr += 1 / rank; b.found++; }
      if (answerRank > 0 && answerRank <= 5) b.ans5++;
      perQuestion.push({ corpus: corpus.name, system: name, id: q.id, cat: q.cat, rank, answerRank });
    }
  }

  const overall = {};
  for (const name of Object.keys(SYSTEMS)) {
    const agg = { n: 0, r1: 0, r5: 0, mrr: 0, ans5: 0, found: 0 };
    for (const cat of cats) {
      const b = results[name][cat];
      agg.n += b.n; agg.r1 += b.r1; agg.r5 += b.r5;
      agg.mrr += b.mrr; agg.ans5 += b.ans5; agg.found += b.found;
      results[name][cat] = {
        n: b.n,
        'r@1': +(b.r1 / b.n).toFixed(3),
        'r@5': +(b.r5 / b.n).toFixed(3),
        mrr: +(b.mrr / b.n).toFixed(3),
        'ans@5': +(b.ans5 / b.n).toFixed(3),
        found: +(b.found / b.n).toFixed(3),
      };
    }
    overall[name] = {
      n: agg.n,
      'r@1': +(agg.r1 / agg.n).toFixed(3),
      'r@5': +(agg.r5 / agg.n).toFixed(3),
      mrr: +(agg.mrr / agg.n).toFixed(3),
      'ans@5': +(agg.ans5 / agg.n).toFixed(3),
      found: +(agg.found / agg.n).toFixed(3),
    };
  }

  // Paired temporal consistency (TempRAGEval's discipline): a flip pair is
  // the same question with a shifted window and a DIFFERENT correct note; a
  // system is consistent on the pair only when BOTH directions rank their
  // answer first. Lexical overlap can carry one direction; only real
  // time-scoping carries both.
  const flipConsistency = {};
  const flipQs = corpus.questions.filter((q) => q.cat === 'flip');
  if (flipQs.length) {
    const pairOf = (id) => id.replace(/[ab]$/, '');
    for (const name of Object.keys(SYSTEMS)) {
      const ranks = new Map(
        perQuestion
          .filter((p) => p.system === name && p.cat === 'flip')
          .map((p) => [p.id, p.rank]),
      );
      const pairs = new Map();
      for (const q of flipQs) {
        const key = pairOf(q.id);
        const list = pairs.get(key) ?? [];
        list.push(ranks.get(q.id) ?? 0);
        pairs.set(key, list);
      }
      let consistent = 0;
      for (const rs of pairs.values()) {
        if (rs.length === 2 && rs.every((r) => r === 1)) consistent++;
      }
      flipConsistency[name] = +(consistent / pairs.size).toFixed(3);
    }
  }

  ctx.close();
  rmSync(join(VAULT, '.lore'), { recursive: true, force: true });
  return { name: corpus.name, corpus: stats, overall, byCategory: results, perQuestion, cats, flipConsistency };
}

const runs = [];
for (const c of CORPORA) runs.push(await evaluate(c));

// ── output ────────────────────────────────────────────────────────────────
const SYSTEM_NAMES = ['hybrid', 'bm25', 'graph'];
const payload = {
  corpora: Object.fromEntries(
    runs.map((r) => [
      r.name,
      {
        corpus: r.corpus,
        overall: r.overall,
        byCategory: r.byCategory,
        ...(r.flipConsistency && Object.keys(r.flipConsistency).length
          ? { flipConsistency: r.flipConsistency }
          : {}),
      },
    ]),
  ),
  perQuestion: runs.flatMap((r) => r.perQuestion),
};

if (asJson) {
  console.log(JSON.stringify(payload, null, 2));
} else {
  const pad = (s, n) => String(s).padEnd(n);
  const num = (v) => String(v.toFixed(3)).padStart(6);
  for (const run of runs) {
    const c = run.corpus;
    log(
      `\n══ ${run.name} ══  ${c.notes} notes · ${c.blocks} blocks · ${c.entities} entities · ` +
        `${c.links} links · ${c.edges} edges · ${c.facts} facts · ${c.indexMs}ms\n`,
    );
    for (const cat of [...run.cats, 'OVERALL']) {
      log(`── ${cat} ${'─'.repeat(Math.max(0, 44 - cat.length))}`);
      log(
        `   ${pad('system', 10)}${pad('r@1', 8)}${pad('r@5', 8)}${pad('mrr', 8)}${pad('ans@5', 8)}${pad('found', 8)}`,
      );
      for (const name of SYSTEM_NAMES) {
        const m = cat === 'OVERALL' ? run.overall[name] : run.byCategory[name][cat];
        if (!m) continue;
        log(
          `   ${pad(name, 10)}${num(m['r@1'])}  ${num(m['r@5'])}  ${num(m.mrr)}  ${num(m['ans@5'])}  ${num(m.found)}`,
        );
      }
      log('');
    }
  }

  for (const run of runs) {
    if (run.flipConsistency && Object.keys(run.flipConsistency).length) {
      log('══ temporal consistency under window perturbation ══════════');
      for (const name of SYSTEM_NAMES) {
        const v = run.flipConsistency[name];
        if (v !== undefined) log(`  ${pad(run.name, 11)} ${pad(name, 10)} ${(v * 100).toFixed(0)}% of flip pairs answered correctly BOTH ways`);
      }
      log('');
    }
  }

  // The generalization question: does the SAME config win on both corpora?
  log('══ generalization ══════════════════════════════════════════');
  let winsAll = true;
  for (const run of runs) {
    const dMrr = run.overall.hybrid.mrr - run.overall.bm25.mrr;
    const dFound = run.overall.hybrid.found - run.overall.bm25.found;
    const mh = run.byCategory.hybrid.multihop;
    const mhB = run.byCategory.bm25.multihop;
    if (dMrr < 0 || dFound < 0) winsAll = false;
    log(
      `  ${pad(run.name, 11)} reach ${(run.overall.hybrid.found * 100).toFixed(0)}% vs ${(run.overall.bm25.found * 100).toFixed(0)}% ` +
        `(${dFound >= 0 ? '+' : ''}${(dFound * 100).toFixed(0)} pts) · ` +
        `MRR ${dMrr >= 0 ? '+' : ''}${dMrr.toFixed(3)}` +
        (mh && mhB ? ` · multihop reach ${(mh.found * 100).toFixed(0)}% vs ${(mhB.found * 100).toFixed(0)}%` : ''),
    );
  }
  // What each recall channel is actually worth. The comparison above shows
  // that hybrid beats BM25; it never showed which PART of hybrid earned it, so
  // a channel could contribute nothing and the headline number would be
  // unchanged. Deliberately NOT part of the regression gate: improving the
  // graph channel should make `hybrid−graph` fall, and that is progress, not a
  // regression.
  log('');
  log('══ channel contribution (ablation) ═════════════════════════');
  for (const run of runs) {
    const full = run.overall.hybrid;
    for (const [label, key] of [
      ['entity-PPR    ', 'hybrid−graph'],
      ['link expansion', 'hybrid−expand'],
    ]) {
      const off = run.overall[key];
      if (!full || !off) continue;
      const dFound = (full.found - off.found) * 100;
      const dMrr = full.mrr - off.mrr;
      log(
        `  ${run.name.padEnd(11)} ${label}  reach ${dFound >= 0 ? '+' : ''}${dFound.toFixed(0)} pts` +
          ` · MRR ${dMrr >= 0 ? '+' : ''}${dMrr.toFixed(3)}   (without it: ${(off.found * 100).toFixed(0)}% / ${off.mrr.toFixed(3)})`,
      );
    }
  }
  log('');
  log(
    winsAll
      ? '  ✓ the same config beats BM25 on ALL corpora — not tuned to one benchmark'
      : '  ✗ the config wins on one corpus and loses on the other — that is overfitting',
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
  const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
  const TOL = 0.02;
  let failed = false;
  for (const run of runs) {
    const base = baseline.corpora?.[run.name]?.overall;
    if (!base) continue;
    for (const name of SYSTEM_NAMES) {
      const baseFlip = baseline.corpora?.[run.name]?.flipConsistency?.[name];
      const nowFlip = run.flipConsistency?.[name];
      if (baseFlip !== undefined && nowFlip !== undefined && nowFlip < baseFlip - TOL) {
        console.error(`REGRESSION ${run.name}/${name}.flipConsistency: ${baseFlip} → ${nowFlip}`);
        failed = true;
      }
      for (const metric of ['r@1', 'r@5', 'mrr', 'ans@5', 'found']) {
        const now = run.overall[name]?.[metric];
        const was = base[name]?.[metric];
        if (now === undefined || was === undefined) continue;
        if (now < was - TOL) {
          console.error(`REGRESSION ${run.name}/${name}.${metric}: ${was} → ${now}`);
          failed = true;
        }
      }
    }
  }
  if (failed) process.exit(1);
  log('✓ no regression against eval/baseline.json (all corpora)');
}
