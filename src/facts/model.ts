import { appendFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import type { LoreContext } from '../context.js';
import type { Store } from '../store/db.js';
import type { Fact } from '../types.js';
import { normalizeKey } from '../normalize.js';
import { JOURNAL_DIR, recomputeSupersessions, renderFactLine } from './journal.js';

export interface AssertFactInput {
  subject: string;
  predicate: string;
  object: string;
  /** ISO date/datetime when the fact became true (defaults to today). */
  validFrom?: string;
  validUntil?: string;
  confidence?: number;
  sourceType?: 'stated' | 'extracted' | 'inferred';
}

export interface AssertFactResult {
  fact: Fact;
  /** Facts this assertion superseded (same slot, older validity, different object). */
  superseded: Fact[];
  journalPath: string;
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}(T[\d:.]+Z?)?$/;

function checkDate(name: string, v: string | undefined): void {
  if (v !== undefined && !ISO_DATE_RE.test(v)) {
    throw new Error(`${name} must be an ISO date (YYYY-MM-DD) or datetime, got: ${v}`);
  }
}

function rowToFact(r: Record<string, unknown>): Fact {
  return {
    id: r.id as number,
    subject: r.subject as string,
    predicate: r.predicate as string,
    object: r.object as string,
    subjectDisplay: r.subject_display as string,
    validFrom: (r.valid_from as string) ?? null,
    validUntil: (r.valid_until as string) ?? null,
    recordedAt: r.recorded_at as string,
    supersededAt: (r.superseded_at as string) ?? null,
    supersededBy: (r.superseded_by as number) ?? null,
    sourceType: r.source_type as Fact['sourceType'],
    notePath: (r.note_path as string) ?? null,
    blockAnchor: (r.block_anchor as string) ?? null,
    confidence: r.confidence as number,
  };
}

/** Append a line to today's journal note (creates lore/journal/ as needed). */
function appendJournalLine(root: string, line: string): string {
  const today = new Date().toISOString().slice(0, 10);
  const rel = `${JOURNAL_DIR}/${today}.md`;
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  appendFileSync(abs, `${line}\n`, 'utf8');
  return rel;
}

/**
 * Assert a fact: durable journal line first, then the DB row, then
 * deterministic supersession recompute. Contradictions supersede — never
 * delete (Zep/Graphiti). Freshness resolution is deterministic: newest
 * valid_from wins; the LLM caller is never asked to judge staleness.
 */
export function assertFact(ctx: LoreContext, input: AssertFactInput): AssertFactResult {
  if (!input.subject.trim() || !input.predicate.trim() || !input.object.trim()) {
    throw new Error('subject, predicate, and object are required');
  }
  checkDate('validFrom', input.validFrom);
  checkDate('validUntil', input.validUntil);
  const conf = input.confidence ?? 0.9;
  if (conf < 0 || conf > 1) throw new Error('confidence must be in [0,1]');
  const sourceType = input.sourceType ?? 'stated';
  const recordedAt = new Date().toISOString();
  const validFrom = input.validFrom ?? recordedAt.slice(0, 10);
  const subject = normalizeKey(input.subject);
  const predicate = normalizeKey(input.predicate);

  const journalPath = appendJournalLine(
    ctx.root,
    renderFactLine({
      kind: 'fact',
      subject: input.subject.trim(),
      predicate: input.predicate.trim(),
      object: input.object.trim(),
      attrs: {
        valid_from: validFrom,
        ...(input.validUntil ? { valid_until: input.validUntil } : {}),
        recorded_at: recordedAt,
        confidence: String(conf),
        source: sourceType,
      },
    }),
  );

  const db = ctx.store.db;
  const before = db
    .prepare(
      `SELECT id FROM facts WHERE subject=? AND predicate=? AND superseded_by IS NULL`,
    )
    .all(subject, predicate) as { id: number }[];
  const info = db
    .prepare(
      `INSERT INTO facts(subject, predicate, object, subject_display, valid_from, valid_until,
                         recorded_at, source_type, note_path, block_anchor, confidence)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      subject,
      predicate,
      input.object.trim(),
      input.subject.trim(),
      validFrom,
      input.validUntil ?? null,
      recordedAt,
      sourceType,
      `${journalPath}`,
      null,
      conf,
    );
  recomputeSupersessions(ctx.store);

  const id = Number(info.lastInsertRowid);
  const fact = rowToFact(db.prepare(`SELECT * FROM facts WHERE id=?`).get(id) as any);
  const superseded = before
    .map((b) => db.prepare(`SELECT * FROM facts WHERE id=? AND superseded_by=?`).get(b.id, id))
    .filter(Boolean)
    .map((r) => rowToFact(r as any));
  return { fact, superseded, journalPath };
}

/** Close all open facts in a slot (journalled + applied). */
export function invalidateFact(
  ctx: LoreContext,
  input: { subject: string; predicate: string; validUntil?: string },
): { closed: number; journalPath: string } {
  checkDate('validUntil', input.validUntil);
  const until = input.validUntil ?? new Date().toISOString().slice(0, 10);
  const journalPath = appendJournalLine(
    ctx.root,
    renderFactLine({
      kind: 'invalidate',
      subject: input.subject.trim(),
      predicate: input.predicate.trim(),
      attrs: { valid_until: until },
    }),
  );
  // Same semantics as replay: close only the slot's current winner.
  const res = ctx.store.db
    .prepare(
      `UPDATE facts SET valid_until=? WHERE id IN (
         SELECT id FROM facts WHERE subject=? AND predicate=? AND valid_until IS NULL
         ORDER BY COALESCE(valid_from, recorded_at) DESC, recorded_at DESC, id DESC LIMIT 1
       )`,
    )
    .run(until, normalizeKey(input.subject), normalizeKey(input.predicate));
  return { closed: res.changes, journalPath };
}

export interface FactQuery {
  subject?: string;
  predicate?: string;
  /** Point-in-time: facts valid at this date ("what was true then"). */
  asOf?: string;
  /** Include superseded/closed facts (full history). */
  includeHistory?: boolean;
  limit?: number;
}

/**
 * Query facts. Default: currently-valid facts only. `asOf` answers
 * point-in-time questions; `includeHistory` returns the full chain.
 */
export function queryFacts(store: Store, q: FactQuery = {}): Fact[] {
  checkDate('asOf', q.asOf);
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (q.subject) {
    clauses.push(`subject = ?`);
    params.push(normalizeKey(q.subject));
  }
  if (q.predicate) {
    clauses.push(`predicate = ?`);
    params.push(normalizeKey(q.predicate));
  }
  if (q.asOf) {
    clauses.push(`COALESCE(valid_from, recorded_at) <= ?`);
    params.push(`${q.asOf}~`); // '~' sorts after any time suffix, making date-only asOf inclusive
    clauses.push(`(valid_until IS NULL OR valid_until > ?)`);
    params.push(q.asOf);
  } else if (!q.includeHistory) {
    clauses.push(`valid_until IS NULL AND superseded_by IS NULL`);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = store.db
    .prepare(
      `SELECT * FROM facts ${where}
       ORDER BY subject, predicate, COALESCE(valid_from, recorded_at) DESC
       LIMIT ?`,
    )
    .all(...params, q.limit ?? 200) as Record<string, unknown>[];
  return rows.map(rowToFact);
}

export interface AggregateQuery {
  subject?: string;
  predicate?: string;
  groupBy?: 'object' | 'subject' | 'predicate';
  /** Restrict to facts whose validity intersects [since, until]. */
  since?: string;
  until?: string;
}

/**
 * Computable layer: counting/grouping over fact history — the queries
 * similarity retrieval fundamentally cannot answer (User as Code, 2026).
 */
export function aggregateFacts(
  store: Store,
  q: AggregateQuery = {},
): { group: string; count: number }[] {
  checkDate('since', q.since);
  checkDate('until', q.until);
  const groupBy = q.groupBy ?? 'object';
  const col = { object: 'object', subject: 'subject', predicate: 'predicate' }[groupBy];
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (q.subject) {
    clauses.push(`subject = ?`);
    params.push(normalizeKey(q.subject));
  }
  if (q.predicate) {
    clauses.push(`predicate = ?`);
    params.push(normalizeKey(q.predicate));
  }
  // `since`/`until` bound when the fact BECAME true, which is what
  // "how many trips in 2025" means. (Filtering on valid_until instead is
  // trivially true for every still-open fact, so a 2025 window would count
  // a 2024 trip that never ended.)
  if (q.since) {
    clauses.push(`COALESCE(valid_from, recorded_at) >= ?`);
    params.push(q.since);
  }
  if (q.until) {
    clauses.push(`COALESCE(valid_from, recorded_at) <= ?`);
    params.push(`${q.until}~`);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return store.db
    .prepare(
      `SELECT ${col} AS grp, COUNT(*) AS count FROM facts ${where}
       GROUP BY ${col} ORDER BY count DESC, grp ASC LIMIT 100`,
    )
    .all(...params)
    .map((r: any) => ({ group: r.grp as string, count: r.count as number }));
}
