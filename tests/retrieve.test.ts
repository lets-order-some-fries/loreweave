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

describe('block selection', () => {
  it('does not show a diagram when a sibling section says it in words', async () => {
    // A generated diagram restates the vocabulary of the prose it illustrates,
    // so it ties on term coverage — and ties went to whichever block came
    // first, which is the diagram. Same note, same heading, no answer.
    const root = await makeVault({
      'tdd.md': [
        '# TDD',
        '',
        '## Red-Green-Refactor',
        '',
        '```dot',
        'digraph tdd_cycle {',
        '  red [label="RED\\nWrite failing test", shape=box];',
        '  verify [label="Verify fails\\ncorrectly", shape=diamond];',
        '}',
        '```',
        '',
        '### Verify RED',
        '',
        'Watch the test fail. Confirm it fails for the right reason before you write code.',
        '',
      ].join('\n'),
    });
    const config = ConfigSchema.parse({});
    const store = openStore(':memory:');
    await indexVault(store, root);
    let cached: LoreGraph | null = null;
    const ctx: LoreContext = {
      root, config, store, provider: null,
      graph: () => (cached ??= buildGraph(store, config)),
      noteLinks: () => buildNoteLinkGraph(store),
      invalidateGraph: () => { cached = null; },
      close: () => store.close(),
    };
    const hits = await search(ctx, 'what should I do when a test fails', { k: 3 });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.snippet).not.toContain('digraph');
    expect(hits[0]!.snippet).toContain('fail');
    ctx.close();
  });
});

describe('a long query keeps its tail', () => {
  it('finds a note whose only matching word comes after the 32nd term', async () => {
    // The FTS expression was capped at 32 terms, so a long question lost
    // everything after it. That is the shape an agent produces when it pastes
    // context and puts the actual ask at the end.
    //
    // The decisive word is lowercase and ordinary on purpose. An all-caps one
    // is extracted as an entity and found by graph seeding whether or not FTS
    // saw it, which masks the defect entirely — the first two versions of this
    // probe were confounded that way.
    const root = await makeVault({
      'answer.md': '# Answer\n\nthe decisive detail is quokkaflange, recorded here and nowhere else.\n',
      'other.md': '# Other\n\nUnrelated material about scheduling and meetings.\n',
    });
    const config = ConfigSchema.parse({});
    const store = openStore(':memory:');
    await indexVault(store, root);
    let cached: LoreGraph | null = null;
    const ctx: LoreContext = {
      root, config, store, provider: null,
      graph: () => (cached ??= buildGraph(store, config)),
      noteLinks: () => buildNoteLinkGraph(store),
      invalidateGraph: () => { cached = null; },
      close: () => store.close(),
    };
    // nothing in the vault matches the filler, so only the last word can decide
    const isEntity = store.db
      .prepare(`SELECT COUNT(*) c FROM entities WHERE key='quokkaflange'`)
      .get() as { c: number };
    expect(isEntity.c).toBe(0);

    const filler = Array.from({ length: 50 }, (_, i) => `zzq${i}`).join(' ');
    const hits = await search(ctx, `${filler} quokkaflange`, { k: 3, noLog: true });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.notePath).toBe('answer.md');
    ctx.close();
  });

  it('a repeated word does not spend the term budget twice', async () => {
    const { ftsQuery } = await import('../src/store/db.js');
    const q = 'the compaction strategy for compaction of the streaming compaction pipeline';
    const terms = ftsQuery(q, ' OR ')!.split(' OR ');
    expect(terms).toHaveLength(new Set(terms).size);
    expect(terms).toHaveLength(4); // compaction, strategy, streaming, pipeline
  });
});

describe('recall channels are gates, not weights', () => {
  it('the graph weight is read as on/off, and the schema says so', async () => {
    // Entity-PPR and link expansion add notes nothing else found and are
    // spliced in by position; they never compete on score, so only `> 0` is
    // read. The field used to default to 0.35 and describe itself as
    // "weighted below lexical" — a weighting that does not happen. Setting 0.7
    // expecting more graph influence changed nothing at all.
    const root = await makeVault(FIXTURE_VAULT);
    const config = ConfigSchema.parse({});
    expect(config.retrieval.weights.graph).toBe(1);
    expect(config.retrieval.weights.expansion).toBe(1);

    const run = async (graph: number) => {
      const cfg = ConfigSchema.parse({ retrieval: { weights: { graph } } });
      const store = openStore(':memory:');
      await indexVault(store, root);
      let cached: LoreGraph | null = null;
      const ctx: LoreContext = {
        root, config: cfg, store, provider: null,
        graph: () => (cached ??= buildGraph(store, cfg)),
        noteLinks: () => buildNoteLinkGraph(store),
        invalidateGraph: () => { cached = null; },
        close: () => store.close(),
      };
      const hits = await search(ctx, 'riverbed protocol', { k: 10, noLog: true });
      const paths = hits.map((h) => h.notePath);
      ctx.close();
      return paths;
    };
    // any positive value behaves identically …
    expect(await run(0.35)).toEqual(await run(3));
    // … and zero is the only setting that changes anything
    expect(await run(0)).not.toEqual(await run(1));
  });
});
