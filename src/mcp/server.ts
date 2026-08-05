#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { openContext, type LoreContext } from '../context.js';
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

export function createLoreMcpServer(ctx: LoreContext): McpServer {
  const server = new McpServer({ name: 'loreweave', version: '0.1.0' });

  server.registerTool(
    'lore_search',
    {
      title: 'Search the vault',
      description:
        'Hybrid retrieval over the markdown vault: BM25 + knowledge-graph spreading activation (+ dense embeddings when configured). Returns passages with provenance (notePath#anchor), score breakdown, and the entities connecting them to the query. Use for any "what do my notes say about X" question, including multi-hop associations.',
      inputSchema: {
        query: z.string().min(1).max(2000).describe('natural-language query'),
        k: z.number().int().min(1).max(50).optional().describe('max results (default 8)'),
        since: z.string().optional().describe('only notes modified on/after this ISO date'),
      },
    },
    safe(async ({ query, k, since }) => search(ctx, query, { k, since })),
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
      const hits = topic ? await search(ctx, topic, { k: 6 }) : [];
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
      inputSchema: { apply: z.boolean().optional() },
    },
    safe(({ apply }) => dream(ctx, { apply })),
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
