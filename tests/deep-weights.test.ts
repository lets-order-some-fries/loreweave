import { describe, expect, it } from 'vitest';
import { openStore } from '../src/store/db.js';
import { indexVault } from '../src/index/indexer.js';
import { buildGraph, type LoreGraph } from '../src/graph/build.js';
import { ppr } from '../src/graph/ppr.js';
import { ConfigSchema } from '../src/config.js';
import { makeVault } from './helpers.js';

/**
 * Past the first hop, only relational evidence propagates: links, facts,
 * identity, mentions. Co-occurrence is neighborhood texture — two names in
 * the same paragraph — and compounding texture across hops is how a walk
 * drowns a two-hop answer under a one-hop wall.
 */
const VAULT = {
  'linked.md': '# Linked\n\nThe survey report cites [[Anchor Topic]] directly.\n',
  'anchor.md': '# Anchor Topic\n\nThe anchor topic hub page.\n',
  'texture.md':
    '# Texture\n\nGull Ridge and Fern Hollow appeared in the same sentence once.\n',
};

function edgeWeights(
  g: LoreGraph,
  aKey: string,
  bKey: string,
): { full: number; deep: number } | null {
  const a = g.entityKeyIndex.get(aKey);
  const b = g.entityKeyIndex.get(bKey);
  if (a === undefined || b === undefined) return null;
  let full = 0;
  let deep = 0;
  for (let e = g.offsets[a]!; e < g.offsets[a + 1]!; e++) {
    if (g.neighbors[e] === b) {
      full += g.weights[e]!;
      deep += g.weightsDeep[e]!;
    }
  }
  return { full, deep };
}

describe('deep propagation weights', () => {
  it('co-occurrence carries no weight past hop 1; the full weight remains at hop 1', async () => {
    const root = await makeVault(VAULT);
    const store = openStore(':memory:');
    await indexVault(store, root);
    const g = buildGraph(store, ConfigSchema.parse({}));
    const pair = edgeWeights(g, 'gull ridge', 'fern hollow');
    expect(pair).not.toBeNull();
    expect(pair!.full).toBeGreaterThan(0); // texture still counts at hop 1
    expect(pair!.deep).toBe(0); // …and stops there
    store.close();
  });

  it('a persisted SIMILAR edge relays at hop 1 and stops there, by measurement', async () => {
    // This asserts a DELIBERATE limit, not an accident. An audit flagged that
    // a SIMILAR-only block scores 0 in the final vector, and 0.29.0 "fixed"
    // it with a half share at depth — on reasoning alone, because the eval
    // could not run embeddings then. When it could, deep=0 won on all three
    // corpora (kestrel MRR 0.539 vs 0.533, northwind 0.604 vs 0.570):
    // similarity is a statement about two blocks, not a chain of claims, and
    // compounding it across hops costs more precision than it buys.
    const root = await makeVault({
      'seed.md': '# Thornwick Gauge\n\nThe thornwick gauge measures stack drift.\n',
      'far.md': '# Unrelated\n\nCompletely different vocabulary about kettles.\n',
    });
    const config = ConfigSchema.parse({});
    const store = openStore(':memory:');
    await indexVault(store, root);
    const rows = store.db
      .prepare(`SELECT id, note_path FROM blocks ORDER BY note_path`)
      .all() as { id: number; note_path: string }[];
    const far = rows.find((r) => r.note_path === 'far.md')!;
    const seed = rows.find((r) => r.note_path === 'seed.md')!;
    store.db
      .prepare(
        `INSERT INTO edges(src_type, src_id, dst_type, dst_id, type, weight)
         VALUES ('block',?,'block',?,'SIMILAR',?)`,
      )
      .run(seed.id, far.id, 0.95);
    const g = buildGraph(store, config);
    const scores = ppr(g, new Map([[g.blockIndex.get(seed.id)!, 1]]), {
      alpha: config.retrieval.pprAlpha,
      iterations: config.retrieval.pprIterations,
    });
    expect(scores[g.blockIndex.get(far.id)!]!).toBe(0);
    // …and the edge is genuinely there at full weight for hop 1.
    let hop1 = 0;
    const s0 = g.blockIndex.get(seed.id)!;
    for (let e = g.offsets[s0]!; e < g.offsets[s0 + 1]!; e++) {
      if (g.neighbors[e] === g.blockIndex.get(far.id)!) hop1 += g.weights[e]!;
    }
    expect(hop1).toBeGreaterThan(0);
    store.close();
  });

  it('a wiki-link keeps its full weight at depth', async () => {
    const root = await makeVault(VAULT);
    const store = openStore(':memory:');
    await indexVault(store, root);
    const g = buildGraph(store, ConfigSchema.parse({}));
    // block ↔ entity LINK edge: find the linked block's edge to the target
    const target = g.entityKeyIndex.get('anchor topic')!;
    let linkDeep = 0;
    for (let e = g.offsets[target]!; e < g.offsets[target + 1]!; e++) {
      linkDeep += g.weightsDeep[e]!;
    }
    expect(linkDeep).toBeGreaterThan(0);
    store.close();
  });
});
