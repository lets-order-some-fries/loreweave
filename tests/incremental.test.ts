import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { openStore, type Store } from '../src/store/db.js';
import { indexVault } from '../src/index/indexer.js';

/**
 * The index is a cache, and the whole design rests on it being disposable: the
 * markdown is the truth, and `rm -rf .lore` must never change an answer. That
 * only holds if incrementally updating the cache lands in exactly the state a
 * from-scratch rebuild would. Nothing else in the suite checks that — the
 * indexer tests all start from empty — and a leak here is invisible in the
 * worst way, since it makes the engine answer from notes that no longer exist.
 */
function snapshot(store: Store) {
  const q = (sql: string) => JSON.stringify(store.db.prepare(sql).all());
  return {
    notes: q('SELECT path,title,tags,hash FROM notes ORDER BY path'),
    blocks: q('SELECT note_path,anchor,heading,ord,text FROM blocks ORDER BY note_path,anchor,ord'),
    links: q(
      `SELECT note_path,block_anchor,target_norm,heading,alias FROM links
       ORDER BY note_path,block_anchor,target_norm,heading,alias`,
    ),
    entities: q('SELECT key,display FROM entities ORDER BY key'),
    mentions: q(
      `SELECT e.key, m.note_path, m.block_anchor, m.source FROM mentions m
       JOIN entities e ON e.id = m.entity_id ORDER BY e.key, m.note_path, m.block_anchor, m.source`,
    ),
    fts: q(
      `SELECT b.note_path, b.anchor FROM blocks b
       WHERE NOT EXISTS (SELECT 1 FROM blocks_fts f WHERE f.rowid = b.id) ORDER BY 1,2`,
    ),
  };
}

const BASE: Record<string, string> = {
  'a.md': '# Alpha\n\nAbout [[Beta]] and Amara Osei.\n',
  'b.md': '# Beta\n\nLinks to [[Alpha]]. Priya Sharma was here.\n',
  'sub/c.md': '# Gamma\n\nSee [[Beta]] and [[Delta]].\n',
  'sub/d.md': '# Delta\n\nEnd of the chain.\n',
};

async function build(root: string, files: Record<string, string>) {
  for (const [p, c] of Object.entries(files)) {
    await mkdir(dirname(join(root, p)), { recursive: true });
    await writeFile(join(root, p), c);
  }
}

const MUTATIONS: [string, (root: string) => Promise<void>][] = [
  ['a note is edited', async (r) => {
    await writeFile(join(r, 'a.md'), '# Alpha\n\nRewritten. Cites [[Delta]] now, not Beta.\n');
  }],
  ['a note is deleted', async (r) => {
    await rm(join(r, 'b.md'));
  }],
  ['a note is renamed', async (r) => {
    await rename(join(r, 'b.md'), join(r, 'b-renamed.md'));
  }],
  ['a note moves to another folder', async (r) => {
    await rename(join(r, 'sub/c.md'), join(r, 'c.md'));
  }],
  ['a note is added', async (r) => {
    await writeFile(join(r, 'e.md'), '# Epsilon\n\nNew note citing [[Alpha]].\n');
  }],
  ['a note shrinks to a stub', async (r) => {
    await writeFile(join(r, 'sub/d.md'), '# Delta\n');
  }],
  ['a whole folder is deleted', async (r) => {
    await rm(join(r, 'sub'), { recursive: true });
  }],
  ['two notes swap contents', async (r) => {
    await writeFile(join(r, 'a.md'), BASE['b.md']!);
    await writeFile(join(r, 'b.md'), BASE['a.md']!);
  }],
  ['every note is replaced at once', async (r) => {
    await rm(join(r, 'sub'), { recursive: true });
    await writeFile(join(r, 'a.md'), '# One\n\nTotally new [[Two]].\n');
    await writeFile(join(r, 'b.md'), '# Two\n\nTotally new [[One]].\n');
  }],
];

describe('incremental indexing', () => {
  for (const [name, mutate] of MUTATIONS) {
    it(`leaves the same state as a rebuild when ${name}`, async () => {
      const root = await mkdtemp(join(tmpdir(), 'lw-inc-'));
      await build(root, BASE);

      const incremental = openStore(':memory:');
      await indexVault(incremental, root);
      await mutate(root);
      await indexVault(incremental, root);

      const fresh = openStore(':memory:');
      await indexVault(fresh, root);

      const a = snapshot(incremental);
      const b = snapshot(fresh);
      for (const key of Object.keys(a) as (keyof typeof a)[]) {
        expect(a[key], `${key} diverged after ${name}`).toBe(b[key]);
      }
      // and nothing is left pointing at a note that is gone
      const orphanBlocks = incremental.db
        .prepare('SELECT COUNT(*) c FROM blocks WHERE note_path NOT IN (SELECT path FROM notes)')
        .get() as { c: number };
      expect(orphanBlocks.c).toBe(0);

      incremental.close();
      fresh.close();
    });
  }
});
