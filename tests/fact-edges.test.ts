import { describe, expect, it } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../src/store/db.js';
import { indexVault } from '../src/index/indexer.js';
import { assertFact } from '../src/facts/model.js';
import { search } from '../src/retrieve/search.js';
import { buildGraph, type LoreGraph } from '../src/graph/build.js';
import { buildNoteLinkGraph } from '../src/retrieve/expand.js';
import { ConfigSchema } from '../src/config.js';
import type { LoreContext } from '../src/context.js';

/**
 * The fact store knew "Brasshold :: funder :: Quill Trust" and the graph did
 * not — PPR walked mention and co-occurrence edges while the strongest
 * relational evidence in the vault sat outside it. Fact edges put stated
 * relations where the walk can use them.
 */
async function ctxWithFactChain(): Promise<LoreContext> {
  const root = await mkdtemp(join(tmpdir(), 'lw-fe-'));
  await writeFile(
    join(root, 'brasshold.md'),
    '# Brasshold\n\nThe Brasshold programme runs the coastal spectrometer sweeps.\n',
  );
  await writeFile(
    join(root, 'quill-trust.md'),
    '# Quill Trust\n\nThe Quill Trust is a small grant-making body for field science.\n',
  );
  const store = openStore(':memory:');
  await indexVault(store, root);
  let cached: LoreGraph | null = null;
  const ctx = {
    root,
    config: ConfigSchema.parse({}),
    store,
    provider: null,
    graph: () => (cached ??= buildGraph(store, config())),
    noteLinks: () => buildNoteLinkGraph(store),
    invalidateGraph: () => (cached = null),
    close: () => store.close(),
  } as unknown as LoreContext;
  const config = () => (ctx as { config: ReturnType<typeof ConfigSchema.parse> }).config;
  return ctx;
}

describe('fact edges', () => {
  it('a currently-valid fact connects subject and object entities', async () => {
    const ctx = await ctxWithFactChain();
    assertFact(ctx, { subject: 'Brasshold', predicate: 'funder', object: 'Quill Trust' });
    ctx.invalidateGraph();
    const g = ctx.graph();
    const s = g.entityKeyIndex.get('brasshold');
    const o = g.entityKeyIndex.get('quill trust');
    expect(s).toBeDefined();
    expect(o).toBeDefined();
    const neighbors = new Set<number>();
    for (let e = g.offsets[s!]!; e < g.offsets[s! + 1]!; e++) neighbors.add(g.neighbors[e]!);
    expect(neighbors.has(o!)).toBe(true);
    ctx.close();
  });

  it('a superseded relation loses its fact edge — the walk ranks the present', async () => {
    // The journal record block still co-mentions both names, so a weak
    // co-occurrence edge legitimately remains; what supersession removes is
    // the full-weight FACT edge. Assert the connection WEAKENS.
    const ctx = await ctxWithFactChain();
    const weightTo = (g: LoreGraph, a: number, b: number): number => {
      let w = 0;
      for (let e = g.offsets[a]!; e < g.offsets[a + 1]!; e++) {
        if (g.neighbors[e] === b) w += g.weights[e]!;
      }
      return w;
    };
    assertFact(ctx, { subject: 'Brasshold', predicate: 'funder', object: 'Quill Trust' });
    ctx.invalidateGraph();
    let g = ctx.graph();
    const before = weightTo(
      g,
      g.entityKeyIndex.get('brasshold')!,
      g.entityKeyIndex.get('quill trust')!,
    );
    assertFact(ctx, { subject: 'Brasshold', predicate: 'funder', object: 'Novel Sponsor' });
    ctx.invalidateGraph();
    g = ctx.graph();
    const after = weightTo(
      g,
      g.entityKeyIndex.get('brasshold')!,
      g.entityKeyIndex.get('quill trust')!,
    );
    expect(before).toBeGreaterThan(after); // FACT weight removed on supersede
    ctx.close();
  });

  it('the relation is traversable: searching the subject reaches the funder note', async () => {
    // quill-trust.md never mentions Brasshold; only the asserted fact links
    // them. The graph channel must carry the note into the results.
    const ctx = await ctxWithFactChain();
    assertFact(ctx, { subject: 'Brasshold', predicate: 'funder', object: 'Quill Trust' });
    ctx.invalidateGraph();
    const res = await search(ctx, 'Brasshold programme backing', { noLog: true });
    expect(res.map((r) => r.notePath)).toContain('quill-trust.md');
    ctx.close();
  });
});
