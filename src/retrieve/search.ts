import type { LoreContext } from '../context.js';
import type { SearchResult } from '../types.js';
import { normalizeKey } from '../normalize.js';
import { denseTopK } from '../embed/index.js';
import { ppr } from '../graph/ppr.js';
import { daysBetween, retrievability } from '../dynamics/fsrs.js';

export interface SearchOptions {
  k?: number;
  /** Only notes modified on/after this ISO date. */
  since?: string;
  /** Include archived blocks. */
  includeArchived?: boolean;
  /** Skip access logging (for internal/dream calls). */
  noLog?: boolean;
}

/** Match query n-grams (1..4 tokens) against known entity keys; longer wins. */
export function matchQueryEntities(
  query: string,
  entityKeyIndex: Map<string, number>,
): Map<number, { key: string; mass: number }> {
  const tokens = normalizeKey(query).split(' ').filter(Boolean);
  const found = new Map<number, { key: string; mass: number }>();
  const claimed = new Set<number>(); // token positions already inside a longer match
  for (let len = Math.min(4, tokens.length); len >= 1; len--) {
    for (let i = 0; i + len <= tokens.length; i++) {
      let overlap = false;
      for (let j = i; j < i + len; j++) if (claimed.has(j)) overlap = true;
      if (overlap) continue;
      const gram = tokens.slice(i, i + len).join(' ');
      const idx = entityKeyIndex.get(gram);
      if (idx === undefined) continue;
      for (let j = i; j < i + len; j++) claimed.add(j);
      const prev = found.get(idx);
      const mass = len; // longer entity names get more seed mass
      if (!prev || prev.mass < mass) found.set(idx, { key: gram, mass });
    }
  }
  return found;
}

interface RankedList {
  weight: number;
  /** blockId → rank (1-based) */
  ranks: Map<number, number>;
}

/**
 * Hybrid retrieval: FTS5 BM25 + dense (if provider) + entity/dense-seeded
 * Personalized PageRank, fused with weighted RRF, boosted by FSRS
 * retrievability and importance. Works with zero configuration (lexical +
 * graph only) and upgrades transparently when embeddings exist.
 */
export async function search(
  ctx: LoreContext,
  query: string,
  opts: SearchOptions = {},
): Promise<SearchResult[]> {
  const cfg = ctx.config.retrieval;
  const k = opts.k ?? cfg.k;
  const cand = cfg.candidates;
  const store = ctx.store;

  // 1) lexical
  const lexical = store.searchLexical(query, cand, opts.includeArchived);
  const lexicalRanks = new Map<number, number>();
  lexical.forEach((h, i) => lexicalRanks.set(h.blockId, i + 1));

  // 2) dense
  let denseRanks = new Map<number, number>();
  const denseScores = new Map<number, number>();
  if (ctx.provider) {
    try {
      const [qvec] = await ctx.provider.embed([query]);
      if (qvec) {
        const hits = denseTopK(store, qvec, cand);
        hits.forEach((h, i) => {
          denseRanks.set(h.blockId, i + 1);
          denseScores.set(h.blockId, h.score);
        });
      }
    } catch (err) {
      console.error(`[loreweave] dense retrieval unavailable: ${(err as Error).message}`);
      denseRanks = new Map();
    }
  }

  // 3) graph: PPR seeded by matched query entities + dense/lexical block hits
  const graph = ctx.graph();
  const seeds = new Map<number, number>();
  const matched = matchQueryEntities(query, graph.entityKeyIndex);
  for (const [idx, m] of matched) seeds.set(idx, m.mass * 2);
  for (const [blockId, score] of denseScores) {
    const idx = graph.blockIndex.get(blockId);
    if (idx !== undefined && score > 0) seeds.set(idx, (seeds.get(idx) ?? 0) + score);
  }
  lexical.slice(0, 10).forEach((h, i) => {
    const idx = graph.blockIndex.get(h.blockId);
    if (idx !== undefined) seeds.set(idx, (seeds.get(idx) ?? 0) + 1 / (i + 1));
  });
  const graphRanks = new Map<number, number>();
  let pprScores: Float64Array | null = null;
  if (seeds.size > 0) {
    pprScores = ppr(graph, seeds, { alpha: cfg.pprAlpha, iterations: cfg.pprIterations });
    const blockScores: { blockId: number; s: number }[] = [];
    for (let i = 0; i < graph.blockCount; i++) {
      const s = pprScores[i]!;
      if (s > 0) blockScores.push({ blockId: graph.nodeDbId[i]!, s });
    }
    blockScores.sort((a, b) => b.s - a.s);
    blockScores.slice(0, cand).forEach((h, i) => graphRanks.set(h.blockId, i + 1));
  }

  // 4) weighted RRF fusion
  const lists: RankedList[] = [
    { weight: cfg.weights.lexical, ranks: lexicalRanks },
    { weight: ctx.provider ? cfg.weights.dense : 0, ranks: denseRanks },
    { weight: cfg.weights.graph, ranks: graphRanks },
  ];
  const fused = new Map<number, number>();
  for (const list of lists) {
    if (list.weight <= 0) continue;
    for (const [blockId, rank] of list.ranks) {
      fused.set(blockId, (fused.get(blockId) ?? 0) + list.weight / (cfg.rrfK + rank));
    }
  }
  if (fused.size === 0) return [];

  // 5) load block info, apply time filter + dynamics boosts
  const ids = [...fused.keys()];
  const placeholders = ids.map(() => '?').join(',');
  const rows = ctx.store.db
    .prepare(
      `SELECT b.id, b.note_path, b.anchor, b.heading, b.text, b.stability, b.last_accessed,
              b.importance, b.archived, n.mtime_ms
       FROM blocks b JOIN notes n ON n.path = b.note_path
       WHERE b.id IN (${placeholders})`,
    )
    .all(...ids) as {
    id: number;
    note_path: string;
    anchor: string;
    heading: string;
    text: string;
    stability: number;
    last_accessed: string | null;
    importance: number;
    archived: number;
    mtime_ms: number;
  }[];
  const now = new Date();
  const sinceMs = opts.since ? Date.parse(opts.since) : null;
  const lexSnippets = new Map(lexical.map((h) => [h.blockId, h.snippet]));

  const results: SearchResult[] = [];
  for (const r of rows) {
    if (!opts.includeArchived && r.archived) continue;
    if (sinceMs !== null && !Number.isNaN(sinceMs) && r.mtime_ms < sinceMs) continue;
    const days = daysBetween(r.last_accessed, now);
    const R = r.last_accessed ? retrievability(days, r.stability) : 0.5;
    const base = fused.get(r.id)!;
    const score =
      base + cfg.boosts.retrievability * R * base + cfg.boosts.importance * r.importance * base;

    // explanation: matched entities adjacent to this block in the graph
    const via: string[] = [];
    const bIdx = graph.blockIndex.get(r.id);
    if (bIdx !== undefined && matched.size > 0) {
      for (let e = graph.offsets[bIdx]!; e < graph.offsets[bIdx + 1]!; e++) {
        const nb = graph.neighbors[e]!;
        const m = matched.get(nb);
        if (m) via.push(m.key);
      }
    }

    results.push({
      notePath: r.note_path,
      anchor: r.anchor,
      heading: r.heading,
      snippet: lexSnippets.get(r.id) ?? r.text.slice(0, 240).replace(/\s+/g, ' ').trim(),
      score,
      parts: {
        lexical: lexicalRanks.has(r.id) ? 1 / (cfg.rrfK + lexicalRanks.get(r.id)!) : 0,
        dense: denseRanks.has(r.id) ? 1 / (cfg.rrfK + denseRanks.get(r.id)!) : 0,
        graph: graphRanks.has(r.id) ? 1 / (cfg.rrfK + graphRanks.get(r.id)!) : 0,
        retrievability: R,
        importance: r.importance,
      },
      via: [...new Set(via)],
    });
  }
  results.sort((a, b) => b.score - a.score);
  const top = results.slice(0, k);

  if (!opts.noLog) {
    const idByAnchor = new Map(rows.map((r) => [`${r.note_path} ${r.anchor}`, r.id]));
    for (const t of top) {
      const id = idByAnchor.get(`${t.notePath} ${t.anchor}`);
      if (id !== undefined) store.logAccess('retrieved', id, query);
    }
  }
  return top;
}
