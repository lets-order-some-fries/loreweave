import { describe, expect, it } from 'vitest';
import { openStore } from '../src/store/db.js';
import { indexVault } from '../src/index/indexer.js';
import { search } from '../src/retrieve/search.js';
import { ConfigSchema } from '../src/config.js';
import { buildGraph, type LoreGraph } from '../src/graph/build.js';
import { buildNoteLinkGraph, type NoteLinkGraph } from '../src/retrieve/expand.js';
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

  it('rejects a malformed window instead of silently returning nothing', async () => {
    // `to < 'garbage'` is a string comparison that drops or keeps rows by ASCII
    // accident, so `lore search --since not-a-date` used to answer "no results"
    // as if the vault were empty. A bad date must be a hard error, like the
    // fact store's own date arguments.
    const ctx = await ctxFor();
    await expect(search(ctx, 'ledger', { since: 'not-a-date', noLog: true })).rejects.toThrow(
      /since must be an ISO date/,
    );
    await expect(search(ctx, 'ledger', { until: '2026/01/01', noLog: true })).rejects.toThrow(
      /until must be an ISO date/,
    );
    ctx.close();
  });
});

describe('content time comes from the block, not just the frontmatter', () => {
  it('a --since/--until window keeps a block whose prose dates the event', async () => {
    // extractDates checks frontmatter first and returns on the first hit, so
    // passing the note frontmatter stamped EVERY block with the one frontmatter
    // date and ignored the dates in the block prose — a date-window search for
    // an event dated in the text then dropped the very block that mentions it.
    const root = await makeVault({
      'timeline.md':
        '---\ndate: 2020-01-01\n---\n\n# Launch\n\n' +
        'The zephyr launch event happened on 2026-08-05 with production traffic.\n',
    });
    const store = openStore(':memory:');
    await indexVault(store, root);
    const block = store.db
      .prepare(`SELECT event_from FROM blocks WHERE note_path='timeline.md' AND heading LIKE '%Launch%'`)
      .get() as { event_from: string };
    expect(block.event_from).toBe('2026-08-05'); // prose date, not 2020-01-01

    const config = ConfigSchema.parse({});
    let cached: LoreGraph | null = null;
    let links: NoteLinkGraph | null = null;
    const ctx: LoreContext = {
      root, config, store, provider: null,
      graph: () => (cached ??= buildGraph(store, config)),
      noteLinks: () => (links ??= buildNoteLinkGraph(store)),
      invalidateGraph: () => { cached = null; links = null; },
      close: () => store.close(),
    };
    const windowed = await search(ctx, 'zephyr launch event production traffic', {
      since: '2026-08-01', until: '2026-08-31', noLog: true,
    });
    expect(windowed.some((h) => h.notePath === 'timeline.md')).toBe(true);
    store.close();
  });

  it('a block with no prose date still inherits the frontmatter date', async () => {
    const root = await makeVault({
      'note.md': '---\ndate: 2024-03-10\n---\n\n# Body\n\nNo dates written in this prose at all.\n',
    });
    const store = openStore(':memory:');
    await indexVault(store, root);
    const block = store.db
      .prepare(`SELECT event_from FROM blocks WHERE note_path='note.md' AND heading LIKE '%Body%'`)
      .get() as { event_from: string };
    expect(block.event_from).toBe('2024-03-10'); // fallback still works
    store.close();
  });
});
