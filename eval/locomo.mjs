/**
 * External benchmark: LoCoMo (Maharana et al.), the other number the
 * agent-memory products quote.
 *
 *   node eval/locomo.mjs /path/to/locomo10.json
 *
 * Ten long multi-session conversations, each with QA whose evidence is labelled
 * down to the individual turn (`D1:3`). Retrieval is therefore turn-level: one
 * note per turn, dated by its session, and recall measured over the labelled
 * evidence turns. No answer generation — this measures finding the evidence,
 * which is the half loreweave is responsible for.
 *
 * Category 5 is adversarial (questions deliberately unanswerable) and carries
 * no evidence; those are skipped rather than scored as misses, because "found
 * nothing" is the correct behaviour there and averaging it into recall would
 * flatter or punish arbitrarily.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const DATA = process.argv[2];
if (!DATA || !existsSync(DATA)) {
  console.error('usage: node eval/locomo.mjs /path/to/locomo10.json');
  process.exit(2);
}
const WITH_EMBED = process.argv.includes('--embed');
const { openContext, indexVault, search, embedMissingBlocks, buildSimilarEdges } = await import(
  pathToFileURL(join(REPO, 'dist/index.js')).href
);

const MONTHS = { january:1,february:2,march:3,april:4,may:5,june:6,july:7,august:8,september:9,october:10,november:11,december:12 };
/** "1:56 pm on 8 May, 2023" → "2023-05-08" */
function isoDate(s) {
  const m = String(s ?? '').match(/(\d{1,2})\s+([A-Za-z]+),?\s+(\d{4})/);
  if (!m) return null;
  const mo = MONTHS[m[2].toLowerCase()];
  if (!mo) return null;
  return `${m[3]}-${String(mo).padStart(2, '0')}-${String(Number(m[1])).padStart(2, '0')}`;
}

const data = JSON.parse(readFileSync(DATA, 'utf8'));
const VAULT = join(HERE, 'locomo-vault');
const KS = [1, 5, 10, 20];
const byCat = new Map();
const CAT_NAME = { 1: 'multi-hop', 2: 'temporal', 3: 'open-domain', 4: 'single-hop', 5: 'adversarial' };

for (const conv of data) {
  const c = conv.conversation ?? {};
  rmSync(VAULT, { recursive: true, force: true });
  mkdirSync(join(VAULT, 'turns'), { recursive: true });
  const pathToDia = new Map();
  let n = 0;
  for (let s = 1; s <= 60; s++) {
    const turns = c[`session_${s}`];
    if (!Array.isArray(turns)) continue;
    const d = isoDate(c[`session_${s}_date_time`]);
    for (const t of turns) {
      const dia = String(t.dia_id ?? '');
      if (!dia) continue;
      const rel = `turns/${String(n).padStart(4, '0')}.md`;
      pathToDia.set(rel, dia);
      writeFileSync(
        join(VAULT, rel),
        `---\ntitle: ${dia}\n${d ? `date: ${d}\n` : ''}---\n\n# ${t.speaker ?? 'speaker'} — session ${s}\n\n` +
          `${String(t.text ?? '').replace(/\n+/g, ' ')}\n`,
      );
      n++;
    }
  }
  if (!n) continue;
  mkdirSync(join(VAULT, '.lore'), { recursive: true });
  if (WITH_EMBED) {
    writeFileSync(
      join(VAULT, '.lore', 'config.json'),
      JSON.stringify({ embedding: { provider: 'ollama', model: 'nomic-embed-text', url: 'http://localhost:11434' } }, null, 2),
    );
  }
  const ctx = openContext(VAULT);
  await indexVault(ctx.store, VAULT, { full: true });
  if (WITH_EMBED && ctx.provider) {
    await embedMissingBlocks(ctx.store, ctx.provider, ctx.config.embedding.batchSize);
    buildSimilarEdges(ctx.store, ctx.config);
  }
  ctx.invalidateGraph();

  for (const q of conv.qa ?? []) {
    const gold = new Set((q.evidence ?? []).map(String));
    if (!gold.size) continue; // adversarial / unlabelled
    const hits = await search(ctx, String(q.question ?? ''), { k: 20, noLog: true });
    const ranked = [];
    const seen = new Set();
    for (const h of hits) {
      const dia = pathToDia.get(h.notePath);
      if (!dia || seen.has(dia)) continue;
      seen.add(dia);
      ranked.push(dia);
    }
    const cat = CAT_NAME[q.category] ?? `cat${q.category}`;
    const acc = byCat.get(cat) ?? { n: 0, ...Object.fromEntries(KS.map((k) => [`r${k}`, 0])) };
    acc.n++;
    for (const k of KS) {
      acc[`r${k}`] += ranked.slice(0, k).filter((d) => gold.has(d)).length / gold.size;
    }
    byCat.set(cat, acc);
  }
  ctx.close();
  process.stderr.write(`  conversation done (${n} turns)\n`);
}
rmSync(VAULT, { recursive: true, force: true });

const total = { n: 0, ...Object.fromEntries(KS.map((k) => [`r${k}`, 0])) };
for (const a of byCat.values()) {
  total.n += a.n;
  for (const k of KS) total[`r${k}`] += a[`r${k}`];
}
const row = (name, a) =>
  `  ${name.padEnd(14)}${String(a.n).padStart(5)}` +
  KS.map((k) => (a[`r${k}`] / a.n).toFixed(3).padStart(9)).join('');
console.log('\n══ LoCoMo — turn-level evidence recall ══════════════════════');
console.log(`  ${'category'.padEnd(14)}${'n'.padStart(5)}${KS.map((k) => `R@${k}`.padStart(9)).join('')}`);
for (const [cat, a] of [...byCat.entries()].sort()) console.log(row(cat, a));
console.log(row('ALL', total));
console.log('');
writeFileSync(
  join(HERE, 'locomo-last.json'),
  JSON.stringify(
    {
      overall: Object.fromEntries(KS.map((k) => [`recall@${k}`, +(total[`r${k}`] / total.n).toFixed(4)])),
      byCategory: Object.fromEntries(
        [...byCat].map(([c, a]) => [c, { n: a.n, ...Object.fromEntries(KS.map((k) => [`recall@${k}`, +(a[`r${k}`] / a.n).toFixed(4)])) }]),
      ),
    },
    null,
    2,
  ) + '\n',
);
