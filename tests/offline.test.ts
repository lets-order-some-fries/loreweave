import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * "Zero configuration required and no network calls: out of the box it runs on
 * BM25 + graph."
 *
 * That is a promise about what a local-first tool does with a private vault,
 * and it is the kind that erodes one convenience at a time — a version check,
 * an update notice, a crash report. Both halves are checked: that nothing
 * reaches out on the default path, and that no file outside the opt-in
 * embedding client can.
 */
describe('offline by default', () => {
  it('makes no network call while indexing, searching, asserting, dreaming or exporting', async () => {
    const calls: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = ((...args: unknown[]) => {
      calls.push(String(args[0]));
      throw new Error('network call attempted');
    }) as typeof fetch;

    try {
      const { openStore } = await import('../src/store/db.js');
      const { indexVault } = await import('../src/index/indexer.js');
      const { search } = await import('../src/retrieve/search.js');
      const { dream } = await import('../src/dream/dream.js');
      const { assertFact, queryFacts, aggregateFacts } = await import('../src/facts/model.js');
      const { capture } = await import('../src/capture.js');
      const { markUsed, resolveBlockIds } = await import('../src/dynamics/usage.js');
      const { ConfigSchema } = await import('../src/config.js');
      const { buildGraph } = await import('../src/graph/build.js');
      const { buildNoteLinkGraph } = await import('../src/retrieve/expand.js');
      const { exportGraph } = await import('../src/cli/export.js');
      const { makeVault, FIXTURE_VAULT } = await import('./helpers.js');

      const root = await makeVault(FIXTURE_VAULT);
      const store = openStore(':memory:');
      await indexVault(store, root);
      const config = ConfigSchema.parse({});
      expect(config.embedding.provider).toBe('none'); // the default is offline

      let cached: ReturnType<typeof buildGraph> | null = null;
      let links: ReturnType<typeof buildNoteLinkGraph> | null = null;
      const ctx = {
        root, config, store, provider: null,
        graph: () => (cached ??= buildGraph(store, config)),
        noteLinks: () => (links ??= buildNoteLinkGraph(store)),
        invalidateGraph: () => { cached = null; links = null; },
        close: () => store.close(),
      };

      await search(ctx, 'riverbed protocol', { k: 5 });
      await search(ctx, 'who is amara osei', { k: 5 });
      assertFact(ctx, {
        subject: 'Atlas', predicate: 'status', object: 'shipped', validFrom: '2026-01-01',
      });
      queryFacts(store, { subject: 'Atlas' });
      aggregateFacts(store, { predicate: 'status' });
      capture(ctx, 'a captured thought');
      markUsed(store, resolveBlockIds(store, 'projects/riverbed.md'));
      await indexVault(store, root);
      dream(ctx, { apply: true });
      exportGraph(ctx, 'json');
      store.close();
    } finally {
      globalThis.fetch = realFetch;
    }

    expect(calls, `attempted: ${calls.join(', ')}`).toEqual([]);
  }, 60_000);

  it('only the embedding client can reach the network at all', () => {
    // A grep rather than a runtime check, so a path never exercised by a test
    // cannot hide one. The embedding client is opt-in and off by default.
    const ALLOWED = new Set(['embed/index.ts']);
    const offenders: string[] = [];
    const walk = (dir: string, rel: string) => {
      for (const name of readdirSync(dir)) {
        const abs = join(dir, name);
        const r = rel ? `${rel}/${name}` : name;
        if (statSync(abs).isDirectory()) walk(abs, r);
        else if (name.endsWith('.ts')) {
          const src = readFileSync(abs, 'utf8');
          if (/\bfetch\s*\(|node:https?\b|node:net\b|node:dns\b/.test(src) && !ALLOWED.has(r)) {
            offenders.push(r);
          }
        }
      }
    };
    walk(join(import.meta.dirname, '..', 'src'), '');
    expect(offenders).toEqual([]);
  });
});
