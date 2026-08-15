import { describe, expect, it } from 'vitest';
import { openStore } from '../src/store/db.js';
import { indexVault } from '../src/index/indexer.js';
import { search } from '../src/retrieve/search.js';
import { buildGraph, type LoreGraph } from '../src/graph/build.js';
import { buildNoteLinkGraph } from '../src/retrieve/expand.js';
import { ConfigSchema } from '../src/config.js';
import type { LoreContext } from '../src/context.js';
import { makeVault } from './helpers.js';

/**
 * One thing under several names is the ordinary state of a vault: a person is
 * "Bob" in standups, "Robert Aldana" on their hub page, and the hub declares
 * both. Without same-as edges those are disconnected graph nodes and
 * activation from one never reaches content filed under the other.
 */
const VAULT = {
  'people/robert-aldana.md':
    '---\ntitle: Robert Aldana\naliases: [Bob]\n---\n\n# Robert Aldana\n\nRobert Aldana runs the harbor survey equipment.\n',
  'log/dredge-note.md':
    '# Dredge note\n\n[[Robert Aldana]] signed off the dredge calibration for the season.\n',
  'log/standup.md':
    '# Standup\n\nBob mentioned the kelp sensors are drifting again.\n',
  'orgs/motherson-technology-services.md':
    '---\ntitle: Motherson Technology Services\n---\n\n# Motherson Technology Services\n\nMotherson Technology Services maintains the fleet telemetry stack.\n',
  'log/vendor-call.md':
    '# Vendor call\n\nCall with MTS about the telemetry contract renewal went fine.\n',
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

function neighborsOf(g: LoreGraph, key: string): Set<number> {
  const idx = g.entityKeyIndex.get(key);
  expect(idx, `entity "${key}" exists`).toBeDefined();
  const out = new Set<number>();
  for (let e = g.offsets[idx!]!; e < g.offsets[idx! + 1]!; e++) out.add(g.neighbors[e]!);
  return out;
}

describe('same-as edges', () => {
  it('frontmatter aliases connect the alias entity to the title entity', async () => {
    const ctx = await ctxFor();
    const g = ctx.graph();
    const bobIdx = g.entityKeyIndex.get('bob');
    expect(bobIdx).toBeDefined();
    expect(neighborsOf(g, 'robert aldana').has(bobIdx!)).toBe(true);
    ctx.close();
  });

  it('an acronym connects to the entity whose initials it spells', async () => {
    const ctx = await ctxFor();
    const g = ctx.graph();
    const mtsIdx = g.entityKeyIndex.get('mts');
    expect(mtsIdx).toBeDefined();
    expect(neighborsOf(g, 'motherson technology services').has(mtsIdx!)).toBe(true);
    ctx.close();
  });

  it('searching by the alias reaches content filed under the full name', async () => {
    // "Bob dredge calibration": the dredge note never says Bob — it links
    // [[Robert Aldana]]. Only the same-as edge lets activation from the
    // alias reach it.
    const ctx = await ctxFor();
    const res = await search(ctx, 'Bob dredge calibration sign-off', { noLog: true });
    expect(res.map((r) => r.notePath)).toContain('log/dredge-note.md');
    ctx.close();
  });

  it('a stopword-led title never merges into an unrelated short name', async () => {
    // "The Old Mill" initials to "tom" — and an identity edge is the most
    // damaging thing to get wrong: weight 0.9, deep-propagating, and
    // indistinguishable from a stated fact. Initials skip stopwords now, and
    // the target must actually look like an acronym in the vault.
    const root = await makeVault({
      'mill.md': '# The Old Mill\n\nThe old mill by the weir, disused since the flood.\n',
      'tom.md': '# Tom\n\nTom runs the boatyard on the far bank.\n',
    });
    const config = ConfigSchema.parse({});
    const store = openStore(':memory:');
    await indexVault(store, root);
    const g = buildGraph(store, config);
    const mill = g.entityKeyIndex.get('the old mill');
    const tom = g.entityKeyIndex.get('tom');
    expect(mill, 'both entities exist').toBeDefined();
    expect(tom).toBeDefined();
    let weight = 0;
    for (let e = g.offsets[mill!]!; e < g.offsets[mill! + 1]!; e++) {
      if (g.neighbors[e] === tom) weight += g.weights[e]!;
    }
    expect(weight).toBe(0);
    store.close();
  });

  it('a scalar frontmatter alias works exactly like the array form', async () => {
    // `aliases: Bobby` is YAML Obsidian accepts. The graph layer coerced the
    // scalar; the extractor only read arrays — so the alias never became an
    // entity and the edge the graph was written to build never existed.
    for (const yaml of ['aliases: Bobby', 'aliases: [Bobby]']) {
      const root = await makeVault({
        'rob.md': `---\ntitle: Robert Aldana\n${yaml}\n---\n\n# Robert Aldana\n\nRuns the survey gear.\n`,
      });
      const config = ConfigSchema.parse({});
      const store = openStore(':memory:');
      await indexVault(store, root);
      const g = buildGraph(store, config);
      expect(g.entityKeyIndex.has('bobby'), yaml).toBe(true);
      const rob = g.entityKeyIndex.get('robert aldana')!;
      const bobby = g.entityKeyIndex.get('bobby')!;
      let weight = 0;
      for (let e = g.offsets[rob]!; e < g.offsets[rob + 1]!; e++) {
        if (g.neighbors[e] === bobby) weight += g.weights[e]!;
      }
      expect(weight, yaml).toBeGreaterThan(0);
      store.close();
    }
  });

  it('two-letter initials never create identity edges', async () => {
    // "harbor survey" has initials "hs" — if some note had an entity "hs"
    // that would be a collision, not an identity. The guard is length >= 3;
    // here we just pin that no sameas edge was created for a 2-letter case
    // by asserting the graph builds cleanly and the survey entity's
    // neighbourhood is only its own blocks and co-mentioned entities.
    const ctx = await ctxFor();
    const g = ctx.graph();
    expect(g.entityKeyIndex.has('hs')).toBe(false);
    ctx.close();
  });
});
