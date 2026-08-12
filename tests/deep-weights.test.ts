import { describe, expect, it } from 'vitest';
import { openStore } from '../src/store/db.js';
import { indexVault } from '../src/index/indexer.js';
import { buildGraph, type LoreGraph } from '../src/graph/build.js';
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
