import { describe, expect, it } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../src/store/db.js';
import { indexVault } from '../src/index/indexer.js';
import { assertFact } from '../src/facts/model.js';
import { buildTimeline } from '../src/temporal/timeline.js';
import { ConfigSchema } from '../src/config.js';
import type { LoreContext } from '../src/context.js';

/**
 * `timeline` answers "what happened to X" in one call by merging the two
 * histories the engine keeps separately: the fact store's supersede chains
 * (computed) and content-dated prose mentions (narrated). Before it, that
 * answer took `facts --history` plus repeated windowed searches, merged by
 * hand — and the systems that market this exact query pay an LLM at
 * ingestion for the change graph the supersede chain already holds.
 */
async function ctxWithHistory(): Promise<LoreContext> {
  const root = await mkdtemp(join(tmpdir(), 'lw-tl-'));
  await writeFile(
    join(root, 'atlas-kickoff.md'),
    '---\ntitle: Atlas kickoff\ndate: 2024-02-10\n---\n\n# Atlas kickoff\n\n[[Project Atlas]] kicked off with a three-person crew.\n',
  );
  await writeFile(
    join(root, 'atlas-review.md'),
    '---\ntitle: Atlas review\ndate: 2025-06-20\n---\n\n# Atlas review\n\nThe [[Project Atlas]] midpoint review went long but well.\n',
  );
  await writeFile(join(root, 'unrelated.md'), '# Unrelated\n\nNothing about the project here.\n');
  const store = openStore(':memory:');
  await indexVault(store, root);
  const ctx = {
    root,
    config: ConfigSchema.parse({}),
    store,
    provider: null,
    graph: () => {
      throw new Error('unused');
    },
    noteLinks: () => {
      throw new Error('unused');
    },
    invalidateGraph: () => {},
    close: () => store.close(),
  } as unknown as LoreContext;
  assertFact(ctx, {
    subject: 'Project Atlas',
    predicate: 'status',
    object: 'planning',
    validFrom: '2024-01-15',
  });
  assertFact(ctx, {
    subject: 'Project Atlas',
    predicate: 'status',
    object: 'active',
    validFrom: '2024-09-01',
  });
  assertFact(ctx, {
    subject: 'Project Atlas',
    predicate: 'lead',
    object: 'Rhea Malhotra',
    validFrom: '2024-01-15',
  });
  return ctx;
}

describe('timeline', () => {
  it('merges fact change-points and dated mentions chronologically', async () => {
    const ctx = await ctxWithHistory();
    const tl = buildTimeline(ctx.store, 'Project Atlas');
    const dates = tl.map((e) => e.date);
    expect([...dates].sort()).toEqual(dates); // chronological
    const kinds = tl.map((e) => `${e.kind}:${e.date}`);
    expect(kinds).toContain('change:2024-01-15'); // planning starts
    expect(kinds).toContain('mention:2024-02-10'); // kickoff prose
    expect(kinds).toContain('change:2024-09-01'); // status flips
    expect(kinds).toContain('mention:2025-06-20'); // review prose
    ctx.close();
  });

  it('a superseding change names the value it replaced', async () => {
    const ctx = await ctxWithHistory();
    const tl = buildTimeline(ctx.store, 'Project Atlas');
    const flip = tl.find((e) => e.kind === 'change' && e.value === 'active');
    expect(flip?.previous).toBe('planning');
    expect(flip?.until).toBeNull(); // still current
    const first = tl.find((e) => e.kind === 'change' && e.value === 'planning');
    expect(first?.until).toBe('2024-09-01'); // closed by the supersede
    ctx.close();
  });

  it('honours a window and rejects a malformed one', async () => {
    const ctx = await ctxWithHistory();
    const only2024 = buildTimeline(ctx.store, 'Project Atlas', {
      since: '2024-01-01',
      until: '2024-12-31',
    });
    expect(only2024.every((e) => e.date.startsWith('2024'))).toBe(true);
    expect(only2024.some((e) => e.kind === 'mention')).toBe(true);
    expect(() => buildTimeline(ctx.store, 'Project Atlas', { since: 'garbage' })).toThrow(
      /ISO date/,
    );
    ctx.close();
  });

  it('an unknown subject yields an empty timeline, not an error', async () => {
    const ctx = await ctxWithHistory();
    expect(buildTimeline(ctx.store, 'Nonexistent Thing')).toEqual([]);
    ctx.close();
  });

  it('journal record blocks are not echoed as mentions', async () => {
    // assertFact writes `- [fact] …` journal lines that index like any block,
    // and their prose dates place them exactly beside the change entry they
    // produced — narrating every change twice. The change entry is the
    // history; the record block is how it was written down.
    const ctx = await ctxWithHistory();
    const tl = buildTimeline(ctx.store, 'Project Atlas');
    const mentions = tl.filter((e) => e.kind === 'mention');
    expect(mentions.length).toBeGreaterThan(0);
    for (const m of mentions) {
      expect(m.text).not.toMatch(/^\s*[-*+]\s*\[fact\]/im);
    }
    ctx.close();
  });

  it('mentions come back verbatim — prose is never rewritten', async () => {
    const ctx = await ctxWithHistory();
    const tl = buildTimeline(ctx.store, 'Project Atlas');
    const kickoff = tl.find((e) => e.kind === 'mention' && e.date === '2024-02-10');
    expect(kickoff?.text).toContain('kicked off with a three-person crew');
    expect(kickoff?.notePath).toBe('atlas-kickoff.md');
    ctx.close();
  });
});
