import Database from 'better-sqlite3';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Note } from '../types.js';
import { MIGRATIONS } from './schema.js';

export interface LexicalHit {
  blockId: number;
  notePath: string;
  anchor: string;
  heading: string;
  snippet: string;
  /** bm25 rank; lower = better (SQLite convention), exposed negated as score. */
  score: number;
}

export interface Store {
  db: Database.Database;
  path: string;
  close(): void;
  /** Replace a note and all its derived rows atomically. Returns anchor→blockId. */
  upsertNote(note: Note): Map<string, number>;
  deleteNote(path: string): void;
  /** path → {hash, mtimeMs} for the incremental diff. */
  listNotes(): Map<string, { hash: string; mtimeMs: number; size: number }>;
  /** FTS5 search; AND semantics with OR fallback. Excludes archived blocks unless includeArchived. */
  searchLexical(query: string, k: number, includeArchived?: boolean): LexicalHit[];
  logAccess(kind: 'retrieved' | 'used', blockId: number | null, query?: string): void;
  getMeta(key: string): string | null;
  setMeta(key: string, value: string): void;
}

export { normalizeKey } from '../normalize.js';
import { contentTerms, linkMatchKey, segmentCJK } from '../normalize.js';
import { extractDates, parseDateExpression } from '../temporal/dates.js';

/** A dated filename (2026-08-05-standup.md, journal/2026-08-05.md) dates the note. */
function filenameDate(path: string): { from: string; to: string } | null {
  const base = path.split('/').pop() ?? path;
  const m = base.match(/(\d{4}-\d{2}-\d{2})/);
  return m ? parseDateExpression(m[1]!) : null;
}

/**
 * Upper bound on terms in one MATCH expression.
 *
 * Only a guard against pathological input, not a tuning knob: measured on a
 * 400-note vault, 512 OR-terms cost 4 ms, so the previous limit of 32 was
 * roughly an order of magnitude below anything the engine minds. It was low
 * enough to matter — a long question whose decisive word came 41st lost that
 * word entirely and returned a note matching only the preamble, which is the
 * shape of query an agent produces when it pastes context and puts the actual
 * ask at the end.
 */
const MAX_FTS_TERMS = 256;

/** Turn free text into a safe FTS5 MATCH expression (quoted tokens). */
export function ftsQuery(text: string, joiner: ' ' | ' OR '): string | null {
  // Content words only: with AND semantics, one stray "what" in the question
  // is enough to miss the block that literally answers it.
  //
  // Deduplicated, as the coverage path already does: a repeated word tells
  // FTS nothing it does not know from the first occurrence, and prose repeats
  // constantly — "the compaction strategy for compaction of the streaming
  // compaction pipeline" is seven terms and four distinct ones. Under a cap,
  // duplicates spend the budget on nothing.
  const tokens = [...new Set(contentTerms(segmentCJK(text)))].slice(0, MAX_FTS_TERMS);
  if (tokens.length === 0) return null;
  return tokens.map((t) => `"${t}"`).join(joiner);
}

/** Block the thread briefly; openStore is synchronous by design. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** True for the SQLite errors that mean "this file is not a usable index". */
function isCorruption(err: unknown): boolean {
  const m = (err as Error)?.message ?? '';
  return (
    /malformed|not a database|file is encrypted|database disk image/i.test(m) ||
    /SQLITE_CORRUPT|SQLITE_NOTADB/i.test((err as { code?: string })?.code ?? '')
  );
}

/**
 * Deep integrity check + repair. Deliberate, not automatic: it reads the
 * entire file. Returns true if the index was reset.
 */
export function verifyOrReset(dbPath: string, onHeal?: (m: string) => void): boolean {
  if (dbPath === ':memory:') return false;
  let corrupt = false;
  try {
    const probe = new Database(dbPath, { readonly: true });
    try {
      const res = probe.pragma('quick_check') as { quick_check: string }[];
      corrupt = res[0]?.quick_check !== 'ok';
    } finally {
      probe.close();
    }
  } catch (err) {
    if (!isCorruption(err)) return false; // locked/missing is not corruption
    corrupt = true;
  }
  if (!corrupt) return false;
  rmSync(dbPath, { force: true });
  rmSync(`${dbPath}-wal`, { force: true });
  rmSync(`${dbPath}-shm`, { force: true });
  onHeal?.(`index was corrupt and has been reset — re-run 'lore index' to rebuild`);
  return true;
}

export interface OpenStoreOptions {
  /**
   * Rebuild from scratch if the index file is corrupt. On by default: the
   * index is a derived cache and the vault is the source of truth, so a
   * damaged cache should heal rather than brick every command.
   */
  healCorruption?: boolean;
  onHeal?: (message: string) => void;
  /** Rows of retrieval history to keep (see config.accessLogRows). */
  accessLogRows?: number;
}

/** Inserts between retention checks; see logAccess. */
const TRIM_EVERY = 200;

export function openStore(dbPath: string, opts: OpenStoreOptions = {}): Store {
  if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
  const heal = opts.healCorruption !== false && dbPath !== ':memory:';
  const accessLogRows = opts.accessLogRows ?? 5000;
  let sinceTrim = 0;

  let db: Database.Database;
  try {
    db = new Database(dbPath);
    // Opening is lazy; force a read so corruption surfaces here rather than
    // as a raw SQLite error in the middle of an unrelated command.
    db.prepare('SELECT count(*) FROM sqlite_master').get();
  } catch (err) {
    if (!heal || !isCorruption(err)) throw err;
    rmSync(dbPath, { force: true });
    rmSync(`${dbPath}-wal`, { force: true });
    rmSync(`${dbPath}-shm`, { force: true });
    opts.onHeal?.(`index was corrupt and has been reset — re-run 'lore index' to rebuild`);
    db = new Database(dbPath);
  }
  // busy_timeout must be set first: `journal_mode = WAL` needs a brief
  // exclusive lock, so setting the timeout afterwards left the one pragma
  // most likely to collide with no timeout at all.
  db.pragma('busy_timeout = 10000');
  // Even with a timeout, switching journal mode returns SQLITE_BUSY
  // immediately when another connection is initialising the same new file —
  // busy_timeout does not cover that case. Retry briefly instead of failing
  // the whole command, which is what `lore watch` + a manual index hit.
  for (let attempt = 0; ; attempt++) {
    try {
      db.pragma('journal_mode = WAL');
      break;
    } catch (err) {
      if (attempt >= 20 || !/locked|busy/i.test((err as Error).message)) throw err;
      sleepSync(25);
    }
  }
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = NORMAL');

  // NOTE: no full integrity scan here. `quick_check` reads the whole file,
  // so running it on every command was both slow and lock-prone — it made
  // concurrent commands fail with "database is locked". The cheap
  // sqlite_master probe above catches an unusable file; deep verification
  // belongs in `lore doctor`, which can heal deliberately.

  // migrations
  const migrate = db.transaction(() => {
    db.exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    const row = db.prepare(`SELECT value FROM meta WHERE key='schema_version'`).get() as
      | { value: string }
      | undefined;
    let version = row ? Number(row.value) : 0;
    for (let i = version; i < MIGRATIONS.length; i++) {
      db.exec(MIGRATIONS[i]!.replace(/CREATE TABLE meta[^;]+;/, '')); // meta pre-created
      version = i + 1;
    }
    db.prepare(
      `INSERT INTO meta(key,value) VALUES('schema_version',?)
       ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
    ).run(String(version));
  });
  migrate();

  const stmts = {
    insNote: db.prepare(
      `INSERT INTO notes(path,title,frontmatter,tags,hash,mtime_ms,size,indexed_at)
       VALUES (?,?,?,?,?,?,?,?)
       ON CONFLICT(path) DO UPDATE SET title=excluded.title, frontmatter=excluded.frontmatter,
         tags=excluded.tags, hash=excluded.hash, mtime_ms=excluded.mtime_ms,
         size=excluded.size, indexed_at=excluded.indexed_at`,
    ),
    delBlocks: db.prepare(`DELETE FROM blocks WHERE note_path=?`),
    delLinks: db.prepare(`DELETE FROM links WHERE note_path=?`),
    insBlock: db.prepare(
      `INSERT INTO blocks(note_path,anchor,heading,ord,text,hash,event_from,event_to,fts_text)
       VALUES (?,?,?,?,?,?,?,?,?)`,
    ),
    insLink: db.prepare(
      `INSERT INTO links(note_path,block_anchor,target,target_norm,heading,alias,style)
       VALUES (?,?,?,?,?,?,?)`,
    ),
    delNote: db.prepare(`DELETE FROM notes WHERE path=?`),
    listNotes: db.prepare(`SELECT path, hash, mtime_ms, size FROM notes`),
    getMeta: db.prepare(`SELECT value FROM meta WHERE key=?`),
    setMeta: db.prepare(
      `INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
    ),
    logAccess: db.prepare(`INSERT INTO access_log(at,kind,query,block_id) VALUES (?,?,?,?)`),
    countAccess: db.prepare(`SELECT COUNT(*) c FROM access_log`),
    trimAccess: db.prepare(
      `DELETE FROM access_log WHERE id NOT IN
         (SELECT id FROM access_log ORDER BY id DESC LIMIT ?)`,
    ),
  };

  const upsertNoteTx = db.transaction((note: Note): Map<string, number> => {
    stmts.insNote.run(
      note.path,
      note.title,
      JSON.stringify(note.frontmatter),
      JSON.stringify(note.tags),
      note.hash,
      note.mtimeMs,
      note.size,
      new Date().toISOString(),
    );
    // preserve dynamics for unchanged blocks: capture old state by hash
    const old = db
      .prepare(
        `SELECT hash, stability, last_accessed, access_count, importance FROM blocks WHERE note_path=?`,
      )
      .all(note.path) as {
      hash: string;
      stability: number;
      last_accessed: string | null;
      access_count: number;
      importance: number;
    }[];
    const oldByHash = new Map(old.map((o) => [o.hash, o]));
    stmts.delBlocks.run(note.path);
    stmts.delLinks.run(note.path);
    const ids = new Map<string, number>();
    // Content dates: the block's own, else the note's (frontmatter/filename).
    const noteDates = extractDates('', note.frontmatter) ?? filenameDate(note.path);
    for (const b of note.blocks) {
      const d = extractDates(b.text, note.frontmatter) ?? noteDates;
      const info = stmts.insBlock.run(
        note.path,
        b.anchor,
        b.heading,
        b.order,
        b.text,
        b.hash,
        d?.from ?? null,
        d?.to ?? null,
        // heading breadcrumb is searchable too; CJK is split per character
        segmentCJK(`${b.heading.replace(/\//g, ' ')} ${b.text}`),
      );
      const id = Number(info.lastInsertRowid);
      ids.set(b.anchor, id);
      const prev = oldByHash.get(b.hash);
      if (prev) {
        db.prepare(
          `UPDATE blocks SET stability=?, last_accessed=?, access_count=?, importance=? WHERE id=?`,
        ).run(prev.stability, prev.last_accessed, prev.access_count, prev.importance, id);
      }
    }
    for (const l of note.links) {
      stmts.insLink.run(
        note.path,
        l.blockAnchor,
        l.target,
        linkMatchKey(note.path, l.target, l.style),
        l.heading ?? null,
        l.alias ?? null,
        l.style,
      );
    }
    return ids;
  });

  function searchLexical(query: string, k: number, includeArchived = false): LexicalHit[] {
    const run = (expr: string): LexicalHit[] =>
      db
        .prepare(
          `SELECT b.id AS blockId, b.note_path AS notePath, b.anchor, b.heading,
                  snippet(blocks_fts, 0, '', '', ' … ', 12) AS snippet,
                  bm25(blocks_fts) AS rank
           FROM blocks_fts
           JOIN blocks b ON b.id = blocks_fts.rowid
           WHERE blocks_fts MATCH ? ${includeArchived ? '' : 'AND b.archived = 0'}
           ORDER BY rank LIMIT ?`,
        )
        .all(expr, k)
        .map((r: any) => ({
          blockId: r.blockId,
          notePath: r.notePath,
          anchor: r.anchor,
          heading: r.heading,
          snippet: r.snippet,
          score: -r.rank, // bm25() is lower-is-better; negate so higher=better
        }));
    const andExpr = ftsQuery(query, ' ');
    if (!andExpr) return [];
    let hits = run(andExpr);
    if (hits.length === 0) {
      const orExpr = ftsQuery(query, ' OR ');
      if (orExpr && orExpr !== andExpr) hits = run(orExpr);
    }
    return hits;
  }

  return {
    db,
    path: dbPath,
    close: () => db.close(),
    upsertNote: (n) => upsertNoteTx(n),
    deleteNote: (p) => {
      stmts.delNote.run(p);
    },
    listNotes: () => {
      const m = new Map<string, { hash: string; mtimeMs: number; size: number }>();
      for (const r of stmts.listNotes.all() as {
        path: string;
        hash: string;
        mtime_ms: number;
        size: number;
      }[]) {
        m.set(r.path, { hash: r.hash, mtimeMs: r.mtime_ms, size: r.size });
      }
      return m;
    },
    searchLexical,
    logAccess: (kind, blockId, query) => {
      if (accessLogRows === 0) return;
      stmts.logAccess.run(new Date().toISOString(), kind, query ?? null, blockId);
      // Trim on a margin rather than on every insert: the DELETE walks the
      // table, and paying that per search to remove one row would cost more
      // than the rows do.
      sinceTrim++;
      if (sinceTrim >= TRIM_EVERY) {
        sinceTrim = 0;
        const { c } = stmts.countAccess.get() as { c: number };
        if (c > accessLogRows) stmts.trimAccess.run(accessLogRows);
      }
    },
    getMeta: (k) => {
      const r = stmts.getMeta.get(k) as { value: string } | undefined;
      return r ? r.value : null;
    },
    setMeta: (k, v) => {
      stmts.setMeta.run(k, v);
    },
  };
}
