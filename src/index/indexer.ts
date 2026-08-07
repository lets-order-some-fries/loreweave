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
  /** Retries when another process holds the write lock (default 5). */
  lockRetries?: number;
  /** Which fact syntaxes to mine (see config.facts.extract). */
  factExtract?: 'explicit' | 'all' | 'off';
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

/** Is the process that claimed the index still alive? */
/**
 * State of the index-in-progress marker, so callers other than the indexer can
 * tell a half-built index from a healthy one.
 *
 * `doctor` needs this most: on an index interrupted part-way it reported
 * "broken links: 1091" for a vault whose links are all fine, because the notes
 * those links point at had not been indexed yet. A health report that invents
 * a catastrophe is worse than one that says it cannot tell yet.
 */
export function indexState(store: Store): 'clean' | 'interrupted' | 'running' {
  const marker = store.getMeta('index_in_progress');
  if (marker === null || marker === '0') return 'clean';
  return isRunning(marker) ? 'running' : 'interrupted';
}

function isRunning(marker: string): boolean {
  const pid = Number(marker);
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0); // signal 0 only tests existence
    return true;
  } catch (err) {
    // EPERM means it exists but belongs to another user — still alive
    return (err as { code?: string }).code === 'EPERM';
  }
}

function isBusy(err: unknown): boolean {
  const m = (err as Error)?.message ?? '';
  const code = (err as { code?: string })?.code ?? '';
  return /database is locked|database table is locked/i.test(m) || /SQLITE_BUSY/i.test(code);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Incrementally sync the vault into the store, retrying if another process
 * holds the write lock.
 *
 * `lore watch` makes concurrent indexing normal rather than exotic: the
 * watcher and a manual `lore index` will collide. SQLite's busy_timeout does
 * not cover a write-write conflict in WAL mode, which surfaced as a bare
 * "error: database is locked" and a non-zero exit.
 */
export async function indexVault(
  store: Store,
  root: string,
  opts: IndexOptions = {},
): Promise<IndexReport> {
  const attempts = opts.lockRetries ?? 5;
  for (let attempt = 0; ; attempt++) {
    try {
      return await indexVaultOnce(store, root, opts);
    } catch (err) {
      if (!isBusy(err) || attempt >= attempts) {
        if (isBusy(err)) {
          throw new Error(
            'another loreweave process is indexing this vault (is `lore watch` running?) — try again in a moment',
          );
        }
        throw err;
      }
      await sleep(120 * 2 ** attempt + Math.floor(attempt * 37)); // backoff
    }
  }
}

async function indexVaultOnce(
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
  //
  // The marker records the PID that set it. A bare "1" could not distinguish
  // "a previous run crashed" from "another run is happening right now", so
  // two concurrent indexes each declared the other crashed and forced a
  // needless full rebuild.
  const marker = store.getMeta('index_in_progress');
  const interrupted = marker !== null && marker !== '0' && !isRunning(marker);
  const full = opts.full || interrupted;
  store.setMeta('index_in_progress', String(process.pid));

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
    rebuildFactsFromNotes(store, opts.factExtract ?? 'explicit');
    updateImportance(store);
  }

  store.setMeta('last_index_at', new Date().toISOString());
  // Only clear our own marker: a concurrent run may have replaced it.
  if (store.getMeta('index_in_progress') === String(process.pid)) {
    store.setMeta('index_in_progress', '0');
  }
  if (interrupted) {
    report.warnings.push(
      'previous index did not finish; performed a full rebuild to restore consistency',
    );
  }
  report.durationMs = Date.now() - started;
  return report;
}
