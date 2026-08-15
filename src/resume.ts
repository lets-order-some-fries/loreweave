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
/**
 * Notes are tracked in FILE-MTIME space, facts in wall-clock record time.
 *
 * One wall-clock watermark for both LOST EDITS OUTRIGHT. `resume` reports
 * what the INDEX knows, but the watermark advanced by the clock: a note
 * edited while nothing was indexing (an editor session with no `lore watch`
 * — the ordinary case) was invisible at resume time because its row still
 * carried the old mtime, yet the watermark moved past the file's real mtime
 * anyway. Once the index caught up, the row's mtime sat BELOW the watermark
 * forever, so that edit appeared in no delta, ever. A watermark that only
 * advances to what the index has actually seen cannot outrun it.
 */
const NOTES_WATERMARK_KEY = 'resume_notes_mtime';
const LIST_CAP = 30;

export function resumeDelta(store: Store, opts: { since?: string } = {}): ResumeDelta {
  assertIsoDate('since', opts.since);
  const explicit = opts.since !== undefined;
  const now = new Date().toISOString();
  // First contact with no watermark: a week of context beats either extreme —
  // "everything ever" floods the session, "nothing" reads as an empty vault.
  const fallback = new Date(Date.now() - 7 * 86400_000).toISOString();
  const since = opts.since ?? store.getMeta(WATERMARK_KEY) ?? fallback;

  // An explicit `since` is a pure read and bounds both axes. Otherwise the
  // notes floor is the stored file-mtime watermark, falling back to the
  // record-time one — which on an upgrade is the old wall-clock value, so an
  // existing vault does not re-report itself once, and on a fresh install is
  // the 7-day window.
  const storedNotes = Number(store.getMeta(NOTES_WATERMARK_KEY) ?? NaN);
  const notesFloor = explicit
    ? Date.parse(since)
    : Number.isFinite(storedNotes)
      ? storedNotes
      : Date.parse(since);
  const changedRows = store.db
    .prepare(`SELECT path, title, mtime_ms FROM notes WHERE mtime_ms > ? ORDER BY mtime_ms DESC`)
    .all(notesFloor) as { path: string; title: string; mtime_ms: number }[];
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
  // Facts move with the clock (recorded_at IS wall clock). Notes move only to
  // the newest mtime the index has actually seen — stored as an exact float,
  // so the "a reported note never reappears" invariant holds down to the
  // fractional millisecond a filesystem records, with no rounding slack.
  if (!explicit) {
    store.setMeta(WATERMARK_KEY, now);
    const maxSeen = changedRows.reduce((m, r) => Math.max(m, r.mtime_ms), notesFloor);
    store.setMeta(NOTES_WATERMARK_KEY, String(maxSeen));
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
export const RESUME_NOTES_WATERMARK_KEY = NOTES_WATERMARK_KEY;
