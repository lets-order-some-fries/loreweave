import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, writeFile, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../src/store/db.js';
import { indexVault } from '../src/index/indexer.js';
import { watchVault, type Watcher } from '../src/watch.js';
import { ConfigSchema } from '../src/config.js';
import { buildGraph, type LoreGraph } from '../src/graph/build.js';
import { buildNoteLinkGraph } from '../src/retrieve/expand.js';
import type { LoreContext } from '../src/context.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const open: { w: Watcher; ctx: LoreContext }[] = [];
afterEach(() => {
  for (const { w, ctx } of open.splice(0)) {
    w.close();
    ctx.close();
  }
});

async function ctxWithWatcher(opts: Parameters<typeof watchVault>[1]) {
  const root = await mkdtemp(join(tmpdir(), 'lw-watch-'));
  await writeFile(join(root, 'a.md'), '# Alpha\n\noriginal content\n');
  const store = openStore(':memory:');
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
  const w = watchVault(ctx, opts);
  open.push({ w, ctx });
  await sleep(120); // let the OS watcher attach
  return ctx;
}

const indexed = (ctx: LoreContext, s: string) =>
  (ctx.store.db.prepare(`SELECT COUNT(*) c FROM blocks WHERE text LIKE ?`).get(`%${s}%`) as { c: number })
    .c > 0;

describe('watch', () => {
  // Real editors do not overwrite in place. If any of these three patterns is
  // missed, the user's edits simply never reach the index in that editor and
  // nothing says so.
  const SAVES: [string, (root: string, body: string) => Promise<void>][] = [
    ['writes in place (Obsidian)', async (r, b) => {
      await writeFile(join(r, 'a.md'), b);
    }],
    ['writes a temp file and renames over (VSCode, Emacs)', async (r, b) => {
      await writeFile(join(r, '.a.md.tmp'), b);
      await rename(join(r, '.a.md.tmp'), join(r, 'a.md'));
    }],
    ['renames to a backup then writes fresh (vim)', async (r, b) => {
      await rename(join(r, 'a.md'), join(r, 'a.md~'));
      await writeFile(join(r, 'a.md'), b);
      await rm(join(r, 'a.md~'));
    }],
  ];

  for (const [name, save] of SAVES) {
    it(`sees an editor that ${name}`, async () => {
      const ctx = await ctxWithWatcher({ debounceMs: 100 });
      await save(ctx.root, '# Alpha\n\nMARKERWORD here\n');
      await sleep(1200);
      expect(indexed(ctx, 'MARKERWORD')).toBe(true);
    }, 15_000);
  }

  it('reindexes a vault that never goes quiet', async () => {
    // A plain debounce restarts on every event, so a vault under continuous
    // change — a sync client landing another device's notes, a bulk import, an
    // agent capturing as it works — was never reindexed at all. Measured
    // before the ceiling: 6 s of writes 120 ms apart produced ZERO reindexes.
    let reindexes = 0;
    const ctx = await ctxWithWatcher({
      debounceMs: 400,
      maxWaitMs: 800,
      onReindex: () => reindexes++,
    });
    const until = Date.now() + 4000;
    for (let i = 0; Date.now() < until; i++) {
      await writeFile(join(ctx.root, `sync-${i}.md`), `# Sync ${i}\n\nBUSYMARKER ${i}\n`);
      await sleep(120); // strictly less than the debounce
    }
    expect(reindexes).toBeGreaterThan(0);
    expect(indexed(ctx, 'BUSYMARKER')).toBe(true);
  }, 20_000);

  it('still waits out the quiet period for a single edit', async () => {
    // The ceiling must not turn the debounce into "reindex on every keystroke".
    let reindexes = 0;
    const ctx = await ctxWithWatcher({ debounceMs: 500, maxWaitMs: 2000, onReindex: () => reindexes++ });
    await writeFile(join(ctx.root, 'a.md'), '# Alpha\n\nQUIETMARKER\n');
    await sleep(150);
    expect(reindexes).toBe(0);
    await sleep(1000);
    expect(reindexes).toBe(1);
  }, 15_000);

  it('a maxWait below the debounce cannot defeat the debounce', async () => {
    let reindexes = 0;
    const ctx = await ctxWithWatcher({ debounceMs: 500, maxWaitMs: 1, onReindex: () => reindexes++ });
    await writeFile(join(ctx.root, 'a.md'), '# Alpha\n\nCLAMPMARKER\n');
    await sleep(150);
    expect(reindexes).toBe(0);
    await sleep(1000);
    expect(reindexes).toBe(1);
  }, 15_000);

  it('does not reindex in response to its own generated notes', async () => {
    // dream writes under lore/; if that triggered a reindex, the reindex would
    // trigger the next write and the watcher would spin forever.
    let reindexes = 0;
    const ctx = await ctxWithWatcher({ debounceMs: 150, maxWaitMs: 300, onReindex: () => reindexes++ });
    await writeFile(join(ctx.root, 'lore/review-queue.md'), '# Review queue\n\n- [ ] orphan: x\n').catch(
      async () => {
        const { mkdir } = await import('node:fs/promises');
        await mkdir(join(ctx.root, 'lore'), { recursive: true });
        await writeFile(join(ctx.root, 'lore/review-queue.md'), '# Review queue\n');
      },
    );
    await sleep(900);
    expect(reindexes).toBe(0);
  }, 15_000);
});
