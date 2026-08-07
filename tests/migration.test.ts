import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MIGRATIONS } from '../src/store/schema.js';
import { openStore } from '../src/store/db.js';
import { indexVault } from '../src/index/indexer.js';
import { search } from '../src/retrieve/search.js';
import { ConfigSchema } from '../src/config.js';
import { buildGraph, type LoreGraph } from '../src/graph/build.js';
import { buildNoteLinkGraph } from '../src/retrieve/expand.js';
import type { LoreContext } from '../src/context.js';

/**
 * Every schema version that was ever published must still open.
 *
 * The index is a disposable cache, but people do not expect to delete it to
 * install an upgrade, and a migration that fails leaves them with a tool that
 * will not start. Verified by hand against real installs of 0.1.0, 0.2.0,
 * 0.3.0, 0.3.5 and 0.4.0 from npm; reproduced here without the network by
 * building each historical schema from the migration list itself, so a new
 * migration is checked against every old database automatically.
 */
async function makeVaultAtSchema(version: number): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `lw-mig-v${version}-`));
  await writeFile(
    join(root, 'alpha.md'),
    '# Alpha\n\nSee [[Beta]] and [a link](beta.md). Distinctive: PANGOLIN.\n\n- role:: Engineer\n',
  );
  await writeFile(
    join(root, 'beta.md'),
    '---\ntitle: Beta\ndate: 2025-04-01\n---\n\n# Beta\n\nBack to [[Alpha]].\n',
  );
  const dbFile = join(root, 'index.db');
  const db = new Database(dbFile);
  db.exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  for (let i = 0; i < version; i++) {
    db.exec(MIGRATIONS[i]!.replace(/CREATE TABLE meta[^;]+;/, ''));
  }
  db.prepare(`INSERT INTO meta(key,value) VALUES('schema_version',?)`).run(String(version));
  db.close();
  return root;
}

describe('schema upgrades', () => {
  for (let v = 1; v <= MIGRATIONS.length; v++) {
    it(`a database written at schema v${v} opens, upgrades and still answers`, async () => {
      const root = await makeVaultAtSchema(v);
      const dbFile = join(root, 'index.db');

      const store = openStore(dbFile);
      const after = store.db
        .prepare(`SELECT value FROM meta WHERE key='schema_version'`)
        .get() as { value: string };
      expect(Number(after.value)).toBe(MIGRATIONS.length);

      // and it is not merely open — it indexes and answers
      await indexVault(store, root);
      const config = ConfigSchema.parse({});
      let cached: LoreGraph | null = null;
      const ctx: LoreContext = {
        root,
        config,
        store,
        provider: null,
        graph: () => (cached ??= buildGraph(store, config)),
        noteLinks: () => buildNoteLinkGraph(store),
        invalidateGraph: () => (cached = null),
        close: () => store.close(),
      };
      const hits = await search(ctx, 'PANGOLIN', { k: 5 });
      expect(hits.length).toBeGreaterThan(0);
      expect(hits[0]!.notePath).toBe('alpha.md');
      store.close();
    });
  }

  it('a migration that changes parse output invalidates what the old parser wrote', async () => {
    // Incremental indexing short-circuits on mtime AND size before it ever
    // consults the hash. A migration that clears only the hash therefore
    // changes nothing: the schema upgrades, the rows keep whatever the old
    // parser put there, and the bug looks fixed because it IS fixed on new
    // vaults. Measured — the upgrade reported "+0 ~0 -0 =3" until all three
    // were cleared.
    const root = await makeVaultAtSchema(4);
    const dbFile = join(root, 'index.db');

    // populate it the way v4 would have, then upgrade
    const old = new Database(dbFile);
    old
      .prepare(
        `INSERT INTO notes(path,title,frontmatter,tags,hash,mtime_ms,size,indexed_at)
         VALUES ('alpha.md','Alpha','{}','[]','stale-hash',1,1,'2026-01-01')`,
      )
      .run();
    old.close();

    const store = openStore(dbFile);
    const row = store.db.prepare(`SELECT hash, mtime_ms, size FROM notes`).get() as {
      hash: string;
      mtime_ms: number;
      size: number;
    };
    expect(row.hash).toBe('');
    expect(row.mtime_ms).toBe(-1);
    expect(row.size).toBe(-1);

    // so the next index actually reparses rather than reporting "unchanged"
    const report = await indexVault(store, root);
    expect(report.unchanged).toBe(0);
    store.close();
  });
});
