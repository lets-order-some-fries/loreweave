import type { Store } from './store/db.js';
import { assertIsoDate } from './temporal/dates.js';

/**
 * "Since you last connected": the delta an agent needs to continue where a
 * previous session left off, computed from record time.
 *
 * Session continuity is the most-used capability of memory MCP servers, and
 * the popular implementations get it by running an LLM over the previous
 * session at shutdown and injecting the summary at startup — a paraphrase,
 * unreproducible, and wrong exactly when it matters. The engine already
 * records when every note changed (mtime) and when every fact was recorded
 * and superseded (transaction time), so the same continuity is a query: the
 * same watermark always yields the same delta.
 *
 * The watermark advances only when the caller asks for the implicit delta
 * (`since` omitted) — an explicit `since` is a pure read, so probing a range
 * never eats the next session's continuity.
 */

export interface ResumeDelta {
  /** The watermark this delta is measured from (ISO datetime). */
  since: string;
  now: string;
  notesChanged: { path: string; title: string }[];
  factsAsserted: string[];
  /** Knowledge updates: a slot whose value was replaced in the window. */
  factsSuperseded: { slot: string; old: string; new: string }[];
  counts: { notesChanged: number; factsAsserted: number; factsSuperseded: number };
  /** Present when a list above is a sample of a larger set. */
  truncated?: Record<string, { shown: number; of: number }>;
}

const WATERMARK_KEY = 'resume_watermark';
const LIST_CAP = 30;

export function resumeDelta(store: Store, opts: { since?: string } = {}): ResumeDelta {
  assertIsoDate('since', opts.since);
  const explicit = opts.since !== undefined;
  const now = new Date().toISOString();
  // First contact with no watermark: a week of context beats either extreme —
  // "everything ever" floods the session, "nothing" reads as an empty vault.
  const fallback = new Date(Date.now() - 7 * 86400_000).toISOString();
  const since = opts.since ?? store.getMeta(WATERMARK_KEY) ?? fallback;

  const sinceMs = Date.parse(since);
  const changedRows = store.db
    .prepare(`SELECT path, title, mtime_ms FROM notes WHERE mtime_ms > ? ORDER BY mtime_ms DESC`)
    .all(sinceMs) as { path: string; title: string; mtime_ms: number }[];
  const notesChanged = changedRows.slice(0, LIST_CAP).map(({ path, title }) => ({ path, title }));

  const asserted = store.db
    .prepare(
      `SELECT subject_display, predicate, object, valid_from FROM facts
       WHERE recorded_at > ? ORDER BY recorded_at DESC`,
    )
    .all(since) as {
    subject_display: string;
    predicate: string;
    object: string;
    valid_from: string | null;
  }[];
  const factsAsserted = asserted
    .slice(0, LIST_CAP)
    .map(
      (f) =>
        `${f.subject_display} :: ${f.predicate} :: ${f.object}` +
        (f.valid_from ? ` (since ${f.valid_from.slice(0, 10)})` : ''),
    );

  // A supersession is one event with two facts attached; report it as the
  // change it is ("status: planning → active"), not as two disconnected rows.
  const supersededRows = store.db
    .prepare(
      `SELECT prev.subject_display AS subject, prev.predicate AS predicate,
              prev.object AS oldObject, nxt.object AS newObject
       FROM facts prev JOIN facts nxt ON nxt.id = prev.superseded_by
       WHERE prev.superseded_at > ? ORDER BY prev.superseded_at DESC`,
    )
    .all(since) as { subject: string; predicate: string; oldObject: string; newObject: string }[];
  const factsSuperseded = supersededRows.slice(0, LIST_CAP).map((r) => ({
    slot: `${r.subject} :: ${r.predicate}`,
    old: r.oldObject,
    new: r.newObject,
  }));

  const counts = {
    notesChanged: changedRows.length,
    factsAsserted: asserted.length,
    factsSuperseded: supersededRows.length,
  };
  const truncated: Record<string, { shown: number; of: number }> = {};
  if (counts.notesChanged > notesChanged.length) {
    truncated.notesChanged = { shown: notesChanged.length, of: counts.notesChanged };
  }
  if (counts.factsAsserted > factsAsserted.length) {
    truncated.factsAsserted = { shown: factsAsserted.length, of: counts.factsAsserted };
  }
  if (counts.factsSuperseded > factsSuperseded.length) {
    truncated.factsSuperseded = { shown: factsSuperseded.length, of: counts.factsSuperseded };
  }

  // Advance only on the implicit call: this READ is the session boundary.
  // The invariant is "a reported note never reappears unless re-edited", and
  // `now` alone cannot guarantee it: file mtimes carry FRACTIONAL
  // milliseconds while an ISO watermark is whole-ms, so a note written in
  // the same millisecond (…123.456 > …123.0) resurfaced in the next,
  // supposedly-empty delta. Advance past the fractional tail of everything
  // just seen.
  if (!explicit) {
    const maxSeen = changedRows.reduce((m, r) => Math.max(m, r.mtime_ms), 0);
    const advanceTo = Math.max(Date.parse(now), Math.ceil(maxSeen));
    store.setMeta(WATERMARK_KEY, new Date(advanceTo).toISOString());
  }

  return {
    since,
    now,
    notesChanged,
    factsAsserted,
    factsSuperseded,
    counts,
    ...(Object.keys(truncated).length ? { truncated } : {}),
  };
}

/** Exported for tests; not part of the public API surface. */
export const RESUME_WATERMARK_KEY = WATERMARK_KEY;
