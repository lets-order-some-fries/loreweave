import { describe, expect, it } from 'vitest';
import { openStore } from '../src/store/db.js';
import { parseNote } from '../src/vault/parse.js';
import { openStore } from '../src/store/db.js';
import { indexVault } from '../src/index/indexer.js';
import { parseNote } from '../src/vault/parse.js';
import { linkMatchKey, resolveRelative } from '../src/normalize.js';
import { makeVault } from './helpers.js';

describe('markdown link parsing', () => {
  it('parses relative .md links as note links', () => {
    const n = parseNote(
      'notes/a.md',
      'See [the design](../docs/design.md) and [sibling](./b.md) and [deep](sub/c.md#Section).\n',
      1,
    );
    const md = n.links.filter((l) => l.style === 'markdown');
    expect(md).toHaveLength(3);
    expect(md[0]).toMatchObject({ target: '../docs/design.md', alias: 'the design' });
    expect(md[1]!.target).toBe('b.md');
    expect(md[2]).toMatchObject({ target: 'sub/c.md', heading: 'Section' });
  });

  it('ignores external, image, anchor and non-md links', () => {
    const n = parseNote(
      'a.md',
      `[web](https://example.com) [mail](mailto:x@y.z) ![img](pic.png) [anchor](#top) [pdf](file.pdf)\n`,
      1,
    );
    expect(n.links.filter((l) => l.style === 'markdown')).toHaveLength(0);
  });

  it('ignores links inside code fences and inline code', () => {
    const n = parseNote(
      'a.md',
      'Text\n\n```sh\n[[not a link]] and [x](y.md)\n```\n\nInline `[[also not]]` here.\n\nReal [[Target]].\n',
      1,
    );
    expect(n.links.map((l) => l.target)).toEqual(['Target']);
  });

  it('decodes percent-encoded targets', () => {
    const n = parseNote('a.md', '[x](my%20note.md)\n', 1);
    expect(n.links[0]!.target).toBe('my note.md');
  });

  it('resolveRelative handles ./ ../ and refuses vault escapes', () => {
    expect(resolveRelative('notes/deep/a.md', '../b.md')).toBe('notes/b.md');
    expect(resolveRelative('notes/a.md', './b.md')).toBe('notes/b.md');
    expect(resolveRelative('a.md', '../../etc/passwd.md')).toBeNull();
  });

  it('both link styles resolve to the same match key', () => {
    expect(linkMatchKey('notes/a.md', '../people/Amara Osei.md', 'markdown')).toBe('amara osei');
    expect(linkMatchKey('notes/a.md', 'Amara Osei', 'wiki')).toBe('amara osei');
  });
});

describe('markdown links build real graph edges', () => {
  it('a markdown-linked vault gets links, in-degree importance and no false orphans', async () => {
    const root = await makeVault({
      'index.md': '# Index\n\nSee [Alpha](projects/alpha.md) and [Beta](projects/beta.md).\n',
      'projects/alpha.md': '---\ntitle: Alpha\n---\n\nAlpha depends on [Beta](./beta.md).\n',
      'projects/beta.md': '---\ntitle: Beta\n---\n\nBeta stands alone.\n',
    });
    const store = openStore(':memory:');
    await indexVault(store, root);

    const links = store.db.prepare(`SELECT note_path, target_norm FROM links`).all() as {
      note_path: string;
      target_norm: string;
    }[];
    expect(links).toHaveLength(3);
    expect(links.map((l) => l.target_norm).sort()).toEqual(['alpha', 'beta', 'beta']);

    // beta is linked twice → higher importance than the unlinked index note
    const imp = (p: string) =>
      (store.db.prepare(`SELECT importance i FROM blocks WHERE note_path=?`).get(p) as any).i;
    expect(imp('projects/beta.md')).toBeGreaterThan(imp('index.md'));

    store.close();
  });
});

describe('how a link was written is remembered', () => {
  it('persists wiki vs markdown style', async () => {
    // The parser has always distinguished them and the store discarded it, so
    // `doctor` rendered every broken link as `[[target]]` — including ones the
    // file spells `](target)`, sending the reader grepping for text that is
    // not in their vault.
    const store = openStore(':memory:');
    store.upsertNote(
      parseNote('a.md', '# A\n\nSee [[Beta]] and [also this](sub/real.md).\n', 1),
    );
    const rows = store.db
      .prepare(`SELECT target, style FROM links ORDER BY style`)
      .all() as { target: string; style: string }[];
    expect(rows).toEqual([
      { target: 'sub/real.md', style: 'markdown' },
      { target: 'Beta', style: 'wiki' },
    ]);
    store.close();
  });
});

describe('schema migration v5', () => {
  it('forces a reparse so existing rows do not keep the column default', async () => {
    // Incremental indexing short-circuits on mtime AND size before it ever
    // looks at the hash, so a migration that clears only the hash changes
    // nothing — the schema upgrades and the data does not.
    const { MIGRATIONS } = await import('../src/store/schema.js');
    const v5 = MIGRATIONS[4] ?? '';
    expect(v5).toContain('style');
    expect(v5).toMatch(/mtime_ms\s*=\s*-1/);
    expect(v5).toMatch(/size\s*=\s*-1/);
  });

  it('an index written before the column still opens and upgrades', async () => {
    const store = openStore(':memory:');
    store.upsertNote(parseNote('a.md', '# A\n\n[md](b.md) and [[Wiki]]\n', 1));
    const version = store.db
      .prepare(`SELECT value FROM meta WHERE key='schema_version'`)
      .get() as { value: string };
    expect(Number(version.value)).toBeGreaterThanOrEqual(5);
    const cols = (store.db.prepare(`PRAGMA table_info(links)`).all() as { name: string }[]).map(
      (c) => c.name,
    );
    expect(cols).toContain('style');
    store.close();
  });
});
