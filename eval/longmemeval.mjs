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
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const DATA = process.argv[2];
const LIMIT = Number(process.argv[3] ?? 0) || Infinity;
/**
 * `--stride N` samples every Nth question. The file is GROUPED BY CATEGORY,
 * so a plain `limit` reads only the first category and reports a number that
 * looks like the whole benchmark — the first 25 questions are all
 * single-session-user, the easiest class. A stride spreads the sample across
 * every category instead.
 */
const STRIDE = Math.max(1, Number((process.argv.find((a) => a.startsWith('--stride=')) ?? '').split('=')[1] ?? 1));
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
const WITH_RERANK = process.argv.includes('--rerank');
/** `--model=NAME` picks the ollama embedding model. Prefixes are inferred from the name. */
const EMBED_MODEL = (process.argv.find((a) => a.startsWith('--model=')) ?? '').split('=')[1] || 'nomic-embed-text';
/** `--chunk=N` splits each session into N-turn blocks. 0 keeps one block/session. */
const CHUNK = Math.max(0, Number((process.argv.find((a) => a.startsWith('--chunk=')) ?? '').split('=')[1] ?? 0));
const { openContext, indexVault, search, embedMissingBlocks, buildSimilarEdges } = await import(pathToFileURL(dist).href);

console.log('loading dataset…');
const data = JSON.parse(readFileSync(DATA, 'utf8'));
console.log(`${data.length} questions`);

/** "2023/04/10 (Mon) 17:50" → "2023-04-10" */
const isoDate = (s) => {
  const m = String(s ?? '').match(/(\d{4})\/(\d{2})\/(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
};

/**
 * Per-process scratch vault. This used to be a single shared `eval/lme-vault`,
 * which meant two concurrent runs (an embeddings arm and a reranking arm, say)
 * would delete each other's files mid-write and die on ENOTEMPTY. The pid
 * suffix makes concurrent arms independent, and keeping it out of the repo
 * stops a crashed run from leaving a half-built vault in `git status`.
 */
const VAULT = join(tmpdir(), `lme-vault-${process.pid}`);
process.on('exit', () => {
  try {
    rmSync(VAULT, { recursive: true, force: true });
  } catch {
    /* best effort — a leftover temp dir is not worth failing a benchmark over */
  }
});
const KS = [1, 3, 5, 10];
const byCat = new Map();
let done = 0;

for (const [qi, q] of data.entries()) {
  if (done >= LIMIT) break;
  if (qi % STRIDE !== 0) continue;
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
    const lines = (Array.isArray(turns) ? turns : []).map(
      (t) => `**${t.role ?? 'speaker'}:** ${String(t.content ?? '').replace(/\n+/g, ' ')}`,
    );
    /**
     * `--chunk=N` puts every N turns under their own `##` heading, so a session
     * indexes as several blocks instead of one 50-turn wall of text. This is
     * the more honest translation of a chat log into markdown — nobody writes a
     * day of conversation as a single unbroken paragraph — and it matters for
     * scoring: one giant block gets punished by BM25 length normalisation,
     * averages to a single muddy embedding, and overflows a cross-encoder's
     * 512-token window so the reranker only ever sees the opening turns.
     * Evidence is still credited at session granularity (blocks dedupe to their
     * note below), so this changes how the engine reads the haystack, not what
     * counts as a correct answer.
     */
    const body = CHUNK
      ? lines
          .reduce((groups, line, li) => {
            if (li % CHUNK === 0) groups.push([]);
            groups[groups.length - 1].push(line);
            return groups;
          }, [])
          .map((g, gi) => `## Part ${gi + 1}\n\n${g.join('\n\n')}`)
          .join('\n\n')
      : lines.join('\n\n');
    writeFileSync(
      join(VAULT, rel),
      `---\ntitle: session ${i}\n${d ? `date: ${d}\n` : ''}---\n\n# Session ${i}\n\n${body}\n`,
    );
  });
  /**
   * Drop the transcript now that it is on disk. longmemeval_s is 278 MB of
   * JSON that parses to several GB of objects, and every question's haystack
   * stayed reachable through `data` for the whole run even though each is used
   * exactly once. On a laptop that pushed free memory to 6%, macOS swapped the
   * embedding server out, and requests to it stopped returning — which is why
   * full-set runs kept dying around question 100 while the sampled runs, which
   * finish just before the ceiling, always survived. Releasing here keeps peak
   * memory flat across the run instead of climbing with every question.
   */
  q.haystack_sessions = null;
  mkdirSync(join(VAULT, '.lore'), { recursive: true });
  const cfgObj = {};
  if (WITH_EMBED) {
    cfgObj.embedding = { provider: 'ollama', model: EMBED_MODEL, url: 'http://localhost:11434' };
  }
  if (WITH_RERANK) {
    cfgObj.rerank = { provider: 'transformers', model: 'Xenova/ms-marco-MiniLM-L-6-v2', topK: 30 };
  }
  if (Object.keys(cfgObj).length) {
    writeFileSync(join(VAULT, '.lore', 'config.json'), JSON.stringify(cfgObj, null, 2));
  }

  const ctx = openContext(VAULT);
  await indexVault(ctx.store, VAULT, { full: true });
  if (WITH_EMBED && ctx.provider) {
    await embedMissingBlocks(ctx.store, ctx.provider, ctx.config.embedding.batchSize);
    buildSimilarEdges(ctx.store, ctx.config);
  }
  ctx.invalidateGraph();
  /**
   * Ask for enough BLOCKS to still yield 10 distinct SESSIONS after the dedupe
   * below. Without chunking one block is one session, so 10 suffices; with
   * chunking a single session can occupy many top slots, and asking for 10
   * would score a short session list against a full one and make chunking look
   * worse than it is. R@k is computed over the deduped session ranking either
   * way, so the wider pull cannot inflate the result.
   */
  const hits = await search(ctx, q.question, { k: CHUNK ? 100 : 10, noLog: true });
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
