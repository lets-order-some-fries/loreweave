import { describe, expect, it } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, normalizeKey, ftsQuery } from '../src/store/db.js';
import { MIGRATIONS } from '../src/store/schema.js';
import { parseNote } from '../src/vault/parse.js';

function memStore() {
  return openStore(':memory:');
}

describe('store', () => {
  it('applies all migrations and records the version', () => {
    const s = memStore();
    // version tracks MIGRATIONS.length so adding one cannot silently no-op
    expect(Number(s.getMeta('schema_version'))).toBe(MIGRATIONS.length);
    s.close();
  });

  it('migrations are idempotent across reopen (on-disk)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lw-mig-'));
    const file = join(dir, 'index.db');
    const a = openStore(file);
    a.upsertNote(parseNote('a.md', 'content here\n', 1));
    const version = a.getMeta('schema_version');
    a.close();
    // reopening must not re-run migrations or lose data
    const b = openStore(file);
    expect(b.getMeta('schema_version')).toBe(version);
    expect(b.searchLexical('content', 5)).toHaveLength(1);
    b.close();
  });

  it('upsert → fts search → delete lifecycle', () => {
    const s = memStore();
    const note = parseNote('a.md', '# Topic\n\nquantum entanglement basics\n', 1);
    s.upsertNote(note);
    let hits = s.searchLexical('entanglement', 5);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.notePath).toBe('a.md');
    s.deleteNote('a.md');
    hits = s.searchLexical('entanglement', 5);
    expect(hits).toHaveLength(0);
    // cascade removed blocks too
    expect(s.db.prepare('SELECT COUNT(*) c FROM blocks').get()).toMatchObject({ c: 0 });
    s.close();
  });

  it('re-upsert replaces blocks and fts rows without duplicates', () => {
    const s = memStore();
    s.upsertNote(parseNote('a.md', 'old words here\n', 1));
    s.upsertNote(parseNote('a.md', 'new words there\n', 2));
    expect(s.searchLexical('old', 5)).toHaveLength(0);
    expect(s.searchLexical('new', 5)).toHaveLength(1);
    expect(s.db.prepare('SELECT COUNT(*) c FROM blocks').get()).toMatchObject({ c: 1 });
    s.close();
  });

  it('preserves block dynamics across unchanged re-index', () => {
    const s = memStore();
    const ids = s.upsertNote(parseNote('a.md', 'stable content\n', 1));
    const id = ids.get('@0')!;
    s.db.prepare('UPDATE blocks SET stability=9.5, access_count=4 WHERE id=?').run(id);
    const ids2 = s.upsertNote(parseNote('a.md', 'stable content\n', 2));
    const row = s.db
      .prepare('SELECT stability, access_count FROM blocks WHERE id=?')
      .get(ids2.get('@0')!) as any;
    expect(row.stability).toBeCloseTo(9.5);
    expect(row.access_count).toBe(4);
    s.close();
  });

  it('AND semantics with OR fallback', () => {
    const s = memStore();
    s.upsertNote(parseNote('a.md', 'alpha beta together\n', 1));
    s.upsertNote(parseNote('b.md', 'only alpha here\n', 1));
    // AND: both words → only a.md
    expect(s.searchLexical('alpha beta', 5)).toHaveLength(1);
    // AND fails for 'alpha zzznope' → OR fallback still finds alpha docs
    const fallback = s.searchLexical('alpha zzznope', 5);
    expect(fallback.length).toBe(2);
    s.close();
  });

  it('search is safe for hostile input', () => {
    const s = memStore();
    s.upsertNote(parseNote('a.md', 'safe content\n', 1));
    expect(() => s.searchLexical('"unclosed AND (NEAR', 5)).not.toThrow();
    expect(() => s.searchLexical('???', 5)).not.toThrow();
    expect(s.searchLexical('', 5)).toEqual([]);
    s.close();
  });

  it('normalizeKey unifies variants', () => {
    expect(normalizeKey('Sarah Chen')).toBe('sarah chen');
    expect(normalizeKey('  sarah-chen.md ')).toBe('sarah chen');
    expect(normalizeKey('Café—Notes')).toBe('café notes');
  });

  it('ftsQuery quotes tokens and drops function words', () => {
    // "a" is a stopword; quoting neutralises NEAR( so it cannot be read as an
    // FTS5 operator.
    expect(ftsQuery("what's a NEAR(1 query?", ' ')).toBe('"whats" "near" "1" "query"');
  });

  it('ftsQuery never returns nothing for an all-stopword query', () => {
    // dropping every token would turn a valid search into silence
    expect(ftsQuery('what is the', ' ')).toBe('"what" "is" "the"');
  });

  it('question words no longer starve an AND match', () => {
    const s = memStore();
    s.upsertNote(parseNote('a.md', 'Target roles: AI Engineer and ML Engineer.\n', 1));
    // AND semantics over the raw question would require "what"/"are"/"my"
    expect(s.searchLexical('what are my target roles', 5)).toHaveLength(1);
    s.close();
  });
});

describe('retrieval history is bounded', () => {
  // Everything else in the index is derivable from the markdown and comes back
  // by deleting `.lore`. This table is not, and nothing pruned it: five rows
  // per search, one per result, each carrying the full query text. An agent
  // searching 200 times a day accumulates roughly 365 000 rows a year of a log
  // that nothing reads except a COUNT and no command shows the user.
  const fill = (store: ReturnType<typeof openStore>, n: number) => {
    for (let i = 0; i < n; i++) store.logAccess('retrieved', null, `query number ${i}`);
  };
  const rows = (store: ReturnType<typeof openStore>) =>
    (store.db.prepare('SELECT COUNT(*) c FROM access_log').get() as { c: number }).c;

  it('stays near the configured cap instead of growing forever', () => {
    const store = openStore(':memory:', { accessLogRows: 500 });
    fill(store, 5000);
    // Trimming runs on a margin rather than every insert, so the count settles
    // near the cap rather than exactly on it — the DELETE walks the table and
    // paying that per search to remove one row would cost more than the rows.
    expect(rows(store)).toBeGreaterThan(400);
    expect(rows(store)).toBeLessThan(1000);
    store.close();
  });

  it('keeps the most recent entries, not the oldest', () => {
    const store = openStore(':memory:', { accessLogRows: 100 });
    fill(store, 3000);
    const newest = store.db
      .prepare('SELECT query FROM access_log ORDER BY id DESC LIMIT 1')
      .get() as { query: string };
    expect(newest.query).toBe('query number 2999');
    store.close();
  });

  it('records nothing at all when set to zero', () => {
    const store = openStore(':memory:', { accessLogRows: 0 });
    fill(store, 1000);
    expect(rows(store)).toBe(0);
    store.close();
  });

  it('leaves history alone while it is under the cap', () => {
    const store = openStore(':memory:', { accessLogRows: 5000 });
    fill(store, 2000);
    expect(rows(store)).toBe(2000);
    store.close();
  });
});
