import { readFile } from 'node:fs/promises';
import type { IndexReport, Note } from '../types.js';
import type { Store } from '../store/db.js';
import { parseNote, sha1 } from '../vault/parse.js';
import { scanVault } from '../vault/scan.js';
import { extractEntities } from '../entities/extract.js';
import { rebuildFactsFromNotes } from '../facts/journal.js';
import { updateImportance } from '../dynamics/usage.js';

export interface IndexOptions {
  full?: boolean;
  /** Disable wink-nlp proper-noun extraction (faster; links/tags only). */
  nlp?: boolean;
  ignore?: string[];
}

/** Replace all entity mentions derived from one note. */
export function writeMentions(store: Store, note: Note, useNlp: boolean): void {
  const db = store.db;
  const mentions = extractEntities(note, useNlp);
  const tx = db.transaction(() => {
    db.prepare(`DELETE FROM mentions WHERE note_path=?`).run(note.path);
    const upsertEntity = db.prepare(
      `INSERT INTO entities(key, display) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET display=display RETURNING id`,
    );
    const insMention = db.prepare(
      `INSERT INTO mentions(entity_id, note_path, block_anchor, source, confidence)
       VALUES (?,?,?,?,?)`,
    );
    for (const m of mentions) {
      const row = upsertEntity.get(m.key, m.display) as { id: number };
      insMention.run(row.id, note.path, m.blockAnchor, m.source, m.confidence);
    }
  });
  tx();
}

/** Remove entities that no longer have any mentions (after deletes). */
export function pruneOrphanEntities(store: Store): number {
  const res = store.db
    .prepare(`DELETE FROM entities WHERE id NOT IN (SELECT DISTINCT entity_id FROM mentions)`)
    .run();
  return res.changes;
}

/**
 * Incrementally sync the vault into the store.
 * Diff by mtime first (cheap), then content hash (authoritative).
 */
export async function indexVault(
  store: Store,
  root: string,
  opts: IndexOptions = {},
): Promise<IndexReport> {
  const started = Date.now();
  const useNlp = opts.nlp !== false;
  const files = await scanVault(root, opts.ignore ?? []);

  // An index is many transactions, so a crash mid-run leaves derived state
  // (facts, mentions, importance) half-built with no way to notice: a later
  // incremental run sees matching mtimes and reports "+0 ~0 -0" forever.
  // A marker written before and cleared after makes recovery automatic.
  const interrupted = store.getMeta('index_in_progress') === '1';
  const full = opts.full || interrupted;
  store.setMeta('index_in_progress', '1');

  const known = store.listNotes();
  const report: IndexReport = {
    added: 0,
    updated: 0,
    removed: 0,
    unchanged: 0,
    warnings: [],
    durationMs: 0,
  };

  const seen = new Set<string>();
  for (const f of files) {
    seen.add(f.path);
    const prev = known.get(f.path);
    if (prev && !full && prev.mtimeMs === f.mtimeMs && prev.size === f.size) {
      report.unchanged++;
      continue;
    }
    let raw: string;
    try {
      raw = await readFile(f.absPath, 'utf8');
    } catch (err) {
      report.warnings.push(`${f.path}: unreadable (${(err as Error).message})`);
      continue;
    }
    if (prev && !full && prev.hash === sha1(raw)) {
      // touched but unchanged: record new mtime/size so next run short-circuits
      store.db
        .prepare(`UPDATE notes SET mtime_ms=?, size=? WHERE path=?`)
        .run(f.mtimeMs, f.size, f.path);
      report.unchanged++;
      continue;
    }
    const note = parseNote(f.path, raw, f.mtimeMs, f.size);
    // One transaction per note: a crash between the note write and its
    // mentions used to leave that note permanently mention-less, since the
    // next incremental run sees a matching hash and skips it.
    const tx = store.db.transaction(() => {
      store.upsertNote(note);
      writeMentions(store, note, useNlp);
    });
    tx();
    report.warnings.push(...note.warnings.map((w) => `${f.path}: ${w}`));
    if (prev) report.updated++;
    else report.added++;
  }

  for (const path of known.keys()) {
    if (!seen.has(path)) {
      store.deleteNote(path);
      report.removed++;
    }
  }
  if (report.removed > 0 || report.updated > 0) pruneOrphanEntities(store);
  if (report.added > 0 || report.updated > 0 || report.removed > 0) {
    rebuildFactsFromNotes(store);
    updateImportance(store);
  }

  store.setMeta('last_index_at', new Date().toISOString());
  store.setMeta('index_in_progress', '0');
  if (interrupted) {
    report.warnings.push(
      'previous index did not finish; performed a full rebuild to restore consistency',
    );
  }
  report.durationMs = Date.now() - started;
  return report;
}
