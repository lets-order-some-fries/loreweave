import { describe, expect, it } from 'vitest';
import { openStore } from '../src/store/db.js';
import { indexVault } from '../src/index/indexer.js';
import { search, matchQueryEntities } from '../src/retrieve/search.js';
import { markUsed, resolveBlockIds } from '../src/dynamics/usage.js';
import { ConfigSchema } from '../src/config.js';
import type { LoreContext } from '../src/context.js';
import { buildGraph, type LoreGraph } from '../src/graph/build.js';
import { buildNoteLinkGraph } from '../src/retrieve/expand.js';
import { FIXTURE_VAULT, makeVault } from './helpers.js';

async function fixtureCtx(): Promise<LoreContext> {
  const root = await makeVault(FIXTURE_VAULT);
  const config = ConfigSchema.parse({});
  const store = openStore(':memory:');
  await indexVault(store, root);
  let cached: LoreGraph | null = null;
  return {
    root,
    config,
    store,
    provider: null,
    graph() {
      if (!cached) cached = buildGraph(store, config);
      return cached;
    },
    noteLinks: () => buildNoteLinkGraph(store),
    invalidateGraph() {
      cached = null;
    },
    close() {
      store.close();
    },
  };
}

describe('search', () => {
  it('finds direct lexical matches', async () => {
    const ctx = await fixtureCtx();
    const res = await search(ctx, 'meltwater sensor readings');
    expect(res.length).toBeGreaterThan(0);
    expect(res[0]!.notePath).toBe('data/glacier-dataset.md');
    ctx.close();
  });

  it('multi-hop: graph fusion surfaces the bridge and the 2-hop target over the decoy-only ranking', async () => {
    const ctx = await fixtureCtx();
    // "riverbed protocol dataset": decoy note spams 'riverbed protocol' but has
    // no dataset link; glacier-dataset says 'dataset' but not riverbed. The
    // bridge (Amara Osei) connects them. Graph-aware search must rank the real
    // cluster (riverbed/amara/glacier) above or alongside, and MUST include
    // glacier-dataset in top results — pure BM25 would rank the decoy #1 and
    // may miss glacier entirely for 'riverbed protocol'.
    const res = await search(ctx, 'riverbed protocol dataset', { k: 5 });
    const paths = res.map((r) => r.notePath);
    expect(paths).toContain('data/glacier-dataset.md');
    const glacierRank = paths.indexOf('data/glacier-dataset.md');
    const decoyRank = paths.indexOf('misc/decoy.md');
    if (decoyRank >= 0) expect(glacierRank).toBeLessThan(decoyRank);
    ctx.close();
  });

  it('graph-only query (no lexical overlap in target) still reaches connected notes', async () => {
    const ctx = await fixtureCtx();
    // 'amara osei' appears in people note; riverbed note links to her.
    const res = await search(ctx, 'amara osei', { k: 5 });
    const paths = res.map((r) => r.notePath);
    expect(paths).toContain('people/amara-osei.md');
    expect(paths).toContain('projects/riverbed.md');
    ctx.close();
  });

  it('explains results via connecting entities', async () => {
    const ctx = await fixtureCtx();
    const res = await search(ctx, 'amara osei', { k: 5 });
    const withVia = res.find((r) => r.via.includes('amara osei'));
    expect(withVia).toBeDefined();
    ctx.close();
  });

  it('since filter excludes old notes', async () => {
    const ctx = await fixtureCtx();
    const future = new Date(Date.now() + 86_400_000).toISOString();
    const res = await search(ctx, 'meltwater sensor readings', { since: future });
    expect(res).toHaveLength(0);
    ctx.close();
  });

  it('logs retrieval access and reinforcement on markUsed', async () => {
    const ctx = await fixtureCtx();
    await search(ctx, 'meltwater sensor');
    const logged = ctx.store.db
      .prepare(`SELECT COUNT(*) c FROM access_log WHERE kind='retrieved'`)
      .get() as any;
    expect(logged.c).toBeGreaterThan(0);

    const ids = resolveBlockIds(ctx.store, 'data/glacier-dataset.md');
    const before = ctx.store.db
      .prepare(`SELECT stability FROM blocks WHERE id=?`)
      .get(ids[0]!) as any;
    markUsed(ctx.store, ids);
    const after = ctx.store.db
      .prepare(`SELECT stability, access_count FROM blocks WHERE id=?`)
      .get(ids[0]!) as any;
    expect(after.stability).toBeGreaterThan(before.stability);
    expect(after.access_count).toBe(1);
    ctx.close();
  });

  it('empty and hostile queries return cleanly', async () => {
    const ctx = await fixtureCtx();
    expect(await search(ctx, '')).toEqual([]);
    expect(await search(ctx, '"NEAR((')).toBeDefined();
    ctx.close();
  });
});

describe('matchQueryEntities', () => {
  it('prefers longest n-gram and claims tokens', async () => {
    const ctx = await fixtureCtx();
    const g = ctx.graph();
    const m = matchQueryEntities('tell me about the riverbed protocol status', g.entityKeyIndex);
    const keys = [...m.values()].map((v) => v.key);
    expect(keys).toContain('riverbed protocol');
    // 'riverbed' alone must not double-match inside the claimed bigram
    expect(keys.filter((k) => k === 'riverbed')).toHaveLength(0);
    ctx.close();
  });
});
