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
 * Facets are membership, not emphasis: "only #decision notes under projects/"
 * must return nothing else, however well something else scores. This is the
 * scoping every competitor's issue tracker asks for (include-whitelists,
 * type filters) and the one thing a boost cannot express.
 */
const VAULT = {
  'projects/atlas-choice.md':
    '---\ntitle: Atlas choice\ntags: [decision]\n---\n\n# Atlas choice\n\nWe picked the falcon design for the atlas rollout.\n',
  'projects/atlas-notes.md':
    '---\ntitle: Atlas notes\ntags: [scratch]\n---\n\n# Atlas notes\n\nLoose falcon thoughts about the atlas rollout.\n',
  'archive/atlas-old.md':
    '---\ntitle: Atlas old\ntags: [decision, archive]\n---\n\n# Atlas old\n\nThe falcon design we abandoned for the atlas rollout.\n',
  'journal/atlas-diary.md':
    '# Atlas diary\n\nMore falcon musings on the atlas rollout, tagged inline #scratch.\n',
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

describe('search facets', () => {
  it('a tag facet is membership: only tagged notes come back', async () => {
    const ctx = await ctxFor();
    const paths = (await search(ctx, 'falcon atlas', { tags: ['decision'], noLog: true })).map(
      (r) => r.notePath,
    );
    expect(paths.length).toBeGreaterThan(0);
    expect(paths.every((p) => ['projects/atlas-choice.md', 'archive/atlas-old.md'].includes(p))).toBe(
      true,
    );
    ctx.close();
  });

  it('a -tag excludes; # prefix and case are forgiven', async () => {
    const ctx = await ctxFor();
    const paths = (
      await search(ctx, 'falcon atlas', { tags: ['#Decision', '-archive'], noLog: true })
    ).map((r) => r.notePath);
    expect(paths).toEqual(['projects/atlas-choice.md']);
    ctx.close();
  });

  it('a folder facet scopes by path prefix, trailing slash or not', async () => {
    const ctx = await ctxFor();
    for (const folder of ['projects', 'projects/']) {
      const paths = (await search(ctx, 'falcon atlas', { folder, noLog: true })).map(
        (r) => r.notePath,
      );
      expect(paths.length).toBeGreaterThan(0);
      expect(paths.every((p) => p.startsWith('projects/'))).toBe(true);
    }
    ctx.close();
  });

  it('inline #tags count as tags, same as frontmatter', async () => {
    const ctx = await ctxFor();
    const paths = (await search(ctx, 'falcon atlas', { tags: ['scratch'], noLog: true })).map(
      (r) => r.notePath,
    );
    expect(paths).toContain('journal/atlas-diary.md');
    expect(paths).toContain('projects/atlas-notes.md');
    expect(paths).not.toContain('projects/atlas-choice.md');
    ctx.close();
  });

  it('facets compose, and an over-constrained scope returns empty, not noise', async () => {
    const ctx = await ctxFor();
    const both = (
      await search(ctx, 'falcon atlas', { tags: ['decision'], folder: 'projects/', noLog: true })
    ).map((r) => r.notePath);
    expect(both).toEqual(['projects/atlas-choice.md']);
    const none = await search(ctx, 'falcon atlas', {
      tags: ['decision'],
      folder: 'journal/',
      noLog: true,
    });
    expect(none).toEqual([]);
    ctx.close();
  });
});
