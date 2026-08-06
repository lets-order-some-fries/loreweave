import { describe, expect, it } from 'vitest';
import { openStore } from '../src/store/db.js';
import { indexVault } from '../src/index/indexer.js';
import { search } from '../src/retrieve/search.js';
import { ConfigSchema } from '../src/config.js';
import { buildGraph, type LoreGraph } from '../src/graph/build.js';
import { buildNoteLinkGraph } from '../src/retrieve/expand.js';
import type { LoreContext } from '../src/context.js';
import { makeVault } from './helpers.js';

const VAULT = {
  '2025-03-14-standup.md': '# Standup\n\nWe shipped the ledger migration.\n',
  'planning.md': '---\ntitle: Roadmap\ndate: 2026-07-01\n---\n\n# Roadmap\n\nLedger work is scheduled later.\n',
  'undated.md': '# Notes\n\nGeneral ledger commentary with no date at all.\n',
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
  };
}

describe('content time', () => {
  it('dates blocks from filename and frontmatter', async () => {
    const ctx = await ctxFor();
    const rows = ctx.store.db
      .prepare(`SELECT note_path, event_from FROM blocks ORDER BY note_path`)
      .all() as { note_path: string; event_from: string | null }[];
    const by = new Map(rows.map((r) => [r.note_path, r.event_from]));
    expect(by.get('2025-03-14-standup.md')).toBe('2025-03-14');
    expect(by.get('planning.md')).toBe('2026-07-01');
    expect(by.get('undated.md')).toBeNull();
    ctx.close();
  });

  it('filters on when content is ABOUT, not when the file was touched', async () => {
    const ctx = await ctxFor();
    // every file was written seconds ago, so an mtime filter could not
    // distinguish these at all
    const in2025 = await search(ctx, 'ledger', { since: '2025-01-01', until: '2025-12-31', noLog: true });
    expect(in2025.map((r) => r.notePath)).toContain('2025-03-14-standup.md');
    expect(in2025.map((r) => r.notePath)).not.toContain('planning.md');

    const in2026 = await search(ctx, 'ledger', { since: '2026-01-01', noLog: true });
    expect(in2026.map((r) => r.notePath)).toContain('planning.md');
    expect(in2026.map((r) => r.notePath)).not.toContain('2025-03-14-standup.md');
    ctx.close();
  });

  it('undated content falls back to file mtime rather than vanishing', async () => {
    const ctx = await ctxFor();
    const recent = await search(ctx, 'ledger', { since: '2020-01-01', noLog: true });
    expect(recent.map((r) => r.notePath)).toContain('undated.md');
    ctx.close();
  });
});
