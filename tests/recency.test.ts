import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { openStore } from '../src/store/db.js';
import { indexVault } from '../src/index/indexer.js';
import { search } from '../src/retrieve/search.js';
import { ConfigSchema } from '../src/config.js';
import { buildGraph, type LoreGraph } from '../src/graph/build.js';
import { buildNoteLinkGraph } from '../src/retrieve/expand.js';
import type { LoreContext } from '../src/context.js';

/**
 * The recency cue answers "what is the status NOW". Its failure mode is
 * over-claiming: a boost derived only from a candidate pool's own spread says
 * "newest here" even when here is years stale, and says it at full strength
 * even when there is nothing to compare against.
 */
async function ctxFor(files: Record<string, string>, over: object = {}): Promise<LoreContext> {
  const root = await mkdtemp(join(tmpdir(), 'lw-rec-'));
  for (const [p, c] of Object.entries(files)) {
    await mkdir(dirname(join(root, p)), { recursive: true });
    await writeFile(join(root, p), c);
  }
  const config = ConfigSchema.parse(over);
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

const dated = (title: string, date: string, body: string) =>
  `---\ntitle: ${title}\ndate: ${date}\n---\n\n# ${title}\n\n${body}\n`;

describe('recency cue does not over-claim', () => {
  it('a lone stale dated block never outranks the undated page stating the status', async () => {
    // One dated candidate means there is nothing to prefer it OVER on the
    // recency axis — but min-max normalization scored it a flat 1.0, so a
    // 2019 journal took the full boost on the cue's own target phrasing and
    // beat the undated hub that holds the current answer.
    const ctx = await ctxFor({
      'zorvath.md': '# Zorvath Quenlar\n\nzorvath quenlar status: the pipeline is stalled pending review.\n',
      'journal/old.md': dated('Old notes', '2019-04-02', 'zorvath quenlar status discussion from the early days.'),
    });
    const plain = await search(ctx, 'zorvath quenlar status', { noLog: true });
    const cue = await search(ctx, 'current zorvath quenlar status', { noLog: true });
    expect(plain[0]!.notePath).toBe('zorvath.md');
    expect(cue[0]!.notePath, 'the cue must not flip top-1 to a stale block').toBe('zorvath.md');
    ctx.close();
  });

  it('with a real spread, the newest dated account still wins', async () => {
    // The feature itself must survive its own guard rails.
    const ctx = await ctxFor({
      'hub.md': '# Marrowlark\n\nThe marrowlark rig is documented across the journal.\n',
      'journal/a.md': dated('Early', '2021-03-02', 'marrowlark rig status: prototype on the bench.'),
      'journal/b.md': dated('Recent', '2026-06-18', 'marrowlark rig status: shipped to both field sites.'),
    });
    const res = await search(ctx, 'current marrowlark rig status', { noLog: true });
    expect(res[0]!.notePath).toBe('journal/b.md');
    ctx.close();
  });

  it('turning the temporal boost off never inverts a window the query names', async () => {
    // The cue keyed off the CONFIG-GATED window, so boosts.temporal=0 made a
    // windowed "current …" query prefer the newest block — disabling a
    // feature is meant to be neutral, not actively wrong.
    const files = {
      'log-2019.md': dated('Log 2019', '2019-03-05', 'breslin fenwick deploy attempt notes.'),
      'log-2026.md': dated('Log 2026', '2026-07-11', 'breslin fenwick deploy attempt notes.'),
    };
    const q = 'current breslin fenwick deploy status in 2019';
    for (const over of [{}, { retrieval: { boosts: { temporal: 0 } } }]) {
      const ctx = await ctxFor(files, over);
      const res = await search(ctx, q, { noLog: true });
      expect(res[0]!.notePath, `config ${JSON.stringify(over)}`).toBe('log-2019.md');
      ctx.close();
    }
  });
});
