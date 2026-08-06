import type { LoreContext } from '../context.js';
import type { SearchResult } from '../types.js';
import { contentTerms, normalizeKey } from '../normalize.js';
import { denseTopK } from '../embed/index.js';
import { ppr } from '../graph/ppr.js';
import { daysBetween, retrievability } from '../dynamics/fsrs.js';
import { expandNotes, seedNotes } from './expand.js';

export interface SearchOptions {
  k?: number;
  /**
   * Only content dated on/after this ISO date. Uses the block's CONTENT time
   * (frontmatter date, dated filename, or dates in the text) — falling back to
   * file mtime only when the content carries no date of its own. Filtering on
   * mtime alone answered "recently edited" when the user asked "what happened
   * in March".
   */
  since?: string;
  /** Only content dated on/before this ISO date. */
  until?: string;
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


/**
 * Pick the part of a block that actually answers the query.
 *
 * FTS5's snippet() centres on whichever term it happens to hit first. On a
 * bulleted note that meant a block whose last line read
 * "Companies to AVOID: Axtria, Analytic Edge" was shown as
 * "...applying now (currently employed)" — the correct result looking like a
 * miss. Markdown is line-structured, so score lines by how many DISTINCT
 * query terms they carry and show the best one with its neighbours.
 */
export function bestSnippet(text: string, terms: string[], rawBudget = 260): string {
  const budget = Math.max(40, rawBudget);
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) return '';
  if (terms.length === 0) return lines.join(' ').slice(0, budget).trim();

  const score = (line: string): number => {
    const l = normalizeKey(line);
    let n = 0;
    for (const t of terms) if (l.includes(t)) n++;
    return n;
  };
  let bestIdx = 0;
  let bestScore = -1;
  lines.forEach((l, i) => {
    const sc = score(l);
    // ties go to the earlier line: it is usually the more general statement
    if (sc > bestScore) {
      bestScore = sc;
      bestIdx = i;
    }
  });
  if (bestScore <= 0) return lines.join(' ').slice(0, budget).trim();

  // The matching line is the answer: include it whole, then spend whatever
  // budget is left on surrounding context. Growing outward first pushed the
  // key line to the end where it got truncated mid-word.
  const best = lines[bestIdx]!.trim();
  const clip = (t: string) => (t.length > budget ? t.slice(0, budget).trimEnd() + ' …' : t);
  if (best.length >= budget) return clip(best.replace(/\s+/g, ' '));

  const after: string[] = [];
  const before: string[] = [];
  let used = best.length;
  let lo = bestIdx;
  let hi = bestIdx;
  while (used < budget) {
    let grew = false;
    if (hi < lines.length - 1) {
      const next = lines[hi + 1]!.trim();
      if (used + next.length + 1 <= budget) {
        after.push(next);
        used += next.length + 1;
        hi++;
        grew = true;
      }
    }
    if (lo > 0) {
      const prev = lines[lo - 1]!.trim();
      if (used + prev.length + 1 <= budget) {
        before.unshift(prev);
        used += prev.length + 1;
        lo--;
        grew = true;
      }
    }
    if (!grew) break;
  }
  return [...before, best, ...after].join(' ').replace(/\s+/g, ' ').trim();
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
  const lexScores = new Map<number, number>();
  lexical.forEach((h, i) => {
    lexicalRanks.set(h.blockId, i + 1);
    lexScores.set(h.blockId, h.score);
  });

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

  // 3b) note-level link expansion — walk real links out from the notes
  // lexical search is most confident about. This is the multi-hop path:
  // the answer note may share no vocabulary with the query at all.
  const expandRanks = new Map<number, number>();
  if (cfg.weights.expansion > 0) {
    const linkGraph = ctx.noteLinks();
    const lexicalNotes: string[] = [];
    const seenNote = new Set<string>();
    for (const h of lexical) {
      if (seenNote.has(h.notePath)) continue;
      seenNote.add(h.notePath);
      lexicalNotes.push(h.notePath);
    }
    const seeds = seedNotes(linkGraph, query, lexicalNotes, cfg.expansionSeeds);
    if (seeds.length > 0) {
      const expanded = expandNotes(linkGraph, seeds, {
        hops: cfg.expansionHops,
        decay: cfg.expansionDecay,
      });
      if (expanded.size > 0) {
        // score each expanded note's blocks, preferring blocks that at least
        // mention a query token so we land on the relevant section
        const notes = [...expanded.entries()].sort((a, b) => b[1] - a[1]).slice(0, cand);
        const placeholders = notes.map(() => '?').join(',');
        const blocks = store.db
          .prepare(
            `SELECT id, note_path, ord, text FROM blocks WHERE note_path IN (${placeholders})
             AND archived = 0 ORDER BY note_path, ord`,
          )
          .all(...notes.map((n) => n[0])) as {
          id: number;
          note_path: string;
          ord: number;
          text: string;
        }[];
        const byNote = new Map<string, number[]>();
        const blockText = new Map<number, string>();
        for (const b of blocks) {
          const arr = byNote.get(b.note_path);
          if (arr) arr.push(b.id);
          else byNote.set(b.note_path, [b.id]);
          blockText.set(b.id, normalizeKey(b.text));
        }
        // Query terms NOT consumed by the entity name that seeded the walk —
        // "Coldspar Traverse hardware" leaves "hardware".
        const seedTokens = new Set(
          seeds.flatMap((sd) => normalizeKey(sd.notePath.split('/').pop() ?? '').split(' ')),
        );
        const residual = normalizeKey(query)
          .split(' ')
          .filter((t) => t.length > 2 && !seedTokens.has(t));
        // One entry per NOTE, not per block. Expansion answers "which notes
        // are linked to what you asked about"; emitting every block of each
        // note just fills the ranking with the same handful of notes and
        // pushes the real answer out of view.
        const scored: { blockId: number; s: number }[] = [];
        for (const [notePath, s] of notes) {
          const ids = byNote.get(notePath) ?? [];
          // Prefer the block that best covers the query terms the named
          // entity did not consume ("Coldspar Traverse *hardware*"); fall
          // back to the note's opening block, which carries its definition.
          let bestId = ids[0];
          if (residual.length > 0 && ids.length > 1) {
            let bestCov = -1;
            for (const id of ids) {
              const t = blockText.get(id) ?? '';
              const cov = residual.filter((r) => t.includes(r)).length;
              if (cov > bestCov) {
                bestCov = cov;
                bestId = id;
              }
            }
          }
          if (bestId !== undefined) scored.push({ blockId: bestId, s });
        }
        scored.sort((a, b) => b.s - a.s);
        scored.slice(0, cand).forEach((h, i) => expandRanks.set(h.blockId, i + 1));
      }
    }
  }

  // 4) weighted RRF fusion
  const lists: RankedList[] = [
    { weight: cfg.weights.lexical, ranks: lexicalRanks },
    { weight: ctx.provider ? cfg.weights.dense : 0, ranks: denseRanks },
  ];
  const fused = new Map<number, number>();
  for (const list of lists) {
    if (list.weight <= 0) continue;
    for (const [blockId, rank] of list.ranks) {
      fused.set(blockId, (fused.get(blockId) ?? 0) + list.weight / (cfg.rrfK + rank));
    }
  }

  // Link expansion is a RECALL mechanism, not a ranking signal. Treated as a
  // peer list it wrecks precision — measured 0.489 -> 0.208 MRR, because a
  // note reached by one link outranked an exact lexical match. So it only
  // BACKFILLS: notes nothing else found are appended strictly below every
  // fused result, where they can add recall but never displace a real hit.
  // ...but appended at the very bottom they land at rank 10-40, which nobody
  // reads — "found" but useless. They are kept in a separate list and spliced
  // into the final ordering by POSITION below (scoring them just under the
  // top hit does not work: dozens of other fused entries sit in between).
  // Promotion applies to any link-reached note that is NOT itself a lexical
  // hit — including ones PPR already surfaced but buried at rank 20-40.
  // (Gating on "not already in the fused set" silently excluded exactly the
  // notes this is for, since PPR reaches the same neighbours.)
  const linkedOnly = new Set<number>();
  if (cfg.weights.expansion > 0 && expandRanks.size > 0) {
    for (const [blockId] of expandRanks) {
      if (!lexicalRanks.has(blockId)) linkedOnly.add(blockId);
      if (!fused.has(blockId)) fused.set(blockId, 0);
    }
  }
  // Entity-PPR is recall too: measured, it adds ~10 points of reach but as a
  // peer ranking list it displaced good lexical hits.
  if (cfg.weights.graph > 0 && graphRanks.size > 0) {
    for (const [blockId] of graphRanks) {
      if (!lexicalRanks.has(blockId)) linkedOnly.add(blockId);
      if (!fused.has(blockId)) fused.set(blockId, 0);
    }
  }
  if (fused.size === 0) return [];

  // 5) load block info, apply time filter + dynamics boosts
  const ids = [...fused.keys()];
  const placeholders = ids.map(() => '?').join(',');
  const rows = ctx.store.db
    .prepare(
      `SELECT b.id, b.note_path, b.anchor, b.heading, b.text, b.stability, b.last_accessed,
              b.importance, b.archived, b.event_from, b.event_to, n.mtime_ms
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
    event_from: string | null;
    event_to: string | null;
    mtime_ms: number;
  }[];
  const now = new Date();
  // Coverage = fraction of the query's distinct terms that actually appear in
  // the block. Unlike a fused rank (near-constant without access history) or
  // raw BM25 (unbounded, corpus-dependent), this is directly interpretable:
  // 0 means the block matched no query term at all.
  const qTerms = [...new Set(contentTerms(query))];
  const lexSnippets = new Map(lexical.map((h) => [h.blockId, h.snippet]));

  const results: SearchResult[] = [];
  for (const r of rows) {
    if (!opts.includeArchived && r.archived) continue;
    // Prefer content time; fall back to file mtime when the note is undated.
    if (opts.since || opts.until) {
      const from = r.event_from ?? new Date(r.mtime_ms).toISOString().slice(0, 10);
      const to = r.event_to ?? from;
      if (opts.since && to < opts.since) continue;
      if (opts.until && from > opts.until) continue;
    }
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
      // Show the line that matched, not wherever FTS5 happened to point.
      snippet: bestSnippet(r.text, qTerms) || (lexSnippets.get(r.id) ?? ''),
      score,
      // Raw BM25 for the caller to judge absolute match strength. The fused
      // score is a rank-fusion artifact: with no access history it is nearly
      // constant, so a nonsense query and a bullseye both scored ~0.0328 and
      // looked identical.
      lexicalScore: lexScores.get(r.id) ?? 0,
      coverage: qTerms.length
        ? Number(
            (
              qTerms.filter((t) => normalizeKey(r.text + ' ' + r.heading).includes(t)).length /
              qTerms.length
            ).toFixed(3),
          )
        : 0,
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
  // Split, then interleave. The first `expansionPromoteAfter` slots stay pure
  // lexical/graph so a confident match is never displaced; after that,
  // linked-but-unmatched notes alternate in, so a reachable answer appears on
  // page one instead of at rank 30.
  const byBlock = new Map(rows.map((r) => [`${r.note_path} ${r.anchor}`, r.id]));
  const isExpansion = (r: SearchResult) =>
    linkedOnly.has(byBlock.get(`${r.notePath} ${r.anchor}`) ?? -1);
  const primary = results.filter((r) => !isExpansion(r)).sort((a, b) => b.score - a.score);
  const linked = results
    .filter(isExpansion)
    .sort((a, b) => {
      // link-reached notes first (high precision), then PPR-only ones
      const rank = (r: SearchResult) => {
        const id = byBlock.get(`${r.notePath} ${r.anchor}`) ?? -1;
        const e = expandRanks.get(id);
        if (e !== undefined) return e;
        const g = graphRanks.get(id);
        return g !== undefined ? 1000 + g : 1e9;
      };
      return rank(a) - rank(b);
    });
  const merged: SearchResult[] = primary.slice(0, cfg.expansionPromoteAfter);
  let pi = cfg.expansionPromoteAfter;
  let li = 0;
  while (pi < primary.length || li < linked.length) {
    if (li < linked.length) merged.push(linked[li++]!);
    if (pi < primary.length) merged.push(primary[pi++]!);
  }
  const top = merged.slice(0, k);

  if (!opts.noLog) {
    const idByAnchor = new Map(rows.map((r) => [`${r.note_path} ${r.anchor}`, r.id]));
    for (const t of top) {
      const id = idByAnchor.get(`${t.notePath} ${t.anchor}`);
      if (id !== undefined) store.logAccess('retrieved', id, query);
    }
  }
  return top;
}
