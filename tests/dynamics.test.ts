import { describe, expect, it } from 'vitest';
import { markUsed, resolveBlockIds } from '../src/dynamics/usage.js';
import { openStore } from '../src/store/db.js';
import { indexVault } from '../src/index/indexer.js';
import { makeVault, editFile } from './helpers.js';
import { search } from '../src/retrieve/search.js';
import { ConfigSchema } from '../src/config.js';
import { buildGraph, type LoreGraph } from '../src/graph/build.js';
import { buildNoteLinkGraph } from '../src/retrieve/expand.js';
import type { LoreContext } from '../src/context.js';
import {
  MAX_STABILITY_DAYS,
  daysBetween,
  importanceHeuristic,
  reinforce,
  retrievability,
} from '../src/dynamics/fsrs.js';

describe('fsrs dynamics', () => {
  it('R(S,S) ≈ 0.9 (stability = days-to-90%)', () => {
    for (const s of [1, 7, 30, 365]) {
      expect(retrievability(s, s)).toBeCloseTo(0.9, 5);
    }
  });

  it('R decays monotonically and has a fat power-law tail', () => {
    expect(retrievability(0, 10)).toBe(1);
    expect(retrievability(5, 10)).toBeGreaterThan(retrievability(20, 10));
    // power law: even at 100x stability, R stays well above 0
    expect(retrievability(1000, 10)).toBeGreaterThan(0.15);
  });

  it('reinforcement is largest when nearly forgotten (spacing effect)', () => {
    const lowR = reinforce(10, 0.3) / 10;
    const highR = reinforce(10, 0.95) / 10;
    expect(lowR).toBeGreaterThan(highR);
    expect(highR).toBeGreaterThan(1); // still grows
  });

  it('reinforcement has diminishing returns in S and a cap', () => {
    const growthSmall = reinforce(1, 0.9) / 1;
    const growthBig = reinforce(1000, 0.9) / 1000;
    expect(growthSmall).toBeGreaterThan(growthBig);
    expect(reinforce(MAX_STABILITY_DAYS, 0.1)).toBe(MAX_STABILITY_DAYS);
  });

  it('importance stays in [0,1] and rewards linkage', () => {
    const lonely = importanceHeuristic({ inDegree: 0, outDegree: 0, recencyDays: 400 });
    const hub = importanceHeuristic({
      inDegree: 50,
      outDegree: 20,
      frontmatterPriority: 1,
      recencyDays: 1,
    });
    expect(lonely).toBeGreaterThanOrEqual(0);
    expect(hub).toBeLessThanOrEqual(1);
    expect(hub).toBeGreaterThan(lonely);
  });

  it('daysBetween handles null/garbage as Infinity', () => {
    expect(daysBetween(null, new Date())).toBe(Infinity);
    expect(daysBetween('not-a-date', new Date())).toBe(Infinity);
    expect(daysBetween(new Date(Date.now() - 86_400_000).toISOString(), new Date())).toBeCloseTo(
      1,
      1,
    );
  });
});

describe('learned state is durable', () => {
  // The FSRS maths above is exercised in isolation. None of it matters if the
  // state it operates on is wiped whenever the user saves a file, and nothing
  // was checking that — the index is rebuilt from markdown constantly, and
  // usage history is the one thing in it that cannot be re-derived from the
  // vault.
  const VAULT = {
    'a.md': '# A\n\n## One\n\nFirst section about compaction.\n\n## Two\n\nSecond section about batching.\n',
  };

  const stateOf = (store: ReturnType<typeof openStore>) =>
    store.db
      .prepare(
        `SELECT anchor, stability, access_count FROM blocks WHERE note_path='a.md' ORDER BY ord`,
      )
      .all() as { anchor: string; stability: number; access_count: number }[];

  it('survives a reindex that changes nothing', async () => {
    const root = await makeVault(VAULT);
    const store = openStore(':memory:');
    await indexVault(store, root);
    for (let i = 0; i < 4; i++) markUsed(store, resolveBlockIds(store, 'a.md'));
    const before = stateOf(store);
    expect(before.every((b) => b.access_count === 4)).toBe(true);

    await indexVault(store, root);
    expect(stateOf(store)).toEqual(before);
    store.close();
  });

  it('survives an edit to a DIFFERENT section of the same note', async () => {
    const root = await makeVault(VAULT);
    const store = openStore(':memory:');
    await indexVault(store, root);
    for (let i = 0; i < 4; i++) markUsed(store, resolveBlockIds(store, 'a.md'));

    await editFile(
      root,
      'a.md',
      '# A\n\n## One\n\nFirst section about compaction.\n\n## Two\n\nRewritten entirely.\n',
    );
    await indexVault(store, root);

    const after = stateOf(store);
    const one = after.find((b) => b.anchor === 'A/One@0')!;
    const two = after.find((b) => b.anchor === 'A/Two@0')!;
    // untouched section keeps its history …
    expect(one.access_count).toBe(4);
    expect(one.stability).toBeGreaterThan(1);
    // … and the rewritten one starts over, because the history described text
    // that no longer exists
    expect(two.access_count).toBe(0);
    expect(two.stability).toBe(1);
    store.close();
  });

  it('reinforcement actually changes what search returns', async () => {
    // Five notes that answer the query equally well, so ranking among them is
    // decided by nothing else. If use did not move them, the whole
    // spaced-repetition layer would be decorative.
    const files: Record<string, string> = {};
    for (let i = 0; i < 5; i++) {
      files[`doc-${i}.md`] =
        `# Doc ${i}\n\nOur compaction strategy for streaming ingestion, variant ${i}.\n` +
        `Discusses compaction, strategy, throughput and batching in detail.\n`;
    }
    const root = await makeVault(files);
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
    const rank = async () =>
      (await search(ctx, 'compaction strategy', { k: 5, noLog: true })).map((h) => h.notePath);

    const before = await rank();
    const target = before[before.length - 1]!;
    for (let i = 0; i < 5; i++) markUsed(store, resolveBlockIds(store, target));
    ctx.invalidateGraph();

    const after = await rank();
    expect(after.indexOf(target)).toBeLessThan(before.indexOf(target));
    ctx.close();
  });
});

describe('a never-read block is not treated as forgotten', () => {
  it('ranks unaccessed blocks at neutral retrievability, not zero', async () => {
    // FSRS says a block never accessed has R = 0 — infinitely long since it
    // was last recalled. Applying that literally to search would multiply the
    // retrievability boost by zero for every note the user has not already
    // read, which is exactly the material a search is usually FOR. The ranker
    // substitutes a neutral 0.5 when `last_accessed` is null.
    //
    // Nothing was pinning that. Replacing it with a plain
    // `retrievability(days, stability)` looks like a simplification, passes
    // every other test, and quietly buries new content.
    const root = await makeVault({
      'n.md': '# Note\n\n## Intro\n\nAlpha compaction.\n\n## Detail\n\nBeta compaction.\n',
    });
    const store = openStore(':memory:');
    await indexVault(store, root);

    const raw = store.db
      .prepare(`SELECT anchor, stability, last_accessed FROM blocks WHERE note_path='n.md'`)
      .all() as { anchor: string; stability: number; last_accessed: string | null }[];
    // the model's own answer for a block that has never been read
    for (const b of raw) {
      expect(b.last_accessed).toBeNull();
      expect(retrievability(daysBetween(b.last_accessed, new Date()), b.stability)).toBe(0);
    }

    const config = ConfigSchema.parse({});
    let cached: LoreGraph | null = null;
    const ctx: LoreContext = {
      root, config, store, provider: null,
      graph: () => (cached ??= buildGraph(store, config)),
      noteLinks: () => buildNoteLinkGraph(store),
      invalidateGraph: () => { cached = null; },
      close: () => store.close(),
    };
    // …but the ranker reports the neutral value it actually used
    const hits = await search(ctx, 'compaction', { k: 3, noLog: true });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.parts.retrievability).toBe(0.5);
    ctx.close();
  });
});
