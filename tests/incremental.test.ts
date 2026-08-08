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

describe('incremental indexing under generated mutation sequences', () => {
  // The nine cases above are ones I chose. Choosing them is exactly how the
  // fact store's invariants came to pass three hand-written histories while
  // failing 127 of 300 generated ones, so the same claim gets the same
  // treatment here: random adds, edits, deletes, moves and truncations, then
  // assert the index equals a rebuild of the same bytes.
  function rng(seed: number) {
    let s = seed >>> 0;
    return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  }
  const WORDS =
    'alpha beta gamma delta epsilon compaction ingestion throughput ledger atlas riverbed'.split(' ');
  const DIRS = ['', 'notes/', 'daily/', 'notes/deep/'];

  const body = (rand: () => number) => {
    const secs = Array.from({ length: 1 + Math.floor(rand() * 4) }, (_, i) => {
      const words = Array.from(
        { length: 3 + Math.floor(rand() * 20) },
        () => WORDS[Math.floor(rand() * WORDS.length)],
      ).join(' ');
      const link = rand() < 0.4 ? ` [[Note ${Math.floor(rand() * 8)}]]` : '';
      return `## Section ${i}\n\n${words}${link}\n`;
    }).join('\n');
    const fm =
      rand() < 0.5
        ? `---\ntitle: Note ${Math.floor(rand() * 8)}\ndate: 2025-0${1 + Math.floor(rand() * 9)}-1${Math.floor(rand() * 10)}\n---\n\n`
        : '';
    return `${fm}# Note\n\n${secs}`;
  };

  const listMd = async (root: string): Promise<string[]> => {
    const { readdir } = await import('node:fs/promises');
    const out: string[] = [];
    const walk = async (dir: string, rel: string) => {
      for (const e of await readdir(dir, { withFileTypes: true })) {
        if (e.name.startsWith('.')) continue;
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) await walk(join(dir, e.name), r);
        else if (e.name.endsWith('.md')) out.push(r);
      }
    };
    await walk(root, '');
    return out;
  };

  it('always lands where a rebuild would, over 60 sequences', async () => {
    for (let seed = 1; seed <= 60; seed++) {
      const rand = rng(seed);
      const root = await mkdtemp(join(tmpdir(), 'lw-prop-'));
      for (let i = 0; i < 3 + Math.floor(rand() * 5); i++) {
        const p = `${DIRS[Math.floor(rand() * DIRS.length)]}n${i}.md`;
        await mkdir(dirname(join(root, p)), { recursive: true });
        await writeFile(join(root, p), body(rand));
      }
      const incremental = openStore(':memory:');
      await indexVault(incremental, root);

      const ops: string[] = [];
      for (let step = 0; step < 1 + Math.floor(rand() * 5); step++) {
        const files = await listMd(root);
        const pick = files[Math.floor(rand() * files.length)];
        const r = rand();
        if (r < 0.3) {
          const p = `${DIRS[Math.floor(rand() * DIRS.length)]}new${step}${seed}.md`;
          await mkdir(dirname(join(root, p)), { recursive: true });
          await writeFile(join(root, p), body(rand));
          ops.push(`add ${p}`);
        } else if (pick && r < 0.55) {
          await writeFile(join(root, pick), body(rand));
          ops.push(`edit ${pick}`);
        } else if (pick && r < 0.75) {
          await rm(join(root, pick));
          ops.push(`delete ${pick}`);
        } else if (pick && r < 0.9) {
          const to = `${DIRS[Math.floor(rand() * DIRS.length)]}moved${step}${seed}.md`;
          await mkdir(dirname(join(root, to)), { recursive: true });
          await rename(join(root, pick), join(root, to));
          ops.push(`move ${pick}`);
        } else if (pick) {
          await writeFile(join(root, pick), '');
          ops.push(`truncate ${pick}`);
        }
        await indexVault(incremental, root);
      }

      const fresh = openStore(':memory:');
      await indexVault(fresh, root);
      const a = snapshot(incremental);
      const b = snapshot(fresh);
      const where = `seed ${seed}: ${ops.join(' | ')}`;
      for (const key of Object.keys(a) as (keyof typeof a)[]) {
        expect(a[key], `${key} — ${where}`).toBe(b[key]);
      }
      incremental.close();
      fresh.close();
    }
  }, 120_000);
});
