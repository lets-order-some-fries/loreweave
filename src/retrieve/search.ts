import type { LoreContext } from '../context.js';
import type { SearchResult } from '../types.js';
import { STOPWORDS, contentTerms, normalizeKey } from '../normalize.js';
import { denseTopK } from '../embed/index.js';
import { ppr } from '../graph/ppr.js';
import { daysBetween, retrievability } from '../dynamics/fsrs.js';
import { expandNotes, seedNotes } from './expand.js';
import { assertIsoDate, queryContentWindow } from '../temporal/dates.js';

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
  /** Optional per-entity IDF (see LoreGraph.entityIdf); scales seed mass. */
  idfFor?: (entityNodeIdx: number) => number,
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
      // Longer entity names get more seed mass; ubiquitous ones get less. A
      // floor keeps a common-but-real topic seeded rather than silenced —
      // this decides emphasis, not membership.
      const mass = len * Math.max(0.15, idfFor ? idfFor(idx) : 1);
      if (!prev || prev.mass < mass) found.set(idx, { key: gram, mass });
    }
  }
  return found;
}



/**
 * A `- [fact] S :: p :: o {…}` line: this project's own record syntax, which
 * the journal writes on every assert.
 *
 * It is machine text for the same reason a fenced diagram is. It restates the
 * vocabulary of the prose it records, so it competes on term coverage with the
 * notes that actually explain the thing — and it grows: every fact asserted
 * appends another line to a journal that is indexed on purpose, so the more
 * the fact store is used the more search fills with the record of using it.
 * Measured, `ask "who leads project atlas"` returned a journal line about the
 * project's STATUS above the prose note naming the lead, directly below a
 * "Facts (currently valid)" section that had already said it properly.
 */
const RECORD_LINE = /^\s*[-*+]\s*\[(fact|invalidate)\]/i;

/** Per-line mask of lines that are machine text: code fences and record lines. */
function fencedMask(lines: string[]): boolean[] {
  const mask: boolean[] = [];
  let fenced = false;
  for (const l of lines) {
    const marker = /^\s*(```|~~~)/.test(l);
    if (marker) fenced = !fenced;
    mask.push(fenced || marker || RECORD_LINE.test(l));
  }
  return mask;
}

/**
 * True when a block is nothing but machine text — a mermaid or graphviz
 * diagram, a JSON dump, a config listing, or a run of `- [fact]` record lines.
 *
 * Such a block is a trap for term coverage: generated source restates the
 * vocabulary of the prose it illustrates, so it matches as well as the prose
 * while being unreadable as an answer. Measured on a real docs vault, "what
 * should I do when a test fails" chose an 800-character `digraph tdd_cycle {
 * … label="RED\nWrite failing test" … }` over the sibling section that says,
 * in words, what to do — same heading, same query terms, no answer.
 *
 * Code is not disqualifying: often the example IS the answer. It just has to
 * beat the readable alternative outright rather than on a tie.
 */
function isAllFencedSource(text: string): boolean {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) return false;
  return fencedMask(lines).every(Boolean);
}

/**
 * Collapse a block ranking to one entry per note, replacing each note's block
 * with whichever of ITS blocks best covers the query — including blocks that
 * never entered the candidate set.
 */
function pickBestBlockPerNote(
  ctx: LoreContext,
  ranked: SearchResult[],
  qTerms: string[],
  k: number,
): SearchResult[] {
  const out: SearchResult[] = [];
  const seen = new Set<string>();
  // Same rule as the main coverage assignment: when the query is nothing but
  // function words there are no content words to have matched, so a share of
  // them is not a coverage figure. Recomputed here rather than passed in
  // because this function replaces the coverage it was given.
  const noContentWords = qTerms.length > 0 && qTerms.every((t) => STOPWORDS.has(t));
  const stmt = ctx.store.db.prepare(
    `SELECT anchor, heading, text FROM blocks WHERE note_path=? AND archived=0 ORDER BY ord`,
  );
  for (const r of ranked) {
    if (seen.has(r.notePath)) continue;
    seen.add(r.notePath);
    let best = r;
    if (qTerms.length > 0) {
      const blocks = stmt.all(r.notePath) as { anchor: string; heading: string; text: string }[];
      let bestCov = -1;
      for (const b of blocks) {
        const hay = normalizeKey(`${b.heading} ${b.text}`);
        const cov = qTerms.filter((t) => hay.includes(t)).length;
        // Half a term of penalty, so a block of pure generated source has to
        // cover strictly MORE of the query than a readable one to be chosen.
        const score = cov - (isAllFencedSource(b.text) ? 0.5 : 0);
        // ties keep the originally ranked block: it won on the full signal
        if (score > bestCov) {
          bestCov = score;
          if (b.anchor !== r.anchor) {
            best = {
              ...r,
              anchor: b.anchor,
              heading: b.heading,
              snippet: bestSnippet(b.text, qTerms),
              coverage:
                noContentWords || !qTerms.length
                  ? 0
                  : Number((cov / qTerms.length).toFixed(3)),
            };
          } else {
            best = r;
          }
        }
      }
    }
    out.push(best);
    if (out.length >= k) break;
  }
  return out;
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
  // Lines that are pure markup carry no answer and read as noise when shown.
  const isMarkup = (l: string) =>
    /^\s*(<[^>]+>\s*)+$/.test(l) ||
    /^\s*[-=*_]{3,}\s*$/.test(l) ||
    /^\s*<\/?\w+[^>]*>\s*$/.test(l);
  const clip = (t: string) =>
    t.length > budget ? `${t.slice(0, budget).trimEnd()} …` : t;
  // Tags are layout, not content: a snippet is for reading, so `<h1
  // align="center">Loreweave</h1>` should read as "Loreweave". The indexed
  // text keeps the original — only the display is cleaned.
  const stripTags = (t: string) => t.replace(/<\/?[a-zA-Z][^>]{0,120}>/g, ' ');
  // A bare fence marker is punctuation for the renderer, not content. Left in,
  // a preview reads "``` Confirm: - Test fails" and spends its first
  // characters on nothing. Display-only: scoring still sees the real lines.
  const isFenceMarker = (l: string) => /^\s*(```|~~~)\S*\s*$/.test(l);
  const join = (ls: string[]) =>
    stripTags(ls.filter((l) => !isMarkup(l) && !isFenceMarker(l)).join(' '))
      .replace(/\s+/g, ' ')
      .trim();
  if (terms.length === 0) return clip(join(lines));

  const norm = lines.map((l) => normalizeKey(l));

  // Which lines sit inside a fenced code block. Code is not disqualifying — an
  // example is often exactly the answer, and the best snippets read as prose
  // that runs into one. But a window made of NOTHING but fenced source is a
  // bad preview even when it matches well, because generated source repeats
  // the vocabulary of the prose around it. Measured on a real docs vault,
  // "what should I do when a test fails" returned the correct section of the
  // TDD skill showing `digraph tdd_cycle { rankdir=LR; red [label="RED…` —
  // right answer, unreadable evidence.
  const inFence: boolean[] = [];
  let fenced = false;
  for (const l of lines) {
    const isFenceMarker = /^\s*(```|~~~)/.test(l);
    if (isFenceMarker) fenced = !fenced;
    inFence.push(fenced || isFenceMarker);
  }

  // Score WINDOWS, not single lines: markdown is usually hard-wrapped, so the
  // sentence that answers a query is routinely split across two lines. Scoring
  // lines alone let "…the index is a" / "cache you can delete…" each count 1,
  // losing to an unrelated earlier line that also counted 1.
  let bestStart = 0;
  let bestEnd = 0;
  let bestScore = -1;
  for (let i = 0; i < lines.length; i++) {
    if (isMarkup(lines[i]!)) continue;
    const covered = new Set<string>();
    let used = 0;
    let allCode = true;
    for (let j = i; j < lines.length; j++) {
      used += lines[j]!.length + 1;
      if (used > budget && j > i) break;
      for (const t of terms) if (norm[j]!.includes(t)) covered.add(t);
      if (!inFence[j]) allCode = false;
      // Two penalties, both smaller than one query term, so neither can beat
      // genuinely better coverage — they only decide ties:
      //   · all-source windows must out-cover a readable one to be shown;
      //   · a window that OPENS in source loses to the same coverage starting
      //     at prose, because whatever leads the preview is what gets read.
      const score = covered.size - (allCode ? 0.5 : 0) - (inFence[i] ? 0.25 : 0);
      // prefer the tightest window achieving this coverage
      if (score > bestScore) {
        bestScore = score;
        bestStart = i;
        bestEnd = j;
      }
      if (used > budget) break;
    }
  }
  if (bestScore <= 0) {
    const firstProse = lines.findIndex((l) => !isMarkup(l));
    return clip(join(lines.slice(Math.max(0, firstProse))));
  }

  // Include the winning window whole, then spend leftover budget on context.
  const core = lines.slice(bestStart, bestEnd + 1).map((l) => l.trim());
  let used = core.reduce((n, l) => n + l.length + 1, 0);
  if (used >= budget) return clip(join(core));
  const before: string[] = [];
  const after: string[] = [];
  let lo = bestStart;
  let hi = bestEnd;
  while (used < budget) {
    let grew = false;
    if (hi < lines.length - 1 && !isMarkup(lines[hi + 1]!)) {
      const next = lines[hi + 1]!.trim();
      if (used + next.length + 1 <= budget) {
        after.push(next);
        used += next.length + 1;
        hi++;
        grew = true;
      }
    } else if (hi < lines.length - 1) {
      hi++; // skip markup without spending budget
      grew = true;
    }
    // Context grows FORWARD into code but never BACKWARD into it. A snippet
    // that runs from prose into its example reads well — "dispatch them in one
    // response: ```text Subagent(...)" — while the same two pieces in the
    // other order bury the answer behind a wall of source the reader must
    // scroll past. Whatever leads the preview is what gets read.
    if (lo > 0 && !isMarkup(lines[lo - 1]!) && !inFence[lo - 1]) {
      const prev = lines[lo - 1]!.trim();
      if (used + prev.length + 1 <= budget) {
        before.unshift(prev);
        used += prev.length + 1;
        lo--;
        grew = true;
      }
    } else if (lo > 0 && !inFence[lo - 1]) {
      lo--; // skip markup
      grew = true;
    }
    if (!grew) break;
  }
  return join([...before, ...core, ...after]);
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
  // A malformed window silently mis-filters: `to < 'garbage'` is a string
  // comparison that drops or keeps rows by ASCII accident, so the caller gets
  // an authoritative-looking empty result instead of an error. Fail loudly,
  // the same way the fact store validates its own date arguments.
  assertIsoDate('since', opts.since);
  assertIsoDate('until', opts.until);
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
  const matched = matchQueryEntities(query, graph.entityKeyIndex, (idx) =>
    graph.entityIdf[idx - graph.blockCount] ?? 1,
  );
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
  // `contentTerms` falls back to the raw tokens when a query is nothing but
  // function words, so that a search never silently returns nothing. Good
  // rule; the reporting was not. Matching "the of and a an" against a note
  // scored coverage 0.8, which the MCP layer renders as "80% of query terms" —
  // true, uninformative, and read by an agent as strong relevance. Coverage is
  // a claim about content words, and here there were none.
  const noContentWords = qTerms.length > 0 && qTerms.every((t) => STOPWORDS.has(t));
  const lexSnippets = new Map(lexical.map((h) => [h.blockId, h.snippet]));

  // The window the query itself names ("in March 2025", "before Q3 2026") —
  // a soft scoring signal, never a filter, and only when the caller has not
  // scoped explicitly (an explicit --since/--until IS the temporal intent).
  // A counting question is exempt: in "how many traverses ran in 2022?" the
  // window scopes the AGGREGATE, not retrieval emphasis — boosting the dated
  // instances buries the summary note that actually states the count, and
  // the computable layer (`count`, fact aggregates) owns that window anyway.
  const aggregateQuery = /\b(how many|how much|number of|count of|total)\b/i.test(query);
  const qWindow =
    opts.since || opts.until || cfg.boosts.temporal <= 0 || aggregateQuery
      ? null
      : queryContentWindow(query);
  // A block is temporal evidence for the window in either of two ways: its
  // prose is DATED inside it (a journal entry about that June), or it records
  // a FACT whose valid time overlaps it (an undated entity page whose
  // supersession history says what was true then). Vaults split cleanly on
  // which shape they use — journal-style vaults date their notes, reference-
  // style vaults keep history on hub pages — and boosting only the first
  // shape demoted exactly the notes that answer "what was X before Y" in the
  // second. A fact with no temporal bounds at all is evidence of nothing.
  let factDated: Set<string> | null = null;
  if (qWindow !== null) {
    const hits = ctx.store.db
      .prepare(
        `SELECT DISTINCT note_path, block_anchor FROM facts
         WHERE note_path IS NOT NULL AND block_anchor IS NOT NULL
           AND NOT (valid_from IS NULL AND valid_until IS NULL)
           AND (? IS NULL OR valid_from IS NULL OR valid_from <= ?)
           AND (? IS NULL OR valid_until IS NULL OR valid_until >= ?)`,
      )
      .all(
        qWindow.to ?? null,
        qWindow.to ?? null,
        qWindow.from ?? null,
        qWindow.from ?? null,
      ) as { note_path: string; block_anchor: string }[];
    factDated = new Set(hits.map((h) => `${h.note_path} ${h.block_anchor}`));
  }
  const overlapsWindow = (r: (typeof rows)[number]): boolean =>
    qWindow !== null &&
    ((r.event_from !== null &&
      (qWindow.to === undefined || r.event_from <= qWindow.to) &&
      (qWindow.from === undefined || (r.event_to ?? r.event_from) >= qWindow.from)) ||
      (factDated !== null && factDated.has(`${r.note_path} ${r.anchor}`)));
  // Temporal evidence is only as strong as it is rare — the same logic
  // entityIdf applies to hub entities. One candidate dated in the window is
  // a strong signal ("the note about that June"); twenty candidates dated in
  // the window ("how many traverses ran in 2022?", where every 2022 log
  // matches) means being in-window distinguishes nothing, and a flat boost
  // there shoves the undated summary note that actually holds the answer
  // below a wall of dated bystanders. Measured on the kestrel corpus: a flat
  // boost demoted exactly the fact-history and aggregate golds (their answer
  // notes are undated) while the meridian corpus, whose answers ARE dated
  // notes, wanted the boost at full strength. Rarity scaling serves both.
  // A block that is mostly `- [fact]`/`- [invalidate]` record lines is the
  // LOG of assertions, not content about a period — the same reasoning
  // RECORD_LINE encodes for term coverage. Boosting record blocks put the
  // dated fact journal above the prose pages that explain what those facts
  // mean, on exactly the windowed queries where the prose is the answer.
  const isRecordBlock = (text: string): boolean => {
    let rec = 0;
    let content = 0;
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      if (RECORD_LINE.test(line)) rec++;
      else content++;
    }
    return rec > 0 && rec >= content;
  };
  let boostedBlocks: Set<number> | null = null;
  if (qWindow !== null) {
    boostedBlocks = new Set();
    for (const r of rows) {
      if (!opts.includeArchived && r.archived) continue;
      if (overlapsWindow(r) && !isRecordBlock(r.text)) boostedBlocks.add(r.id);
    }
  }
  const temporalWeight =
    boostedBlocks !== null && boostedBlocks.size > 0
      ? cfg.boosts.temporal / (1 + Math.log2(boostedBlocks.size))
      : 0;

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
    // Temporal emphasis rewards evidence only: a block with a REAL content
    // date overlapping the query's window. Undated blocks stay neutral —
    // mtime says when a file was touched, not when its events happened, and
    // boosting on it would reward recently-edited notes for naming no date.
    const score =
      base +
      cfg.boosts.retrievability * R * base +
      cfg.boosts.importance * r.importance * base +
      (temporalWeight > 0 && boostedBlocks!.has(r.id) ? temporalWeight * base : 0);

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
      score: Number(score.toFixed(6)),
      // Raw BM25 for the caller to judge absolute match strength. The fused
      // score is a rank-fusion artifact: with no access history it is nearly
      // constant, so a nonsense query and a bullseye both scored ~0.0328 and
      // looked identical.
      lexicalScore: Number((lexScores.get(r.id) ?? 0).toFixed(3)),
      coverage: noContentWords
        ? 0
        : qTerms.length
        ? Number(
            (
              qTerms.filter((t) => normalizeKey(r.text + ' ' + r.heading).includes(t)).length /
              qTerms.length
            ).toFixed(3),
          )
        : 0,
      parts: {
        lexical: Number((lexicalRanks.has(r.id) ? 1 / (cfg.rrfK + lexicalRanks.get(r.id)!) : 0).toFixed(6)),
        dense: Number((denseRanks.has(r.id) ? 1 / (cfg.rrfK + denseRanks.get(r.id)!) : 0).toFixed(6)),
        graph: Number((graphRanks.has(r.id) ? 1 / (cfg.rrfK + graphRanks.get(r.id)!) : 0).toFixed(6)),
        retrievability: Number(R.toFixed(4)),
        importance: Number(r.importance.toFixed(4)),
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
  // A stable, content-derived tie-break so a result set is a function of the
  // vault and not of how the index happened to be built. Array.sort is stable,
  // so without this the order fell through to insertion order, which traces
  // back to block rowids.
  const byPath = (a: SearchResult, b: SearchResult) =>
    a.notePath < b.notePath ? -1 : a.notePath > b.notePath ? 1
      : a.anchor < b.anchor ? -1 : a.anchor > b.anchor ? 1 : 0;
  const primary = results
    .filter((r) => !isExpansion(r))
    .sort((a, b) => b.score - a.score || byPath(a, b));
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
      return rank(a) - rank(b) || byPath(a, b);
    });
  const merged: SearchResult[] = primary.slice(0, cfg.expansionPromoteAfter);
  let pi = cfg.expansionPromoteAfter;
  let li = 0;
  while (pi < primary.length || li < linked.length) {
    if (li < linked.length) merged.push(linked[li++]!);
    if (pi < primary.length) merged.push(primary[pi++]!);
  }
  // One entry per note, showing that note's most relevant block.
  //
  // Measured: in 10 of 40 questions the right NOTE ranked in the top 5 while
  // the block holding the literal answer sat at rank 18-36 — we surfaced the
  // right note and then showed the wrong section of it. Ranking decides which
  // notes matter; within a note, query-term coverage decides which block.
  const top = cfg.oneBlockPerNote ? pickBestBlockPerNote(ctx, merged, qTerms, k) : merged.slice(0, k);

  if (!opts.noLog) {
    const idByAnchor = new Map(rows.map((r) => [`${r.note_path} ${r.anchor}`, r.id]));
    for (const t of top) {
      const id = idByAnchor.get(`${t.notePath} ${t.anchor}`);
      if (id !== undefined) store.logAccess('retrieved', id, query);
    }
  }
  return top;
}
