import type { Store } from '../store/db.js';
import { normalizeKey, singularizeKey } from '../normalize.js';
import { queryFacts } from '../facts/model.js';
import { assertIsoDate } from './dates.js';

/**
 * One chronological history of an entity, merged from the two records the
 * engine already keeps and no single query could see together:
 *
 *  - the bitemporal fact store: every value a slot has held, with the change
 *    boundaries the supersede chain preserves ("status was planning until
 *    2022-03-01, then fieldwork") — the COMPUTED history;
 *  - content-dated blocks that mention the entity: what the prose said was
 *    happening, placed at when it happened — the NARRATED history.
 *
 * Answering "what happened to X" used to take manual archaeology: `facts
 * --history` for the chain, then repeated `search --since/--until` sampling
 * for the prose, then merging by hand. The systems that market this exact
 * query (Zep's "what was X before it changed") pay an LLM at ingestion to
 * build the change graph; here the supersede chain has been maintained all
 * along, so the answer is a read-side join.
 */

export interface TimelineEntry {
  /** ISO date this entry belongs at (fact valid-from, or block content time). */
  date: string;
  kind: 'change' | 'mention';
  /** For changes: the slot that changed. */
  predicate?: string;
  /** For changes: the value the slot took. */
  value?: string;
  /** For changes: the value it replaced, when the chain records one. */
  previous?: string;
  /** For changes: when this value stopped holding (null = still current). */
  until?: string | null;
  /** For changes: record time, for "when did we learn this". */
  recordedAt?: string;
  /** For mentions: the block's text (verbatim — prose is never rewritten). */
  text?: string;
  /** Provenance. */
  notePath?: string | null;
  blockAnchor?: string | null;
}

export interface TimelineOptions {
  since?: string;
  until?: string;
  /** Cap on returned entries (most recent kept). Default 200. */
  limit?: number;
}

export function buildTimeline(
  store: Store,
  subject: string,
  opts: TimelineOptions = {},
): TimelineEntry[] {
  assertIsoDate('since', opts.since);
  assertIsoDate('until', opts.until);
  // Two spellings of one key. NLP prose mentions are stored through
  // singularizeKey while fact subjects are not, so an entity whose name ends
  // in a plural ("Redwood Systems") had its facts under one key and its
  // prose mentions under another: timeline() returned changes with no
  // mentions under the real name, and mentions with no changes under the
  // singular — the merged history this tool exists for was unreachable
  // under every spelling, silently.
  const key = normalizeKey(subject);
  const singular = singularizeKey(key);
  const keys = singular === key ? [key] : [key, singular];
  const entries: TimelineEntry[] = [];

  // ── computed history: the fact chains, change-points at valid_from ──────
  const facts = keys.flatMap((k) =>
    queryFacts(store, { subject: k, includeHistory: true, limit: 1000 }),
  );
  // supersededBy points old→new, so invert it once: successor id → the fact
  // it replaced. That is what lets a change entry say "fieldwork (was:
  // planning)" instead of making the reader reconstruct the chain.
  const predecessorOf = new Map<number, (typeof facts)[number]>();
  for (const f of facts) {
    if (f.supersededBy !== null) predecessorOf.set(f.supersededBy, f);
  }
  for (const f of facts) {
    // A mined attribute with no valid time is a description, not an event:
    // `type: station` extracted from frontmatter would otherwise appear as a
    // "change" dated whenever the index happened to run — one line of today-
    // noise per hub page. Stated facts keep their entry even without a valid
    // time: asserting IS an event, and its record date is when it happened.
    if (f.validFrom === null && f.sourceType === 'extracted' && f.supersededBy === null) {
      continue;
    }
    const predecessor = predecessorOf.get(f.id);
    entries.push({
      date: (f.validFrom ?? f.recordedAt).slice(0, 10),
      kind: 'change',
      predicate: f.predicate,
      value: f.object,
      previous: predecessor?.object,
      until: f.validUntil ? f.validUntil.slice(0, 10) : null,
      recordedAt: f.recordedAt,
      notePath: f.notePath,
    });
  }

  // ── narrated history: content-dated blocks mentioning the entity ────────
  const blocks = store.db
    .prepare(
      `SELECT DISTINCT b.note_path, b.anchor, b.text, b.event_from
       FROM mentions m
       JOIN entities e ON e.id = m.entity_id
       JOIN blocks b ON b.note_path = m.note_path AND b.anchor = m.block_anchor
       WHERE e.key IN (${keys.map(() => '?').join(',')})
         AND b.event_from IS NOT NULL AND b.archived = 0
       ORDER BY b.event_from, b.note_path, b.anchor`,
    )
    .all(...keys) as { note_path: string; anchor: string; text: string; event_from: string }[];
  // A journal record block (`- [fact] …` lines) is the WRITE that produced a
  // change entry above — echoing it as a mention narrates every change twice,
  // once as history and once as the machine text that recorded it. Same
  // pattern RECORD_LINE encodes in retrieve/search.ts.
  const recordLine = /^\s*[-*+]\s*\[(fact|invalidate)\]/i;
  const isRecordBlock = (text: string): boolean => {
    let rec = 0;
    let content = 0;
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      if (recordLine.test(line)) rec++;
      else content++;
    }
    return rec > 0 && rec >= content;
  };
  for (const b of blocks) {
    if (isRecordBlock(b.text)) continue;
    entries.push({
      date: b.event_from.slice(0, 10),
      kind: 'mention',
      text: b.text,
      notePath: b.note_path,
      blockAnchor: b.anchor,
    });
  }

  // ── merge: chronological, windowed, capped from the recent end ──────────
  // A TOTAL order, keyed only on content. The old comparator never returned
  // 0 and disagreed with itself on same-kind ties (compare(a,b) and
  // compare(b,a) both returned 1), so same-date entries fell through to row
  // order — and the same vault emitted its history in different orders
  // depending on whether the index was built fresh or incrementally.
  const cmp = (x?: string | null, y?: string | null): number => {
    const a = x ?? '';
    const b = y ?? '';
    return a < b ? -1 : a > b ? 1 : 0;
  };
  let merged = entries.sort(
    (a, b) =>
      cmp(a.date, b.date) ||
      (a.kind === b.kind ? 0 : a.kind === 'change' ? -1 : 1) ||
      cmp(a.notePath, b.notePath) ||
      cmp(a.blockAnchor, b.blockAnchor) ||
      cmp(a.predicate, b.predicate) ||
      cmp(a.value, b.value),
  );
  if (opts.since) merged = merged.filter((e) => e.date >= opts.since!);
  if (opts.until) merged = merged.filter((e) => e.date <= opts.until!);
  const limit = opts.limit ?? 200;
  if (merged.length > limit) merged = merged.slice(merged.length - limit);
  return merged;
}
