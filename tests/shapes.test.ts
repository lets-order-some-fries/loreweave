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
 * Every note shape must be findable by a word it contains.
 *
 * The failure mode this guards against is silent: the note indexes without
 * error, `stats` counts it, and every search returns nothing. Two real bugs
 * had exactly this signature — notes that were only headings, and notes that
 * were only frontmatter — and neither was visible to a recall metric.
 */
const SHAPES: Record<string, { content: string; find: string }> = {
  'code-only.md': { content: '```python\ndef zephyrine_handler():\n    return 42\n```\n', find: 'zephyrine' },
  'table-only.md': { content: '| Name | Role |\n|---|---|\n| Quokka | keeper |\n', find: 'Quokka' },
  'list-only.md': { content: '- alpha bandicoot\n- beta bandicoot\n', find: 'bandicoot' },
  'frontmatter-only.md': { content: '---\ntitle: Marmoset Index\nstatus: active\n---\n', find: 'Marmoset' },
  'heading-only.md': { content: '# Pangolin Registry\n', find: 'Pangolin' },
  'moc.md': { content: '# Index\n\n## Aardvark\n\n## Numbat\n', find: 'Numbat' },
  'image-only.md': { content: '![diagram](./pelican-flow.png)\n', find: 'pelican' },
  'one-word.md': { content: 'Capybara\n', find: 'Capybara' },
  'crlf.md': { content: '# Windows\r\n\r\nThe wombat protocol uses CRLF.\r\n', find: 'wombat' },
  'bom.md': { content: '﻿# BOM\n\nThe axolotl subsystem has a byte order mark.\n', find: 'axolotl' },
  'no-newline.md': { content: '# Terse\n\nThe okapi record has no trailing newline.', find: 'okapi' },
  'quote-only.md': { content: '> The lemur principle states that everything cascades.\n', find: 'lemur' },
};

async function ctx(): Promise<LoreContext> {
  const files = Object.fromEntries(Object.entries(SHAPES).map(([k, v]) => [k, v.content]));
  const root = await makeVault(files);
  const config = ConfigSchema.parse({});
  const store = openStore(':memory:');
  await indexVault(store, root);
  let cached: LoreGraph | null = null;
  return {
    root, config, store, provider: null,
    graph: () => (cached ??= buildGraph(store, config)),
    noteLinks: () => buildNoteLinkGraph(store),
    invalidateGraph: () => (cached = null),
    close: () => store.close(),
  };
}

describe('every note shape is findable', () => {
  it('produces at least one block per note', async () => {
    const c = await ctx();
    const rows = c.store.db
      .prepare('SELECT note_path, COUNT(*) n FROM blocks GROUP BY note_path')
      .all() as { note_path: string; n: number }[];
    const counted = new Set(rows.map((r) => r.note_path));
    for (const name of Object.keys(SHAPES)) expect(counted).toContain(name);
    c.close();
  });

  for (const [name, { find }] of Object.entries(SHAPES)) {
    it(`finds ${name} by searching "${find}"`, async () => {
      const c = await ctx();
      const hits = await search(c, find, { k: 5, noLog: true });
      expect(hits.map((h) => h.notePath)).toContain(name);
      c.close();
    });
  }

  it('frontmatter values are searchable, not just the title', async () => {
    const c = await ctx();
    const hits = await search(c, 'active', { k: 5, noLog: true });
    expect(hits.map((h) => h.notePath)).toContain('frontmatter-only.md');
    c.close();
  });
});
