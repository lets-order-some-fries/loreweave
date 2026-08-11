import { describe, expect, it } from 'vitest';
import { openStore } from '../src/store/db.js';
import { indexVault } from '../src/index/indexer.js';
import { search, proximityScore } from '../src/retrieve/search.js';
import { ConfigSchema } from '../src/config.js';
import { buildGraph, type LoreGraph } from '../src/graph/build.js';
import { buildNoteLinkGraph } from '../src/retrieve/expand.js';
import type { LoreContext } from '../src/context.js';
import { makeVault } from './helpers.js';

/**
 * Coverage counts words; proximity counts ORDER. "ledger migration" as a
 * phrase and the same two words a paragraph apart are different strengths of
 * evidence, and the sequential-dependence literature has priced that into
 * every strong lexical ranker since Metzler & Croft (2005).
 */
describe('proximityScore', () => {
  it('full phrase 1, scattered 0, partial in between, single term nothing', () => {
    expect(proximityScore('the ledger migration shipped', ['ledger', 'migration'])).toBe(1);
    expect(proximityScore('a ledger, and later a migration', ['ledger', 'migration'])).toBe(0);
    expect(
      proximityScore('queue design review went long', ['queue', 'design', 'review']),
    ).toBe(1);
    expect(
      proximityScore('the design queue needs review', ['queue', 'design', 'review']),
    ).toBe(0);
    expect(proximityScore('half queue design here', ['queue', 'design', 'other'])).toBe(0.5);
    expect(proximityScore('anything at all', ['anything'])).toBe(0);
  });
});

const VAULT = {
  'phrase.md':
    '# Rollout log\n\nThe ledger migration finished cleanly on the second attempt.\n',
  'scattered.md':
    '# Rollout notes\n\nThe ledger was archived. A migration of the remaining data finished later.\n',
};

async function ctxFor(): Promise<LoreContext> {
  const root = await makeVault(VAULT);
  const config = ConfigSchema.parse({});
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

describe('proximity in ranking', () => {
  it('the note preserving the query phrasing outranks the scattered one', async () => {
    // Both notes contain both words — coverage ties them. Order decides.
    const ctx = await ctxFor();
    const res = await search(ctx, 'ledger migration', { noLog: true });
    expect(res[0]!.notePath).toBe('phrase.md');
    expect(res.map((r) => r.notePath)).toContain('scattered.md'); // still found
    ctx.close();
  });
});
