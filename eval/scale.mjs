/**
 * Scale benchmark: what loreweave costs on a vault the size people actually
 * accumulate.
 *
 *   npm run scale            # 1k and 5k notes
 *   npm run scale -- 20000   # one explicit size
 *
 * The retrieval benchmark (eval/run.mjs) measures whether answers are RIGHT.
 * This measures whether they arrive — index time, search latency, the idle
 * consolidation pass, and peak heap. Both are claims the README makes, and a
 * claim nobody re-measures is a claim that quietly stops being true.
 *
 * Deliberately reports p50 AND p95: a median that looks fine while the tail
 * is seconds long is the shape of "it feels slow" that averages hide.
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const dist = join(REPO, 'dist/index.js');
if (!existsSync(dist)) {
  console.error('dist/ not built — run `npm run build` first.');
  process.exit(2);
}
const { openContext, indexVault, search, dream } = await import(pathToFileURL(dist).href);

const sizes = process.argv.slice(2).filter((a) => /^\d+$/.test(a)).map(Number);
const SIZES = sizes.length ? sizes : [1000, 5000];

// ── a vault shaped like a real one ────────────────────────────────────────
const TOPICS = ['harbor', 'ledger', 'kestrel', 'orchard', 'foundry', 'lantern', 'quarry', 'meadow'];
const PEOPLE = ['Ada Fenwick', 'Bo Marchetti', 'Cyra Okonjo', 'Dara Lindqvist', 'Emil Vasquez'];
const VERBS = ['reviewed', 'shipped', 'measured', 'rebuilt', 'audited', 'archived'];

function buildVault(dir, n) {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const pad = (i) => String(i).padStart(6, '0');
  for (let i = 0; i < n; i++) {
    const topic = TOPICS[i % TOPICS.length];
    const person = PEOPLE[i % PEOPLE.length];
    const verb = VERBS[i % VERBS.length];
    // links form a connected graph: each note links two others, so link
    // expansion and PPR have real structure to walk rather than a star.
    const l1 = pad((i * 7 + 3) % n);
    const l2 = pad((i * 13 + 11) % n);
    const year = 2019 + (i % 7);
    const month = String((i % 12) + 1).padStart(2, '0');
    const rel = `notes/${topic}/${pad(i)}.md`;
    const body =
      `---\ntitle: ${topic} note ${i}\ntags: [${topic}, ${i % 3 === 0 ? 'decision' : 'log'}]\ndate: ${year}-${month}-0${(i % 9) + 1}\n---\n\n` +
      `# ${topic} note ${i}\n\n` +
      `[[${topic} note ${l1}]] and [[${topic} note ${l2}]] are related. ${person} ${verb} the ${topic} assembly.\n\n` +
      `## Detail\n\nThe ${topic} run recorded a drift of ${(i % 97) / 10} units against the ${TOPICS[(i + 3) % TOPICS.length]} baseline. ` +
      `Calibration held through the ${verb} cycle and the crew logged no exceptions.\n\n` +
      `## Follow-up\n\nRevisit after the next ${topic} window; ${person} owns the checklist.\n` +
      (i % 20 === 0 ? `\n- [fact] ${topic} rig ${i} :: status :: ${verb} {valid_from=${year}-${month}-01}\n` : '');
    const abs = join(dir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, body);
  }
}

const ms = (t) => `${t.toFixed(0)} ms`;
const pct = (arr, p) => {
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((s.length - 1) * p))];
};
const heapMB = () => Math.round(process.memoryUsage().heapUsed / 1048576);

const QUERIES = [
  'harbor drift calibration',
  'who reviewed the ledger assembly',
  'kestrel note 000123',
  'orchard decisions in March 2021',
  'current foundry status',
  'lantern crew exceptions checklist',
  'quarry baseline drift units',
  'meadow follow-up window owner',
];

const rows = [];
for (const n of SIZES) {
  const dir = join(HERE, `scale-${n}`);
  const t0 = Date.now();
  buildVault(dir, n);
  const genMs = Date.now() - t0;
  mkdirSync(join(dir, '.lore'), { recursive: true });

  const ctx = openContext(dir);
  const t1 = Date.now();
  const report = await indexVault(ctx.store, dir, { full: true });
  const indexMs = Date.now() - t1;
  ctx.invalidateGraph();

  // incremental: one note changed, the shape of `lore watch` in daily use
  const one = join(dir, `notes/${TOPICS[0]}/${String(0).padStart(6, '0')}.md`);
  writeFileSync(one, `---\ntitle: edited\n---\n\n# edited\n\nA single changed note.\n`);
  const t2 = Date.now();
  await indexVault(ctx.store, dir);
  const incrMs = Date.now() - t2;

  const t3 = Date.now();
  const graph = ctx.graph();
  const graphMs = Date.now() - t3;

  const lat = [];
  for (let round = 0; round < 3; round++) {
    for (const q of QUERIES) {
      const t = Date.now();
      await search(ctx, q, { k: 8, noLog: true });
      lat.push(Date.now() - t);
    }
  }

  const t4 = Date.now();
  dream(ctx);
  const dreamMs = Date.now() - t4;

  const stat = (sql) => ctx.store.db.prepare(sql).get().c;
  rows.push({
    notes: n,
    blocks: stat('SELECT COUNT(*) c FROM blocks'),
    entities: stat('SELECT COUNT(*) c FROM entities'),
    edges: graph.neighbors.length / 2,
    genMs,
    indexMs,
    perNote: indexMs / n,
    incrMs,
    graphMs,
    p50: pct(lat, 0.5),
    p95: pct(lat, 0.95),
    dreamMs,
    heap: heapMB(),
    warnings: report.warnings.length,
  });
  ctx.close();
  rmSync(dir, { recursive: true, force: true });
}

console.log('\n══ scale ═══════════════════════════════════════════════════════');
console.log(
  ['notes', 'blocks', 'entities', 'edges', 'index', 'per note', 'incr', 'graph', 'search p50', 'p95', 'dream', 'heap']
    .map((h, i) => h.padStart(i === 0 ? 6 : 10))
    .join(''),
);
for (const r of rows) {
  console.log(
    [
      String(r.notes),
      String(r.blocks),
      String(r.entities),
      String(r.edges),
      ms(r.indexMs),
      `${r.perNote.toFixed(2)} ms`,
      ms(r.incrMs),
      ms(r.graphMs),
      ms(r.p50),
      ms(r.p95),
      ms(r.dreamMs),
      `${r.heap} MB`,
    ]
      .map((v, i) => v.padStart(i === 0 ? 6 : 10))
      .join(''),
  );
}
console.log('');
if (rows.length > 1) {
  const [a, b] = [rows[0], rows[rows.length - 1]];
  const growth = (b.indexMs / a.indexMs) / (b.notes / a.notes);
  console.log(
    `  index scaling ${a.notes}→${b.notes} notes: ${growth.toFixed(2)}× per-note ` +
      `(1.0 = linear; >1.5 means a superlinear step is hiding in there)`,
  );
}
writeFileSync(join(HERE, 'scale-last.json'), JSON.stringify(rows, null, 2) + '\n');
