import { describe, expect, it } from 'vitest';
import { openStore } from '../src/store/db.js';
import { indexVault } from '../src/index/indexer.js';
import { buildGraph } from '../src/graph/build.js';
import { ppr } from '../src/graph/ppr.js';
import { ConfigSchema } from '../src/config.js';
import { FIXTURE_VAULT, makeVault } from './helpers.js';

const config = ConfigSchema.parse({});

describe('graph + ppr', () => {
  it('builds a connected graph from the fixture vault', async () => {
    const root = await makeVault(FIXTURE_VAULT);
    const store = openStore(':memory:');
    await indexVault(store, root);
    const g = buildGraph(store, config);
    expect(g.blockCount).toBeGreaterThan(0);
    expect(g.entityCount).toBeGreaterThan(0);
    expect(g.offsets[g.n]).toBeGreaterThan(0); // has edges
    // entity node for amara osei exists
    expect(g.entityKeyIndex.has('amara osei')).toBe(true);
    store.close();
  });

  it('PPR from riverbed reaches glacier dataset through the bridge entity', async () => {
    const root = await makeVault(FIXTURE_VAULT);
    const store = openStore(':memory:');
    await indexVault(store, root);
    const g = buildGraph(store, config);

    const seedEntity = g.entityKeyIndex.get('riverbed protocol')!;
    const scores = ppr(g, new Map([[seedEntity, 1]]), { alpha: 0.5, iterations: 4 });

    // block scores per note
    const noteScore = new Map<string, number>();
    const rows = store.db.prepare(`SELECT id, note_path FROM blocks`).all() as {
      id: number;
      note_path: string;
    }[];
    for (const r of rows) {
      const idx = g.blockIndex.get(r.id);
      if (idx === undefined) continue;
      noteScore.set(r.note_path, (noteScore.get(r.note_path) ?? 0) + scores[idx]!);
    }
    const glacier = noteScore.get('data/glacier-dataset.md') ?? 0;
    const unrelated = noteScore.get('notes/unrelated.md') ?? 0;
    expect(glacier).toBeGreaterThan(0);
    expect(glacier).toBeGreaterThan(unrelated);
    store.close();
  });

  it('empty seeds → zero scores; empty graph safe', async () => {
    const store = openStore(':memory:');
    const g = buildGraph(store, config);
    const scores = ppr(g, new Map());
    expect(scores.length).toBe(0);
    store.close();
  });
});
