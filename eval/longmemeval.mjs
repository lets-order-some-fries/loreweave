/**
 * External benchmark: LongMemEval retrieval (ICLR 2025), the standard the
 * agent-memory products quote.
 *
 *   node eval/longmemeval.mjs /path/to/longmemeval_s [limit]
 *
 * Each question ships its own ~50-session chat history; the task is to find
 * the session(s) holding the evidence. That is a RETRIEVAL task, which is what
 * loreweave is — no answer generation, no LLM, so the numbers here are
 * recall over evidence sessions, the same quantity the paper's retrieval
 * ablations report.
 *
 * Every session becomes a dated markdown note, which is the honest translation
 * of "chat history" into this engine's world: the dates are real, so the
 * temporal machinery is doing work it would do on a real vault rather than
 * being handed a favour.
 *
 * The per-category split is the interesting part — LongMemEval separates
 * temporal-reasoning and knowledge-update from ordinary recall, and those two
 * are precisely what this engine claims to be built for.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const DATA = process.argv[2];
const LIMIT = Number(process.argv[3] ?? 0) || Infinity;
if (!DATA || !existsSync(DATA)) {
  console.error('usage: node eval/longmemeval.mjs /path/to/longmemeval_s [limit]');
  process.exit(2);
}
const dist = join(REPO, 'dist/index.js');
if (!existsSync(dist)) {
  console.error('dist/ not built — run `npm run build` first.');
  process.exit(2);
}
const WITH_EMBED = process.argv.includes('--embed');
const { openContext, indexVault, search, embedMissingBlocks, buildSimilarEdges } = await import(pathToFileURL(dist).href);

console.log('loading dataset…');
const data = JSON.parse(readFileSync(DATA, 'utf8'));
console.log(`${data.length} questions`);

/** "2023/04/10 (Mon) 17:50" → "2023-04-10" */
const isoDate = (s) => {
  const m = String(s ?? '').match(/(\d{4})\/(\d{2})\/(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
};

const VAULT = join(HERE, 'lme-vault');
const KS = [1, 3, 5, 10];
const byCat = new Map();
let done = 0;

for (const q of data) {
  if (done >= LIMIT) break;
  const sessions = q.haystack_sessions ?? [];
  const ids = q.haystack_session_ids ?? [];
  const dates = q.haystack_dates ?? [];
  const gold = new Set(q.answer_session_ids ?? []);
  if (!sessions.length || !gold.size) continue;

  rmSync(VAULT, { recursive: true, force: true });
  mkdirSync(join(VAULT, 'sessions'), { recursive: true });
  const pathToId = new Map();
  sessions.forEach((turns, i) => {
    const sid = String(ids[i] ?? `s${i}`);
    const d = isoDate(dates[i]);
    const rel = `sessions/${String(i).padStart(3, '0')}.md`;
    pathToId.set(rel, sid);
    const body = (Array.isArray(turns) ? turns : [])
      .map((t) => `**${t.role ?? 'speaker'}:** ${String(t.content ?? '').replace(/\n+/g, ' ')}`)
      .join('\n\n');
    writeFileSync(
      join(VAULT, rel),
      `---\ntitle: session ${i}\n${d ? `date: ${d}\n` : ''}---\n\n# Session ${i}\n\n${body}\n`,
    );
  });
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
  const hits = await search(ctx, q.question, { k: 10, noLog: true });
  ctx.close();

  const ranked = [];
  const seen = new Set();
  for (const h of hits) {
    const sid = pathToId.get(h.notePath);
    if (!sid || seen.has(sid)) continue;
    seen.add(sid);
    ranked.push(sid);
  }

  const cat = q.question_type ?? 'unknown';
  const acc = byCat.get(cat) ?? { n: 0, ...Object.fromEntries(KS.map((k) => [`r${k}`, 0])) };
  acc.n++;
  for (const k of KS) {
    const found = ranked.slice(0, k).filter((s) => gold.has(s)).length;
    acc[`r${k}`] += found / gold.size;
  }
  byCat.set(cat, acc);

  done++;
  if (done % 25 === 0) process.stderr.write(`  ${done} questions…\n`);
}
rmSync(VAULT, { recursive: true, force: true });

const total = { n: 0, ...Object.fromEntries(KS.map((k) => [`r${k}`, 0])) };
for (const acc of byCat.values()) {
  total.n += acc.n;
  for (const k of KS) total[`r${k}`] += acc[`r${k}`];
}

console.log('\n══ LongMemEval — session retrieval recall ═══════════════════');
console.log(`  ${'category'.padEnd(26)}${'n'.padStart(5)}${KS.map((k) => `R@${k}`.padStart(9)).join('')}`);
const row = (name, acc) =>
  `  ${name.padEnd(26)}${String(acc.n).padStart(5)}` +
  KS.map((k) => (acc[`r${k}`] / acc.n).toFixed(3).padStart(9)).join('');
for (const [cat, acc] of [...byCat.entries()].sort()) console.log(row(cat, acc));
console.log(row('ALL', total));
console.log('');
writeFileSync(
  join(HERE, 'longmemeval-last.json'),
  JSON.stringify(
    {
      overall: Object.fromEntries(KS.map((k) => [`recall@${k}`, +(total[`r${k}`] / total.n).toFixed(4)])),
      byCategory: Object.fromEntries(
        [...byCat].map(([c, a]) => [
          c,
          { n: a.n, ...Object.fromEntries(KS.map((k) => [`recall@${k}`, +(a[`r${k}`] / a.n).toFixed(4)])) },
        ]),
      ),
    },
    null,
    2,
  ) + '\n',
);
