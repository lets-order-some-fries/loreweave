/**
 * Deterministic temporal parsing — no LLM, no dependencies.
 *
 * Two jobs:
 *  1. `parseQueryTime` — work out whether a question is asking about a point
 *     in the past ("where did I live in 2023", "what was the status before
 *     August") or a window, so the fact store can be queried with `asOf`
 *     instead of silently answering with today's value.
 *  2. `extractDates` — pull content dates out of note text/frontmatter so
 *     retrieval can filter on when something HAPPENED rather than when the
 *     file was last touched.
 */

const MONTHS: Record<string, number> = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7,
  august: 8, september: 9, october: 10, november: 11, december: 12,
  jan: 1, feb: 2, mar: 3, apr: 4, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9,
  oct: 10, nov: 11, dec: 12,
};

const pad = (n: number) => String(n).padStart(2, '0');
const lastDay = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();

export interface DateRange {
  from: string; // inclusive ISO date
  to: string; // inclusive ISO date
}

/** Parse a single date expression into an inclusive range. */
export function parseDateExpression(text: string): DateRange | null {
  const s = text.trim().toLowerCase();

  // 2026-08-05 — validated: an impossible date (2026-13-01, 2026-02-31)
  // would otherwise be stored as content time and sort nonsensically.
  let m = s.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (m) {
    const y = Number(m[1]);
    const mo = Number(m[2]);
    const day = Number(m[3]);
    if (mo >= 1 && mo <= 12 && day >= 1 && day <= lastDay(y, mo)) {
      const d = `${m[1]}-${m[2]}-${m[3]}`;
      return { from: d, to: d };
    }
    return null;
  }
  // 2026-08
  m = s.match(/\b(\d{4})-(\d{2})\b/);
  if (m) {
    const y = Number(m[1]);
    const mo = Number(m[2]);
    if (mo >= 1 && mo <= 12) {
      return { from: `${m[1]}-${m[2]}-01`, to: `${m[1]}-${m[2]}-${pad(lastDay(y, mo))}` };
    }
  }
  // Q3 2026
  m = s.match(/\bq([1-4])\s*(?:of\s*)?(\d{4})\b/);
  if (m) {
    const q = Number(m[1]);
    const y = m[2]!;
    const startMonth = (q - 1) * 3 + 1;
    const endMonth = startMonth + 2;
    return {
      from: `${y}-${pad(startMonth)}-01`,
      to: `${y}-${pad(endMonth)}-${pad(lastDay(Number(y), endMonth))}`,
    };
  }
  // August 2026 / Aug 2026
  m = s.match(/\b([a-z]{3,9})\.?\s+(\d{4})\b/);
  if (m && MONTHS[m[1]!] !== undefined) {
    const mo = MONTHS[m[1]!]!;
    const y = m[2]!;
    return { from: `${y}-${pad(mo)}-01`, to: `${y}-${pad(mo)}-${pad(lastDay(Number(y), mo))}` };
  }
  // bare year
  m = s.match(/\b(19|20|21)(\d{2})\b/);
  if (m) {
    const y = `${m[1]}${m[2]}`;
    return { from: `${y}-01-01`, to: `${y}-12-31` };
  }
  return null;
}

export type TemporalIntent =
  | { kind: 'none' }
  | { kind: 'asOf'; date: string; phrase: string }
  | { kind: 'range'; from: string; to: string; phrase: string }
  | { kind: 'history'; phrase: string };

const BEFORE_RE = /\b(before|prior to|up to|until|as of|by)\b/;
const AFTER_RE = /\b(after|since|from)\b/;
const PAST_RE = /\b(was|were|used to|previously|originally|formerly|back (?:then|in)|at the time)\b/;
const HISTORY_RE = /\b(history|changed|change over time|evolution|timeline|ever been|used to be)\b/;

/**
 * Classify a question's temporal intent. Deliberately conservative: when in
 * doubt it returns `none` so behaviour is unchanged, because a wrong `asOf`
 * silently hides current facts.
 */
export function parseQueryTime(query: string): TemporalIntent {
  const q = query.toLowerCase();

  if (HISTORY_RE.test(q)) return { kind: 'history', phrase: 'history' };

  const range = parseDateExpression(q);

  // "before X" / "prior to X" → as of the day before that window starts
  if (BEFORE_RE.test(q) && range) {
    const d = new Date(`${range.from}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - 1);
    return { kind: 'asOf', date: d.toISOString().slice(0, 10), phrase: 'before' };
  }
  // "in 2023" / "during August 2024" with past-tense phrasing → as of window end
  if (range && (PAST_RE.test(q) || AFTER_RE.test(q))) {
    if (AFTER_RE.test(q) && !PAST_RE.test(q)) {
      return { kind: 'range', from: range.from, to: range.to, phrase: 'since' };
    }
    return { kind: 'asOf', date: range.to, phrase: 'at that time' };
  }
  // A bare past date with no tense cue ("where did I live in 2023") is still a
  // scoping signal. Answer as of the end of that window: the only consumer,
  // `ask`, maps asOf but not range, so returning `range` here left it with no
  // scope and it answered from CURRENT facts — the exact thing this branch
  // exists to prevent, and flipping to the right answer only when a past-tense
  // verb happened to be present ("what WAS my role in 2023").
  if (range && range.to < new Date().toISOString().slice(0, 10)) {
    return { kind: 'asOf', date: range.to, phrase: 'dated' };
  }
  return { kind: 'none' };
}

/**
 * Extract content dates from note text. Returns the earliest and latest dates
 * mentioned, which is what "when is this note about" means in practice.
 */
export function extractDates(text: string, frontmatter: Record<string, unknown> = {}): DateRange | null {
  // frontmatter wins: date / created / valid_from
  for (const key of ['date', 'event_date', 'created', 'valid_from']) {
    const v = frontmatter[key];
    if (typeof v === 'string') {
      const r = parseDateExpression(v);
      if (r) return r;
    }
    if (v instanceof Date && !Number.isNaN(v.valueOf())) {
      const d = v.toISOString().slice(0, 10);
      return { from: d, to: d };
    }
  }
  const found: string[] = [];
  const iso = text.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g);
  for (const m of iso) {
    const y = Number(m[1]);
    const mo = Number(m[2]);
    const day = Number(m[3]);
    if (mo >= 1 && mo <= 12 && day >= 1 && day <= lastDay(y, mo)) {
      found.push(`${m[1]}-${m[2]}-${m[3]}`);
    }
    if (found.length > 200) break;
  }
  if (found.length === 0) return null;
  found.sort();
  return { from: found[0]!, to: found[found.length - 1]! };
}
