import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
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
  listNotes(): Map<string, { hash: string; mtimeMs: number }>;
  /** FTS5 search; AND semantics with OR fallback. Excludes archived blocks unless includeArchived. */
  searchLexical(query: string, k: number, includeArchived?: boolean): LexicalHit[];
  logAccess(kind: 'retrieved' | 'used', blockId: number | null, query?: string): void;
  getMeta(key: string): string | null;
  setMeta(key: string, value: string): void;
}

export { normalizeKey } from '../normalize.js';
import { normalizeKey } from '../normalize.js';

/** Turn free text into a safe FTS5 MATCH expression (quoted tokens). */
export function ftsQuery(text: string, joiner: ' ' | ' OR '): string | null {
  const tokens = text
    .normalize('NFKC')
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 0)
    .slice(0, 32);
  if (tokens.length === 0) return null;
  return tokens.map((t) => `"${t}"`).join(joiner);
}

export function openStore(dbPath: string): Store {
  if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = NORMAL');
  // Without this, a second process touching the vault (e.g. an MCP server
  // while the CLI indexes) fails instantly with SQLITE_BUSY instead of waiting.
  db.pragma('busy_timeout = 5000');

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
      `INSERT INTO notes(path,title,frontmatter,tags,hash,mtime_ms,indexed_at)
       VALUES (?,?,?,?,?,?,?)
       ON CONFLICT(path) DO UPDATE SET title=excluded.title, frontmatter=excluded.frontmatter,
         tags=excluded.tags, hash=excluded.hash, mtime_ms=excluded.mtime_ms, indexed_at=excluded.indexed_at`,
    ),
    delBlocks: db.prepare(`DELETE FROM blocks WHERE note_path=?`),
    delLinks: db.prepare(`DELETE FROM links WHERE note_path=?`),
    insBlock: db.prepare(
      `INSERT INTO blocks(note_path,anchor,heading,ord,text,hash) VALUES (?,?,?,?,?,?)`,
    ),
    insLink: db.prepare(
      `INSERT INTO links(note_path,block_anchor,target,target_norm,heading,alias) VALUES (?,?,?,?,?,?)`,
    ),
    delNote: db.prepare(`DELETE FROM notes WHERE path=?`),
    listNotes: db.prepare(`SELECT path, hash, mtime_ms FROM notes`),
    getMeta: db.prepare(`SELECT value FROM meta WHERE key=?`),
    setMeta: db.prepare(
      `INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
    ),
    logAccess: db.prepare(`INSERT INTO access_log(at,kind,query,block_id) VALUES (?,?,?,?)`),
  };

  const upsertNoteTx = db.transaction((note: Note): Map<string, number> => {
    stmts.insNote.run(
      note.path,
      note.title,
      JSON.stringify(note.frontmatter),
      JSON.stringify(note.tags),
      note.hash,
      note.mtimeMs,
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
    for (const b of note.blocks) {
      const info = stmts.insBlock.run(note.path, b.anchor, b.heading, b.order, b.text, b.hash);
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
        normalizeKey(l.target),
        l.heading ?? null,
        l.alias ?? null,
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
      const m = new Map<string, { hash: string; mtimeMs: number }>();
      for (const r of stmts.listNotes.all() as { path: string; hash: string; mtime_ms: number }[]) {
        m.set(r.path, { hash: r.hash, mtimeMs: r.mtime_ms });
      }
      return m;
    },
    searchLexical,
    logAccess: (kind, blockId, query) => {
      stmts.logAccess.run(new Date().toISOString(), kind, query ?? null, blockId);
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
