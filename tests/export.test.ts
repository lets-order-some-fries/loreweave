import { describe, expect, it } from 'vitest';
import { openStore } from '../src/store/db.js';
import { indexVault } from '../src/index/indexer.js';
import { exportGraph } from '../src/cli/export.js';
import { ConfigSchema } from '../src/config.js';
import { buildGraph, type LoreGraph } from '../src/graph/build.js';
import { buildNoteLinkGraph, type NoteLinkGraph } from '../src/retrieve/expand.js';
import type { LoreContext } from '../src/context.js';
import { FIXTURE_VAULT, makeVault } from './helpers.js';

async function ctxWith(files: Record<string, string>): Promise<LoreContext> {
  const root = await makeVault(files);
  const config = ConfigSchema.parse({});
  const store = openStore(':memory:');
  await indexVault(store, root);
  let cached: LoreGraph | null = null;
  let links: NoteLinkGraph | null = null;
  return {
    root, config, store, provider: null,
    graph: () => (cached ??= buildGraph(store, config)),
    noteLinks: () => (links ??= buildNoteLinkGraph(store)),
    invalidateGraph: () => { cached = null; },
    close: () => store.close(),
  };
}

describe('graph export', () => {
  it('contains the links between notes', async () => {
    // It carried only note→entity mentions, so a vault's explicit wiki links —
    // the structure the whole design leans on — appeared nowhere, and opening
    // the file in a graph tool showed no connections between notes unless two
    // happened to share an entity.
    const ctx = await ctxWith(FIXTURE_VAULT);
    const g = JSON.parse(exportGraph(ctx, 'json')) as {
      nodes: { id: string }[];
      edges: { source: string; target: string; type: string }[];
      meta: { notes: number; entities: number; entitiesShown: number };
    };
    const links = g.edges.filter((e) => e.type === 'links');
    expect(links.length).toBeGreaterThan(0);
    expect(links).toContainEqual(
      expect.objectContaining({
        source: 'note:projects/riverbed.md',
        target: 'note:people/amara-osei.md',
      }),
    );
    ctx.close();
  });

  it('says what it left out', async () => {
    // Entities used once are dropped to keep a picture readable. Reported,
    // not silent: a viewer showing 3 of 13 entities without saying so reads as
    // the whole vault.
    const ctx = await ctxWith(FIXTURE_VAULT);
    const g = JSON.parse(exportGraph(ctx, 'json')) as {
      meta: { entities: number; entitiesShown: number; minEntityUses: number };
    };
    expect(g.meta.entities).toBeGreaterThan(g.meta.entitiesShown);
    expect(g.meta.minEntityUses).toBe(2);
    ctx.close();
  });

  it('every edge endpoint exists as a node', async () => {
    const ctx = await ctxWith(FIXTURE_VAULT);
    const g = JSON.parse(exportGraph(ctx, 'json')) as {
      nodes: { id: string }[];
      edges: { source: string; target: string }[];
    };
    const ids = new Set(g.nodes.map((n) => n.id));
    for (const e of g.edges) {
      expect(ids.has(e.source), `source ${e.source}`).toBe(true);
      expect(ids.has(e.target), `target ${e.target}`).toBe(true);
    }
    expect(g.nodes.length).toBe(ids.size); // no duplicate ids
    ctx.close();
  });

  it('an ambiguous link points at the same note the search would', async () => {
    const ctx = await ctxWith({
      'projects/atlas/overview.md': '---\ntitle: Overview\n---\n\n# Overview\n\nAtlas body.\n',
      'projects/northwind/overview.md': '---\ntitle: Overview\n---\n\n# Overview\n\nNorthwind body.\n',
      'projects/atlas/plan.md': '# Atlas Plan\n\nSee [[Overview]].\n',
    });
    const g = JSON.parse(exportGraph(ctx, 'json')) as {
      edges: { source: string; target: string; type: string }[];
    };
    expect(g.edges.filter((e) => e.type === 'links')).toContainEqual(
      expect.objectContaining({
        source: 'note:projects/atlas/plan.md',
        target: 'note:projects/atlas/overview.md',
      }),
    );
    ctx.close();
  });

  it('dot and graphml stay well formed', async () => {
    const ctx = await ctxWith(FIXTURE_VAULT);
    expect(exportGraph(ctx, 'dot').startsWith('graph lore {')).toBe(true);
    const gml = exportGraph(ctx, 'graphml');
    expect(gml).toContain('<graphml');
    expect(gml).toContain('</graphml>');
    ctx.close();
  });
});
