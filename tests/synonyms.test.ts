import { describe, expect, it } from 'vitest';
import { openStore } from '../src/store/db.js';
import { indexVault } from '../src/index/indexer.js';
import { search } from '../src/retrieve/search.js';
import { expandDeadTerms } from '../src/retrieve/synonyms.js';
import { ConfigSchema } from '../src/config.js';
import { buildGraph, type LoreGraph } from '../src/graph/build.js';
import { buildNoteLinkGraph } from '../src/retrieve/expand.js';
import type { LoreContext } from '../src/context.js';
import { makeVault } from './helpers.js';

/**
 * A question uses vocabulary ABOUT the vault, not from it: "benefactor" hits
 * zero notes while the vault says "funded by". The ring substitutes in-corpus
 * relation words for DEAD query terms only — the user's word wins whenever it
 * exists, and nothing the vault does not say can be injected.
 */
const VAULT = {
  'ridge-array.md':
    '# Ridge Array\n\nThe Ridge Array is our hilltop sensor cluster, funded by the [[Meridian Trust]].\n',
  'meridian-trust.md':
    '# Meridian Trust\n\nThe Meridian Trust makes small grants for field science.\n',
  'noise.md': '# Noise\n\nUnrelated commentary about calibration screws.\n',
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

describe('dead-term synonym rings', () => {
  it('expands a zero-hit relation word to its in-corpus ring-mates only', async () => {
    const ctx = await ctxFor();
    const exp = expandDeadTerms(ctx.store, ['ridge', 'benefactor']);
    // 'funded' occurs in the vault; 'sponsor' and 'patron' do not.
    expect(exp).toContain('funded');
    expect(exp).not.toContain('sponsor');
    expect(exp).not.toContain('patron');
    ctx.close();
  });

  it('a word that exists in the vault is never expanded — the user wins', async () => {
    const ctx = await ctxFor();
    expect(expandDeadTerms(ctx.store, ['funded'])).toEqual([]);
    expect(expandDeadTerms(ctx.store, ['calibration'])).toEqual([]);
    ctx.close();
  });

  it('the expansion reaches what the vault calls the same thing', async () => {
    // "Ridge Array benefactor": zero lexical hits for 'benefactor', but the
    // ring routes through 'funded' and the funder page surfaces.
    const ctx = await ctxFor();
    const res = await search(ctx, 'Ridge Array benefactor', { noLog: true });
    const paths = res.map((r) => r.notePath);
    expect(paths).toContain('ridge-array.md');
    expect(paths).toContain('meridian-trust.md');
    ctx.close();
  });

  it('unknown dead words expand to nothing rather than to noise', async () => {
    const ctx = await ctxFor();
    expect(expandDeadTerms(ctx.store, ['xylophage'])).toEqual([]);
    ctx.close();
  });
});
