import { describe, expect, it } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../src/store/db.js';
import { indexVault } from '../src/index/indexer.js';
import { findStale } from '../src/dream/dream.js';
import { markUsed, resolveBlockIds } from '../src/dynamics/usage.js';
import { ConfigSchema } from '../src/config.js';
import type { LoreContext } from '../src/context.js';

/**
 * `review` is the spaced-repetition loop made operable: important knowledge
 * whose retrievability has decayed surfaces, use reinforces it, and it stops
 * surfacing. No other vault tool ships this deterministically.
 */
async function ctxWithAgedBlock(): Promise<LoreContext> {
  const root = await mkdtemp(join(tmpdir(), 'lw-rv-'));
  await writeFile(join(root, 'a.md'), '# Alpha\n\nThe calibration constants live here.\n');
  await writeFile(join(root, 'b.md'), '# Beta\n\nFresh scratch notes.\n');
  const store = openStore(':memory:');
  await indexVault(store, root);
  // Age note a: important, once known well (stability 5d), untouched for a year.
  store.db
    .prepare(
      `UPDATE blocks SET importance=0.9, stability=5, last_accessed='2025-08-01T00:00:00Z'
       WHERE note_path='a.md'`,
    )
    .run();
  // Note b: important but touched right now — not fading.
  store.db
    .prepare(
      `UPDATE blocks SET importance=0.9, stability=5, last_accessed=?
       WHERE note_path='b.md'`,
    )
    .run(new Date().toISOString());
  return {
    root,
    config: ConfigSchema.parse({}),
    store,
    provider: null,
    graph: () => {
      throw new Error('unused');
    },
    noteLinks: () => {
      throw new Error('unused');
    },
    invalidateGraph: () => {},
    close: () => store.close(),
  } as unknown as LoreContext;
}

describe('review (findStale on demand)', () => {
  it('an important, long-untouched block surfaces; a fresh one does not', async () => {
    const ctx = await ctxWithAgedBlock();
    const items = findStale(ctx);
    const refs = items.map((i) => i.ref);
    expect(refs.some((r) => r.startsWith('a.md#'))).toBe(true);
    expect(refs.some((r) => r.startsWith('b.md#'))).toBe(false);
    const aged = items.find((i) => i.ref.startsWith('a.md#'))!;
    expect(aged.retrievability!).toBeLessThan(0.3);
    ctx.close();
  });

  it('marking it used reinforces it out of the review queue', async () => {
    const ctx = await ctxWithAgedBlock();
    expect(findStale(ctx).some((i) => i.ref.startsWith('a.md#'))).toBe(true);
    markUsed(ctx.store, resolveBlockIds(ctx.store, 'a.md'));
    expect(findStale(ctx).some((i) => i.ref.startsWith('a.md#'))).toBe(false);
    ctx.close();
  });

  it('the threshold is a parameter, not a constant', async () => {
    const ctx = await ctxWithAgedBlock();
    // The aged block sits at R ≈ 0.23: fading under the default 0.3 bar,
    // fine under a stricter 0.1 bar. Same vault, same block — the threshold
    // decides, which is exactly what makes it tunable per taste.
    expect(findStale(ctx).some((i) => i.ref.startsWith('a.md#'))).toBe(true);
    expect(
      findStale(ctx, { rThreshold: 0.1 }).some((i) => i.ref.startsWith('a.md#')),
    ).toBe(false);
    ctx.close();
  });
});
