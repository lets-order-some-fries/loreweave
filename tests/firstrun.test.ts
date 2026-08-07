import { describe, expect, it } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openContext, ensureIndexed } from '../src/context.js';
import { search } from '../src/retrieve/search.js';
import { indexVault } from '../src/index/indexer.js';
import { FIXTURE_VAULT, makeVault } from './helpers.js';

/**
 * The first thing a new user does must not produce the worst answer a
 * knowledge tool can give. `lore search` in a vault of 39 notes replied "no
 * results" — indistinguishable from a genuine miss, at the one moment they
 * have no way to tell the difference. Over MCP it is worse: an agent gets `[]`
 * and reports that the user has nothing written on the subject.
 */
describe('first run', () => {
  it('answers from a vault that has never been indexed', async () => {
    const root = await makeVault(FIXTURE_VAULT);
    const ctx = openContext(root);
    expect((ctx.store.db.prepare('SELECT COUNT(*) c FROM notes').get() as { c: number }).c).toBe(0);

    const didIndex = await ensureIndexed(ctx);
    expect(didIndex).toBe(true);

    const hits = await search(ctx, 'riverbed protocol', { k: 5 });
    expect(hits.length).toBeGreaterThan(0);
    ctx.close();
  });

  it('reports how many notes it is about to index, once', async () => {
    const root = await makeVault(FIXTURE_VAULT);
    const ctx = openContext(root);
    const seen: number[] = [];
    await ensureIndexed(ctx, (n) => seen.push(n));
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBeGreaterThan(0);

    // second call is a no-op: no callback, no re-index
    seen.length = 0;
    expect(await ensureIndexed(ctx, (n) => seen.push(n))).toBe(false);
    expect(seen).toHaveLength(0);
    ctx.close();
  });

  it('leaves an already-indexed vault alone', async () => {
    const root = await makeVault(FIXTURE_VAULT);
    const ctx = openContext(root);
    await indexVault(ctx.store, root);
    const before = ctx.store.db.prepare('SELECT COUNT(*) c FROM notes').get() as { c: number };
    expect(await ensureIndexed(ctx)).toBe(false);
    const after = ctx.store.db.prepare('SELECT COUNT(*) c FROM notes').get() as { c: number };
    expect(after.c).toBe(before.c);
    ctx.close();
  });

  it('says nothing about an empty vault, because "no results" is then true', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lw-empty-'));
    const ctx = openContext(root);
    const seen: number[] = [];
    expect(await ensureIndexed(ctx, (n) => seen.push(n))).toBe(false);
    expect(seen).toHaveLength(0);
    expect(await search(ctx, 'anything at all', { k: 5 })).toEqual([]);
    ctx.close();
  });
});
