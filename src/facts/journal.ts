/**
 * Fact lines in markdown are the durable record; DB fact rows are a replay.
 *
 *   - [fact] Subject :: predicate :: Object {valid_from=2026-08-05, confidence=0.9}
 *   - [invalidate] Subject :: predicate {valid_until=2026-08-10}
 *
 * Facts may appear in any note (source_type 'extracted'); the engine's own
 * assertions are appended to lore/journal/YYYY-MM-DD.md (source_type from the
 * line's `source` attr, default 'stated'). Rebuild wipes and replays ALL fact
 * rows deterministically, so the index stays a pure cache of the vault.
 */
import type { Store } from '../store/db.js';
import { normalizeKey } from '../normalize.js';

export const JOURNAL_DIR = 'lore/journal';

export function isJournalPath(path: string): boolean {
  return path.startsWith(`${JOURNAL_DIR}/`);
}

export interface FactLine {
  kind: 'fact' | 'invalidate';
  subject: string;
  predicate: string;
  object?: string;
  attrs: Record<string, string>;
}

const FACT_RE = /^\s*[-*+]\s*\[(fact|invalidate)\]\s*(.+)$/;

function parseAttrs(s: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const part of s.split(',')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k) attrs[k] = v;
  }
  return attrs;
}

/** Parse all fact lines in a block of text (order preserved). */
export function parseFactLines(text: string): FactLine[] {
  const out: FactLine[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(FACT_RE);
    if (!m) continue;
    const kind = m[1] as 'fact' | 'invalidate';
    let body = (m[2] ?? '').trim();
    let attrs: Record<string, string> = {};
    const attrMatch = body.match(/\{([^{}]*)\}\s*$/);
    if (attrMatch) {
      attrs = parseAttrs(attrMatch[1] ?? '');
      body = body.slice(0, attrMatch.index).trim();
    }
    const parts = body.split('::').map((p) => p.trim());
    if (kind === 'fact') {
      if (parts.length < 3 || !parts[0] || !parts[1] || !parts[2]) continue;
      out.push({ kind, subject: parts[0], predicate: parts[1], object: parts.slice(2).join(' :: '), attrs });
    } else {
      if (parts.length < 2 || !parts[0] || !parts[1]) continue;
      out.push({ kind, subject: parts[0], predicate: parts[1], attrs });
    }
  }
  return out;
}

/** Render a FactLine back to markdown (round-trip format). */
export function renderFactLine(f: FactLine): string {
  const attrs = Object.entries(f.attrs)
    .map(([k, v]) => `${k}=${v}`)
    .join(', ');
  const body =
    f.kind === 'fact'
      ? `${f.subject} :: ${f.predicate} :: ${f.object ?? ''}`
      : `${f.subject} :: ${f.predicate}`;
  return `- [${f.kind}] ${body}${attrs ? ` {${attrs}}` : ''}`;
}

const VALID_SOURCE_TYPES = new Set(['stated', 'extracted', 'inferred']);

/**
 * Deterministic supersession: within each (subject, predicate) slot, order
 * facts by (valid_from ?? recorded_at); each fact with a successor whose
 * object differs is closed at the successor's valid_from and linked 'updates'.
 * Same-object successors are duplicates/extensions — linked 'extends'.
 */
export function recomputeSupersessions(store: Store): void {
  const db = store.db;
  const tx = db.transaction(() => {
    db.prepare(`DELETE FROM fact_links WHERE type IN ('updates','extends')`).run();
    db.prepare(
      `UPDATE facts SET superseded_at=NULL, superseded_by=NULL
       WHERE superseded_by IS NOT NULL`,
    ).run();
    const slots = db
      .prepare(`SELECT DISTINCT subject, predicate FROM facts`)
      .all() as { subject: string; predicate: string }[];
    const linkStmt = db.prepare(
      `INSERT OR IGNORE INTO fact_links(src_fact, dst_fact, type) VALUES (?,?,?)`,
    );
    const closeStmt = db.prepare(
      `UPDATE facts SET valid_until=COALESCE(valid_until, ?), superseded_at=?, superseded_by=? WHERE id=?`,
    );
    for (const slot of slots) {
      const rows = db
        .prepare(
          `SELECT id, object, valid_from, valid_until, recorded_at FROM facts
           WHERE subject=? AND predicate=?
           ORDER BY COALESCE(valid_from, recorded_at) ASC, recorded_at ASC, id ASC`,
        )
        .all(slot.subject, slot.predicate) as {
        id: number;
        object: string;
        valid_from: string | null;
        valid_until: string | null;
        recorded_at: string;
      }[];
      for (let i = 0; i < rows.length - 1; i++) {
        const cur = rows[i]!;
        const next = rows[i + 1]!;
        if (normalizeKey(next.object) === normalizeKey(cur.object)) {
          linkStmt.run(next.id, cur.id, 'extends');
          continue;
        }
        // different object, later validity → supersession
        const closeAt = next.valid_from ?? next.recorded_at;
        closeStmt.run(closeAt, next.recorded_at, next.id, cur.id);
        linkStmt.run(next.id, cur.id, 'updates');
      }
    }
  });
  tx();
}

/**
 * Wipe and replay all fact rows from fact lines found in vault blocks.
 * Journal notes replay first (chronological by path), then other notes by path.
 */
export function rebuildFactsFromNotes(store: Store): number {
  const db = store.db;
  let count = 0;
  const tx = db.transaction(() => {
    db.prepare(`DELETE FROM facts`).run();
    const rows = db
      .prepare(
        `SELECT b.note_path AS notePath, b.anchor, b.ord, b.text, n.mtime_ms
         FROM blocks b JOIN notes n ON n.path = b.note_path
         WHERE b.text LIKE '%[fact]%' OR b.text LIKE '%[invalidate]%'
         ORDER BY (CASE WHEN b.note_path LIKE '${JOURNAL_DIR}/%' THEN 0 ELSE 1 END),
                  b.note_path ASC, b.ord ASC`,
      )
      .all() as { notePath: string; anchor: string; ord: number; text: string }[];
    const ins = db.prepare(
      `INSERT INTO facts(subject, predicate, object, subject_display, valid_from, valid_until,
                         recorded_at, source_type, note_path, block_anchor, confidence)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    );
    const seen = new Set<string>();
    for (const r of rows) {
      const journal = isJournalPath(r.notePath);
      // journal file name lore/journal/YYYY-MM-DD.md gives a default record date
      const dateFromPath = r.notePath.match(/(\d{4}-\d{2}-\d{2})/)?.[1];
      for (const f of parseFactLines(r.text)) {
        if (f.kind === 'invalidate') {
          const until = f.attrs.valid_until ?? dateFromPath ?? new Date().toISOString();
          // Close only the current winner of the slot; older open facts get
          // closed by the supersession recompute at their successor's date.
          // (Closing all open facts here would diverge from the live path,
          // where supersession has already closed the older ones.)
          db.prepare(
            `UPDATE facts SET valid_until=? WHERE id IN (
               SELECT id FROM facts WHERE subject=? AND predicate=? AND valid_until IS NULL
               ORDER BY COALESCE(valid_from, recorded_at) DESC, recorded_at DESC, id DESC LIMIT 1
             )`,
          ).run(until, normalizeKey(f.subject), normalizeKey(f.predicate));
          continue;
        }
        const subject = normalizeKey(f.subject);
        const predicate = normalizeKey(f.predicate);
        const recordedAt =
          f.attrs.recorded_at ?? (dateFromPath ? `${dateFromPath}T00:00:00.000Z` : new Date().toISOString());
        const dedupe = `${subject}|${predicate}|${normalizeKey(f.object ?? '')}|${f.attrs.valid_from ?? ''}`;
        if (seen.has(dedupe)) continue;
        seen.add(dedupe);
        const rawSource = f.attrs.source ?? (journal ? 'stated' : 'extracted');
        const sourceType = VALID_SOURCE_TYPES.has(rawSource) ? rawSource : 'extracted';
        const conf = Number(f.attrs.confidence);
        ins.run(
          subject,
          predicate,
          f.object ?? '',
          f.subject,
          f.attrs.valid_from ?? null,
          f.attrs.valid_until ?? null,
          recordedAt,
          sourceType,
          r.notePath,
          r.anchor,
          Number.isFinite(conf) ? Math.max(0, Math.min(1, conf)) : 0.9,
        );
        count++;
      }
    }
  });
  tx();
  recomputeSupersessions(store);
  return count;
}
