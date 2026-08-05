#!/usr/bin/env node
import { Command } from 'commander';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { openContext, type LoreContext } from '../context.js';
import { LORE_DIR, findVaultRoot } from '../config.js';
import { normalizeKey } from '../normalize.js';
import { indexVault } from '../index/indexer.js';
import { search } from '../retrieve/search.js';
import {
  aggregateFacts,
  assertFact,
  invalidateFact,
  queryFacts,
} from '../facts/model.js';
import { dream } from '../dream/dream.js';
import { capture } from '../capture.js';
import { markUsed, resolveBlockIds } from '../dynamics/usage.js';
import { buildSimilarEdges, embedMissingBlocks } from '../embed/index.js';
import { exportGraph } from './export.js';

function fmtResult(r: {
  notePath: string;
  anchor: string;
  score: number;
  snippet: string;
  via: string[];
}): string {
  const via = r.via.length ? `  ⟨via ${r.via.join(', ')}⟩` : '';
  return `• ${r.notePath}#${r.anchor}  (${r.score.toFixed(4)})${via}\n  ${r.snippet}`;
}

export function buildProgram(io: { out: (s: string) => void; err: (s: string) => void }): Command {
  const program = new Command();
  program
    .name('lore')
    .description(
      'Loreweave — a temporal knowledge engine for markdown vaults.\nIndexes, links, remembers, forgets, and dreams. Local-first, agent-ready.',
    )
    .version('0.1.0')
    .option('--vault <path>', 'vault root (default: nearest .lore, else cwd)');

  const vaultRoot = (): string => {
    const opt = program.opts<{ vault?: string }>().vault;
    return opt ? resolve(opt) : findVaultRoot(process.cwd());
  };

  const withCtx = async <T>(fn: (ctx: LoreContext) => Promise<T> | T): Promise<T> => {
    const ctx = openContext(vaultRoot());
    try {
      return await fn(ctx);
    } finally {
      ctx.close();
    }
  };

  program
    .command('init')
    .description('initialize .lore/ in the current directory')
    .action(() => {
      const root = program.opts<{ vault?: string }>().vault
        ? resolve(program.opts<{ vault?: string }>().vault!)
        : process.cwd();
      const dir = join(root, LORE_DIR);
      mkdirSync(dir, { recursive: true });
      const cfgPath = join(dir, 'config.json');
      if (!existsSync(cfgPath)) {
        writeFileSync(
          cfgPath,
          JSON.stringify(
            {
              embedding: { provider: 'none', model: 'nomic-embed-text', url: 'http://localhost:11434' },
              nlp: true,
            },
            null,
            2,
          ) + '\n',
        );
      }
      io.out(`Initialized ${join(root, LORE_DIR)}`);
      io.out(`Next: lore index   (then: lore search "..." · lore dream · lore serve --mcp)`);
      io.out(`Tip: set embedding.provider to "ollama" in .lore/config.json for dense retrieval.`);
    });

  program
    .command('index')
    .description('sync the vault into the index (incremental)')
    .option('--full', 'reparse everything')
    .option('--no-nlp', 'skip NLP entity extraction')
    .action(async (opts: { full?: boolean; nlp?: boolean }) => {
      await withCtx(async (ctx) => {
        const r = await indexVault(ctx.store, ctx.root, { full: opts.full, nlp: opts.nlp });
        ctx.invalidateGraph();
        io.out(
          `indexed: +${r.added} ~${r.updated} -${r.removed} =${r.unchanged} (${r.durationMs}ms)`,
        );
        for (const w of r.warnings) io.err(`warn: ${w}`);
        if (ctx.provider) {
          const n = await embedMissingBlocks(ctx.store, ctx.provider, ctx.config.embedding.batchSize);
          if (n > 0) {
            const e = buildSimilarEdges(ctx.store, {
              threshold: ctx.config.graph.similarThreshold,
              topK: ctx.config.graph.similarTopK,
            });
            io.out(`embedded ${n} blocks · ${e} similarity edges`);
          }
        }
      });
    });

  program
    .command('search')
    .description('hybrid search (BM25 + graph + dense when configured)')
    .argument('<query...>')
    .option('-k, --k <n>', 'results', (v) => parseInt(v, 10))
    .option('--since <date>', 'only notes modified on/after ISO date')
    .option('--json', 'JSON output')
    .action(async (words: string[], opts: { k?: number; since?: string; json?: boolean }) => {
      await withCtx(async (ctx) => {
        const res = await search(ctx, words.join(' '), { k: opts.k, since: opts.since });
        if (opts.json) io.out(JSON.stringify(res, null, 2));
        else if (res.length === 0) io.out('no results');
        else io.out(res.map(fmtResult).join('\n'));
      });
    });

  program
    .command('ask')
    .description('extractive answer: top passages + current facts (no LLM required)')
    .argument('<query...>')
    .option('--json', 'JSON output')
    .action(async (words: string[], opts: { json?: boolean }) => {
      await withCtx(async (ctx) => {
        const q = words.join(' ');
        const [passages, facts] = [await search(ctx, q, { k: 5 }), queryFacts(ctx.store, {})];
        const qTokens = new Set(q.toLowerCase().split(/\W+/).filter(Boolean));
        const relevantFacts = facts
          .filter((f) =>
            [...qTokens].some(
              (t) =>
                f.subject.includes(t) || f.predicate.includes(t) || f.object.toLowerCase().includes(t),
            ),
          )
          .slice(0, 8);
        if (opts.json) {
          io.out(JSON.stringify({ passages, facts: relevantFacts }, null, 2));
          return;
        }
        if (relevantFacts.length) {
          io.out('Facts (currently valid):');
          for (const f of relevantFacts) {
            const from = f.validFrom ? ` (since ${f.validFrom.slice(0, 10)})` : '';
            io.out(`  ★ ${f.subjectDisplay} — ${f.predicate} — ${f.object}${from}`);
          }
          io.out('');
        }
        if (passages.length) {
          io.out('Passages:');
          io.out(passages.map(fmtResult).join('\n'));
        }
        if (!relevantFacts.length && !passages.length) io.out('nothing found');
      });
    });

  program
    .command('facts')
    .description('query the bitemporal fact store')
    .option('--subject <s>')
    .option('--predicate <p>')
    .option('--as-of <date>', 'what was true on this date')
    .option('--history', 'include superseded facts')
    .option('--json', 'JSON output')
    .action(async (opts: {
      subject?: string;
      predicate?: string;
      asOf?: string;
      history?: boolean;
      json?: boolean;
    }) => {
      await withCtx((ctx) => {
        const rows = queryFacts(ctx.store, {
          subject: opts.subject,
          predicate: opts.predicate,
          asOf: opts.asOf,
          includeHistory: opts.history,
        });
        if (opts.json) {
          io.out(JSON.stringify(rows, null, 2));
          return;
        }
        if (!rows.length) {
          io.out('no facts');
          return;
        }
        for (const f of rows) {
          const window = `${f.validFrom?.slice(0, 10) ?? '…'} → ${f.validUntil?.slice(0, 10) ?? 'now'}`;
          const sup = f.supersededBy ? '  [superseded]' : '';
          io.out(`${f.subjectDisplay} :: ${f.predicate} :: ${f.object}  (${window})${sup}`);
        }
      });
    });

  program
    .command('assert')
    .description('assert a fact (journalled, supersedes contradictions)')
    .argument('<subject>')
    .argument('<predicate>')
    .argument('<object...>')
    .option('--valid-from <date>')
    .option('--valid-until <date>')
    .option('--confidence <n>', 'confidence 0..1', parseFloat)
    .action(async (
      subject: string,
      predicate: string,
      objectWords: string[],
      opts: { validFrom?: string; validUntil?: string; confidence?: number },
    ) => {
      await withCtx((ctx) => {
        const r = assertFact(ctx, {
          subject,
          predicate,
          object: objectWords.join(' '),
          validFrom: opts.validFrom,
          validUntil: opts.validUntil,
          confidence: opts.confidence,
        });
        io.out(`✓ ${r.fact.subjectDisplay} :: ${r.fact.predicate} :: ${r.fact.object}`);
        for (const s of r.superseded) io.out(`  superseded: "${s.object}" (now valid until ${s.validUntil})`);
        io.out(`  journal: ${r.journalPath}`);
      });
    });

  program
    .command('invalidate')
    .description('close the current fact in a slot (journalled)')
    .argument('<subject>')
    .argument('<predicate>')
    .option('--valid-until <date>')
    .action(async (subject: string, predicate: string, opts: { validUntil?: string }) => {
      await withCtx((ctx) => {
        const r = invalidateFact(ctx, { subject, predicate, validUntil: opts.validUntil });
        io.out(`closed ${r.closed} fact(s) · journal: ${r.journalPath}`);
      });
    });

  program
    .command('count')
    .description('aggregate facts (the computable layer)')
    .option('--subject <s>')
    .option('--predicate <p>')
    .option('--group-by <col>', 'object|subject|predicate', 'object')
    .option('--since <date>')
    .option('--until <date>')
    .action(async (opts: {
      subject?: string;
      predicate?: string;
      groupBy?: string;
      since?: string;
      until?: string;
    }) => {
      await withCtx((ctx) => {
        const rows = aggregateFacts(ctx.store, {
          subject: opts.subject,
          predicate: opts.predicate,
          groupBy: (opts.groupBy as 'object' | 'subject' | 'predicate') ?? 'object',
          since: opts.since,
          until: opts.until,
        });
        if (!rows.length) io.out('no facts');
        for (const r of rows) io.out(`${String(r.count).padStart(5)}  ${r.group}`);
      });
    });

  program
    .command('capture')
    .description('append a timestamped note to lore/inbox.md')
    .argument('<text...>')
    .option('--to <note>', 'target note path', 'lore/inbox.md')
    .action(async (words: string[], opts: { to: string }) => {
      await withCtx((ctx) => {
        const to = capture(ctx, words.join(' '), opts.to);
        io.out(`captured → ${to}`);
      });
    });

  program
    .command('dream')
    .description('consolidation pass: duplicates, contradictions, staleness, links, orphans')
    .option('--apply', 'write digest + review queue under lore/')
    .option('--json', 'JSON output')
    .action(async (opts: { apply?: boolean; json?: boolean }) => {
      await withCtx((ctx) => {
        const r = dream(ctx, { apply: opts.apply });
        if (opts.json) {
          io.out(JSON.stringify(r, null, 2));
          return;
        }
        const s = r.stats;
        io.out(
          `state: ${s.notes} notes · ${s.blocks} blocks · ${s.entities} entities · ${s.openFacts}/${s.facts} facts open`,
        );
        io.out(
          `findings: ${r.duplicates.length} duplicates · ${r.contradictions.length} contradictions/changes · ${r.stale.length} stale · ${r.linkSuggestions.length} link suggestions · ${r.orphans.length} orphans`,
        );
        for (const c of r.contradictions.slice(0, 10)) {
          io.out(`  ⚡ ${c.subject} :: ${c.predicate} — ${c.detail}`);
        }
        for (const l of r.linkSuggestions.slice(0, 5)) {
          io.out(`  ✦ link? ${l.from} ↔ ${l.to} (${l.sharedEntities.join(', ')})`);
        }
        if (r.written.length) io.out(`written: ${r.written.join(', ')}`);
        else if (!opts.apply) io.out(`(run with --apply to write the digest + review queue)`);
      });
    });

  program
    .command('mark-used')
    .description('reinforce a passage that was actually useful (spaced-repetition signal)')
    .argument('<notePath>')
    .argument('[anchor]')
    .action(async (notePath: string, anchor?: string) => {
      await withCtx((ctx) => {
        const ids = resolveBlockIds(ctx.store, notePath, anchor);
        const n = markUsed(ctx.store, ids);
        io.out(`reinforced ${n} block(s)`);
      });
    });

  program
    .command('doctor')
    .description('vault health: broken links, integrity, coverage')
    .action(async () => {
      await withCtx((ctx) => {
        const db = ctx.store.db;
        const integrity = db.pragma('integrity_check') as { integrity_check: string }[];
        io.out(`db integrity: ${integrity[0]?.integrity_check ?? 'unknown'}`);
        // A link is broken when no NOTE resolves to its target. (Checking
        // against `entities` would never fire: every link target becomes an
        // entity by construction.)
        const notes = db.prepare(`SELECT path, title FROM notes`).all() as {
          path: string;
          title: string;
        }[];
        const resolvable = new Set<string>();
        for (const n of notes) {
          resolvable.add(normalizeKey(n.title));
          resolvable.add(normalizeKey(n.path));
          resolvable.add(normalizeKey(n.path.split('/').pop() ?? n.path));
        }
        const allLinks = db
          .prepare(`SELECT DISTINCT note_path, target, target_norm FROM links WHERE target != ''`)
          .all() as { note_path: string; target: string; target_norm: string }[];
        const broken = allLinks.filter((l) => !resolvable.has(l.target_norm));
        if (broken.length) {
          io.out(`broken links: ${broken.length}`);
          for (const b of broken.slice(0, 20)) io.out(`  ${b.note_path} → [[${b.target}]]`);
        } else {
          io.out('broken links: 0');
        }
        const emb = db.prepare(`SELECT COUNT(*) c FROM embeddings`).get() as { c: number };
        const blocks = db.prepare(`SELECT COUNT(*) c FROM blocks`).get() as { c: number };
        io.out(
          `embedding coverage: ${emb.c}/${blocks.c}${ctx.provider ? '' : ' (no provider configured — lexical+graph mode)'}`,
        );
        const lastIndex = ctx.store.getMeta('last_index_at');
        io.out(`last index: ${lastIndex ?? 'never — run: lore index'}`);
      });
    });

  program
    .command('stats')
    .description('vault statistics')
    .action(async () => {
      await withCtx((ctx) => {
        const db = ctx.store.db;
        const c = (sql: string) => (db.prepare(sql).get() as any).c as number;
        io.out(`notes:    ${c('SELECT COUNT(*) c FROM notes')}`);
        io.out(`blocks:   ${c('SELECT COUNT(*) c FROM blocks')}`);
        io.out(`entities: ${c('SELECT COUNT(*) c FROM entities')}`);
        io.out(`links:    ${c('SELECT COUNT(*) c FROM links')}`);
        io.out(`facts:    ${c('SELECT COUNT(*) c FROM facts')} (${c("SELECT COUNT(*) c FROM facts WHERE valid_until IS NULL AND superseded_by IS NULL")} open)`);
        const top = db
          .prepare(
            `SELECT e.display, COUNT(*) n FROM mentions m JOIN entities e ON e.id=m.entity_id
             GROUP BY e.id ORDER BY n DESC LIMIT 10`,
          )
          .all() as { display: string; n: number }[];
        io.out('top entities:');
        for (const t of top) io.out(`  ${String(t.n).padStart(4)}  ${t.display}`);
      });
    });

  program
    .command('graph')
    .description('export the knowledge graph')
    .argument('<action>', 'export')
    .option('--format <fmt>', 'json|graphml|dot', 'json')
    .option('-o, --out <file>', 'output file (default: stdout)')
    .action(async (action: string, opts: { format: string; out?: string }) => {
      if (action !== 'export') throw new Error(`unknown graph action: ${action}`);
      await withCtx((ctx) => {
        const text = exportGraph(ctx, opts.format);
        if (opts.out) {
          writeFileSync(opts.out, text);
          io.out(`wrote ${opts.out}`);
        } else {
          io.out(text);
        }
      });
    });

  program
    .command('serve')
    .description('start the MCP server (stdio) so agents can use the vault as memory')
    .option('--mcp', 'stdio MCP mode (default)')
    .action(async () => {
      const { startMcpServer } = await import('../mcp/server.js');
      // NOTE: never write to stdout here — stdio transport owns it
      const ctx = openContext(vaultRoot());
      await startMcpServer(ctx);
    });

  return program;
}

const isDirectRun = (() => {
  try {
    const argv1 = process.argv[1] ?? '';
    return /main\.(ts|js)$/.test(argv1) || /\/(lore|loreweave)$/.test(argv1);
  } catch {
    return false;
  }
})();

if (isDirectRun) {
  const program = buildProgram({
    out: (s) => console.log(s),
    err: (s) => console.error(s),
  });
  program.parseAsync(process.argv).catch((err: Error) => {
    console.error(`error: ${err.message}`);
    process.exitCode = 1;
  });
}
