#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { openContext, ensureIndexed, type LoreContext } from '../context.js';
import { indexVault } from '../index/indexer.js';
import { search } from '../retrieve/search.js';
import {
  aggregateFacts,
  assertFact,
  invalidateFact,
  queryFacts,
} from '../facts/model.js';
import { dream } from '../dream/dream.js';
import { capture, readNoteRaw } from '../capture.js';
import { markUsed, resolveBlockIds } from '../dynamics/usage.js';
import { findVaultRoot } from '../config.js';
import { extractFactsFromNote } from '../facts/extract.js';
import { normalizeKey } from '../normalize.js';

function text(data: unknown): { content: { type: 'text'; text: string }[] } {
  return {
    content: [
      { type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data, null, 2) },
    ],
  };
}

function errText(message: string): {
  content: { type: 'text'; text: string }[];
  isError: true;
} {
  return { content: [{ type: 'text', text: `error: ${message}` }], isError: true };
}

/** Wrap a handler so domain errors surface as MCP tool errors, not crashes. */
function safe<A extends unknown[]>(
  fn: (...args: A) => unknown | Promise<unknown>,
): (...args: A) => Promise<ReturnType<typeof text> | ReturnType<typeof errText>> {
  return async (...args: A) => {
    try {
      const r = await fn(...args);
      return text(r);
    } catch (err) {
      return errText((err as Error).message);
    }
  };
}

/** The fields an agent acts on; score internals stay behind verbose. */
function leanHit(h: {
  notePath: string;
  heading: string;
  coverage: number;
  snippet: string;
  via: string[];
}) {
  return {
    note: h.notePath,
    section: h.heading || undefined,
    match:
      h.coverage >= 0.99
        ? 'all query terms'
        : h.coverage > 0
          ? `${Math.round(h.coverage * 100)}% of query terms`
          : 'linked, no term match',
    text: h.snippet,
    ...(h.via.length ? { linkedVia: h.via } : {}),
  };
}

export function createLoreMcpServer(ctx: LoreContext): McpServer {
  const server = new McpServer({ name: 'loreweave', version: '0.5.1' });

  server.registerTool(
    'lore_search',
    {
      title: 'Search the vault',
      description:
        'Hybrid retrieval over the markdown vault: BM25 + knowledge-graph spreading activation (+ dense embeddings when configured). Returns one passage per note — the section that best covers your query — with the file it came from, how much of your query it matched, and any entity that linked it in. Use for any "what do my notes say about X" question, including multi-hop associations where the answer shares no words with the query. Pass verbose:true only if you need score internals.',
      inputSchema: {
        query: z.string().min(1).max(2000).describe('natural-language query'),
        k: z.number().int().min(1).max(50).optional().describe('max results (default 8)'),
        since: z.string().optional().describe('only content dated on/after this ISO date'),
        until: z.string().optional().describe('only content dated on/before this ISO date'),
        verbose: z.boolean().optional().describe('include score breakdown and block anchors'),
      },
    },
    safe(async ({ query, k, since, until, verbose }) => {
      const hits = await search(ctx, query, { k, since, until });
      if (verbose) return hits;
      // Lean by default: an agent acts on the text and its source, not on
      // five floats. Measured, the full shape cost ~1,290 tokens per search —
      // most of it score internals at 17 significant digits.
      return hits.map(leanHit);
    }),
  );

  server.registerTool(
    'lore_context_pack',
    {
      title: 'Session context pack',
      description:
        'Progressive-disclosure primer: vault stats, top entities, recently modified notes, currently-valid facts, and (if topic given) top search hits. Call once at session start to orient; then drill down with lore_search / lore_read_note.',
      inputSchema: {
        topic: z.string().max(2000).optional().describe('optional focus topic'),
      },
    },
    safe(async ({ topic }) => {
      const db = ctx.store.db;
      const c = (sql: string) => (db.prepare(sql).get() as any).c as number;
      const recent = db
        .prepare(`SELECT path, title FROM notes ORDER BY mtime_ms DESC LIMIT 10`)
        .all();
      const topEntities = db
        .prepare(
          `SELECT e.display, COUNT(*) n FROM mentions m JOIN entities e ON e.id=m.entity_id
           GROUP BY e.id ORDER BY n DESC LIMIT 15`,
        )
        .all();
      const facts = queryFacts(ctx.store, { limit: 30 }).map(
        (f) => `${f.subjectDisplay} :: ${f.predicate} :: ${f.object} (since ${f.validFrom ?? '?'})`,
      );
      const hits = topic ? (await search(ctx, topic, { k: 6 })).map(leanHit) : [];
      return {
        stats: {
          notes: c('SELECT COUNT(*) c FROM notes'),
          blocks: c('SELECT COUNT(*) c FROM blocks'),
          entities: c('SELECT COUNT(*) c FROM entities'),
          openFacts: c(
            'SELECT COUNT(*) c FROM facts WHERE valid_until IS NULL AND superseded_by IS NULL',
          ),
        },
        recentNotes: recent,
        topEntities,
        currentFacts: facts,
        topicHits: hits,
      };
    }),
  );

  server.registerTool(
    'lore_read_note',
    {
      title: 'Read a note',
      description:
        'Read the raw markdown of a note by vault-relative path (as returned in search results). After reading a note that answered the question, call lore_mark_used to reinforce it.',
      inputSchema: { path: z.string().min(1).max(1024).describe('vault-relative path, e.g. projects/x.md') },
    },
    safe(({ path }) => readNoteRaw(ctx.root, path)),
  );

  server.registerTool(
    'lore_assert_fact',
    {
      title: 'Assert a fact',
      description:
        'Record an atomic fact (subject :: predicate :: object) with bitemporal validity. Contradicting facts in the same slot are superseded automatically (never deleted; history stays queryable). The fact is journalled to lore/journal/ in markdown, so the vault remains the source of truth. Use for durable knowledge: decisions, states, preferences, relationships.',
      inputSchema: {
        subject: z.string().min(1).max(2000),
        predicate: z.string().min(1).max(2000).describe('snake_case relation, e.g. works_at, status, lives_in'),
        object: z.string().min(1).max(2000),
        validFrom: z.string().optional().describe('ISO date when it became true (default today)'),
        validUntil: z.string().optional().describe('ISO date when it stops being true, if known'),
        confidence: z.number().min(0).max(1).optional(),
        sourceType: z.enum(['stated', 'extracted', 'inferred']).optional()
          .describe('stated: user said it · extracted: from a document · inferred: your deduction'),
      },
    },
    safe((input) => assertFact(ctx, input)),
  );

  server.registerTool(
    'lore_invalidate_fact',
    {
      title: 'Invalidate a fact',
      description:
        'Close the currently-valid fact in a (subject, predicate) slot without asserting a replacement — e.g. "no longer true". Journalled; history preserved.',
      inputSchema: {
        subject: z.string().min(1).max(2000),
        predicate: z.string().min(1).max(2000),
        validUntil: z.string().optional().describe('ISO date (default today)'),
      },
    },
    safe((input) => invalidateFact(ctx, input)),
  );

  server.registerTool(
    'lore_query_facts',
    {
      title: 'Query facts',
      description:
        'Query the bitemporal fact store. Default: currently-valid facts. asOf answers "what was true on DATE"; includeHistory shows the full supersession chain. Prefer this over lore_search for factual slots (status, location, role, preference).',
      inputSchema: {
        subject: z.string().optional(),
        predicate: z.string().optional(),
        asOf: z.string().optional().describe('ISO date for point-in-time queries'),
        includeHistory: z.boolean().optional(),
      },
    },
    safe((q) => queryFacts(ctx.store, q)),
  );

  server.registerTool(
    'lore_aggregate_facts',
    {
      title: 'Count facts',
      description:
        'Deterministic aggregation over fact history — counts grouped by object/subject/predicate with date-range filters. Use for "how many X", "which Y most often" questions; similarity search cannot answer these reliably.',
      inputSchema: {
        subject: z.string().optional(),
        predicate: z.string().optional(),
        groupBy: z.enum(['object', 'subject', 'predicate']).optional(),
        since: z.string().optional(),
        until: z.string().optional(),
      },
    },
    safe((q) => aggregateFacts(ctx.store, q)),
  );

  server.registerTool(
    'lore_capture',
    {
      title: 'Capture a note',
      description:
        'Append a timestamped line to lore/inbox.md (or another vault note). Use for fleeting observations worth keeping that are not atomic facts. Never overwrites anything.',
      inputSchema: {
        text: z.string().min(1).max(100_000),
        to: z.string().max(1024).optional().describe('target .md path (default lore/inbox.md)'),
      },
    },
    safe(({ text: t, to }) => ({ captured: capture(ctx, t, to) })),
  );

  server.registerTool(
    'lore_mark_used',
    {
      title: 'Mark passage as used',
      description:
        'Reinforce passages that actually contributed to your answer (spaced-repetition signal: used memories decay slower). Call after citing a note.',
      inputSchema: {
        notePath: z.string().min(1).max(1024),
        anchor: z.string().max(1024).optional().describe('block anchor from search results; omit for whole note'),
      },
    },
    safe(({ notePath, anchor }) => ({
      reinforced: markUsed(ctx.store, resolveBlockIds(ctx.store, notePath, anchor)),
    })),
  );

  server.registerTool(
    'lore_dream_report',
    {
      title: 'Consolidation report',
      description:
        'Run the consolidation pass: duplicate passages, contradicting/recently-changed facts, stale knowledge needing review, suggested missing links, orphan notes. Read-only unless apply=true (which writes a digest + review queue under lore/).',
      inputSchema: {
        apply: z.boolean().optional(),
        verbose: z.boolean().optional().describe('return every finding rather than a summary'),
      },
    },
    safe(({ apply, verbose }) => {
      const r = dream(ctx, { apply });
      if (verbose) return r;
      // A summary plus the few findings worth acting on. The full report ran
      // to ~2,600 tokens, most of it long tails nobody reads in one sitting.
      return {
        stats: r.stats,
        totals: r.totals,
        inactive: r.inactive,
        contradictions: r.contradictions.slice(0, 5),
        stale: r.stale.slice(0, 5),
        duplicates: r.duplicates.slice(0, 5).map((d) => ({
          a: `${d.a.notePath}#${d.a.anchor}`,
          b: `${d.b.notePath}#${d.b.anchor}`,
          similarity: d.jaccard,
        })),
        linkSuggestions: r.linkSuggestions.slice(0, 5).map((l) => ({
          from: l.from,
          to: l.to,
          sharedCount: l.sharedCount,
          shared: l.sharedEntities.slice(0, 4),
        })),
        orphans: r.orphans.slice(0, 10),
        written: r.written,
        note: 'summary — pass verbose:true for every finding',
      };
    }),
  );


  server.registerTool(
    'lore_propose_facts',
    {
      title: 'Propose facts from a note',
      description:
        'Returns candidate facts mined from a note\'s structure that are NOT yet in the fact store, for you to adjudicate. The engine only auto-accepts unambiguous field syntax (frontmatter, `key:: value`, `- [key] value`); prose formatting like `- **Owner:** Priya` is precise on entity notes and noisy on report notes, so it is surfaced here instead of assumed. Review these and call lore_assert_fact for the ones that are genuinely durable facts. This keeps judgement with you and out of the index.',
      inputSchema: {
        notePath: z.string().max(1024).optional().describe('limit to one note; omit to sample the vault'),
        limit: z.number().int().min(1).max(200).optional(),
      },
    },
    safe(({ notePath, limit }) => {
      const rows = (
        notePath
          ? ctx.store.db
              .prepare(`SELECT path, title, frontmatter, mtime_ms FROM notes WHERE path=?`)
              .all(notePath)
          : ctx.store.db
              .prepare(`SELECT path, title, frontmatter, mtime_ms FROM notes ORDER BY mtime_ms DESC LIMIT 50`)
              .all()
      ) as { path: string; title: string; frontmatter: string; mtime_ms: number }[];
      if (notePath && rows.length === 0) throw new Error(`no such note: ${notePath}`);
      const blocksFor = ctx.store.db.prepare(
        `SELECT anchor, heading, ord, text, hash FROM blocks WHERE note_path=? ORDER BY ord`,
      );
      const existing = new Set(
        (
          ctx.store.db.prepare(`SELECT subject, predicate, object FROM facts`).all() as {
            subject: string;
            predicate: string;
            object: string;
          }[]
        ).map((r) => `${r.subject}|${r.predicate}|${r.object.toLowerCase()}`),
      );
      const out: unknown[] = [];
      const cap = limit ?? 50;
      for (const n of rows) {
        let fm: Record<string, unknown> = {};
        try {
          fm = JSON.parse(n.frontmatter) as Record<string, unknown>;
        } catch {
          /* ignore */
        }
        const note = {
          path: n.path,
          title: n.title,
          frontmatter: fm,
          tags: [],
          links: [],
          blocks: blocksFor.all(n.path),
          hash: '',
          mtimeMs: n.mtime_ms,
          size: 0,
          warnings: [],
        } as never;
        for (const f of extractFactsFromNote(note, 'all')) {
          const key = `${normalizeKey(f.subject)}|${normalizeKey(f.predicate)}|${f.object.toLowerCase()}`;
          if (existing.has(key)) continue;
          out.push({
            subject: f.subject,
            predicate: f.predicate,
            object: f.object,
            source: `${n.path}${f.blockAnchor ? '#' + f.blockAnchor : ''}`,
            confidence: f.confidence,
          });
          if (out.length >= cap) break;
        }
        if (out.length >= cap) break;
      }
      return { candidates: out, note: 'not yet asserted — call lore_assert_fact for the real ones' };
    }),
  );

  server.registerTool(
    'lore_index',
    {
      title: 'Reindex the vault',
      description:
        'Incrementally sync the markdown vault into the index. Call after writing files to the vault outside lore_* tools.',
      inputSchema: { full: z.boolean().optional() },
    },
    safe(async ({ full }) => {
      const r = await indexVault(ctx.store, ctx.root, { full });
      ctx.invalidateGraph();
      return r;
    }),
  );

  return server;
}

export async function startMcpServer(ctx: LoreContext): Promise<void> {
  // Before serving a single request. An agent handed an empty index does not
  // get an error it can react to — it gets `[]`, and reports to the user that
  // they have nothing written on the subject.
  await ensureIndexed(ctx, (n) =>
    console.error(`[loreweave mcp] first run: indexing ${n} notes…`),
  );
  const server = createLoreMcpServer(ctx);
  const transport = new StdioServerTransport();
  // Without these the server goes permanently deaf on a malformed or
  // oversized message, with an empty stderr and exit code 0 — the worst
  // possible failure mode for something an agent depends on.
  transport.onerror = (err: Error) => {
    console.error(`[loreweave mcp] transport error: ${err.message}`);
    try {
      ctx.close();
    } finally {
      process.exit(1);
    }
  };
  transport.onclose = () => {
    try {
      ctx.close();
    } finally {
      process.exit(0);
    }
  };
  await server.connect(transport);
  // keep process alive; close store on exit
  const shutdown = () => {
    try {
      ctx.close();
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

// direct exec: `node dist/mcp/server.js [vaultPath]`
const argv1 = process.argv[1] ?? '';
if (/server\.(ts|js)$/.test(argv1)) {
  const root = process.argv[2] ? process.argv[2] : findVaultRoot(process.cwd());
  const ctx = openContext(root);
  startMcpServer(ctx).catch((err) => {
    console.error(`loreweave mcp failed: ${(err as Error).message}`);
    process.exit(1);
  });
}
