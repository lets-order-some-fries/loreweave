import { describe, expect, it } from 'vitest';
import { openStore } from '../src/store/db.js';
import { indexVault } from '../src/index/indexer.js';
import { search } from '../src/retrieve/search.js';
import { ConfigSchema } from '../src/config.js';
import { buildGraph, type LoreGraph } from '../src/graph/build.js';
import { buildNoteLinkGraph } from '../src/retrieve/expand.js';
import type { LoreContext } from '../src/context.js';
import { makeVault } from './helpers.js';

/**
 * Recall-reached notes used to be ordered by raw PPR mass, which counts
 * texture — so a two-hop answer at the end of a link chain sat behind
 * one-hop co-occurrence bystanders. Path reliability (the relational-only
 * walk) orders that list by whether a CHAIN OF CLAIMS reaches the node.
 */
const VAULT = {
  'hub.md':
    '# Skerry Survey\n\nThe Skerry Survey coordinates the reef transects. Its work continues in [[Transect Plan]].\n',
  'mid.md':
    '# Transect Plan\n\nThe plan allocates dive windows, executed with the [[Coral Frame Rig]].\n',
  'far.md': '# Coral Frame Rig\n\nA quadrat frame used on every reef transect dive.\n',
  'bystander-a.md':
    '# Meeting scraps\n\nSkerry Survey came up beside the canteen rota and the parking question.\n',
  'bystander-b.md':
    '# More scraps\n\nSomeone mentioned Skerry Survey next to the printer saga again.\n',
};

async function ctxFor(): Promise<LoreContext> {
  const root = await makeVault(VAULT);
  const config = ConfigSchema.parse({ retrieval: { expansionHops: 2 } });
  const store = openStore(':memory:');
  await indexVault(store, root);
  let cached: LoreGraph | null = null;
  return {
    root,
    config,
    store,
    provider: null,
    graph: () => (cached ??= buildGraph(store, config)),
    noteLinks: () => buildNoteLinkGraph(store),
    invalidateGraph: () => (cached = null),
    close: () => store.close(),
  } as unknown as LoreContext;
}

describe('path-reliability ordering of recall-reached notes', () => {
  it('a two-hop chain-reached note is found, ordered behind its closer link', async () => {
    // "Skerry Survey equipment": 'equipment' is dead vocabulary; the rig is
    // two link-hops away and shares no words with the query. With
    // expansionHops=2 it must be FOUND (at the default single hop it was
    // not — the bug this test grew out of), and the closer chain note must
    // sit above the further one. Lexical hits outranking backfill is by
    // design and not contested here; the eval's multihop gate polices the
    // reliability ordering at corpus scale.
    const ctx = await ctxFor();
    const res = await search(ctx, 'Skerry Survey equipment', { noLog: true });
    const paths = res.map((r) => r.notePath);
    const mid = paths.indexOf('mid.md');
    const far = paths.indexOf('far.md');
    expect(far, 'two-hop note found at all').toBeGreaterThanOrEqual(0);
    expect(mid, 'one-hop note found').toBeGreaterThanOrEqual(0);
    expect(mid, 'closer chain note ranks above the further one').toBeLessThan(far);
    ctx.close();
  });
});
