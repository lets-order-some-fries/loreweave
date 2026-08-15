import { describe, expect, it } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../src/store/db.js';
import { indexVault } from '../src/index/indexer.js';
import { assertFact } from '../src/facts/model.js';
import { resumeDelta } from '../src/resume.js';
import { ConfigSchema } from '../src/config.js';
import type { LoreContext } from '../src/context.js';

/**
 * `resume` is session continuity as a QUERY: the delta since the last
 * implicit call, computed from record time. The popular alternative runs an
 * LLM over the previous session and injects a paraphrase; this is the same
 * continuity, reproducible — one watermark, one answer.
 */
async function freshCtx(): Promise<LoreContext> {
  const root = await mkdtemp(join(tmpdir(), 'lw-rs-'));
  await writeFile(join(root, 'a.md'), '# Alpha\n\nSeed note about the atlas.\n');
  const store = openStore(':memory:');
  await indexVault(store, root);
  return {
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
}

describe('resume', () => {
  it('reports notes changed and facts asserted since an explicit watermark', async () => {
    const ctx = await freshCtx();
    assertFact(ctx, { subject: 'Atlas', predicate: 'status', object: 'active' });
    const d = resumeDelta(ctx.store, { since: '2020-01-01' });
    expect(d.notesChanged.map((n) => n.path)).toContain('a.md');
    expect(d.factsAsserted.some((f) => f.includes('Atlas :: status :: active'))).toBe(true);
    ctx.close();
  });

  it('a supersession reads as the change it is, old → new', async () => {
    const ctx = await freshCtx();
    assertFact(ctx, { subject: 'Atlas', predicate: 'status', object: 'planning' });
    assertFact(ctx, { subject: 'Atlas', predicate: 'status', object: 'active' });
    const d = resumeDelta(ctx.store, { since: '2020-01-01' });
    expect(d.factsSuperseded).toContainEqual({
      slot: 'Atlas :: status',
      old: 'planning',
      new: 'active',
    });
    ctx.close();
  });

  it('the implicit call advances the watermark; an explicit since never does', async () => {
    const ctx = await freshCtx();
    assertFact(ctx, { subject: 'Atlas', predicate: 'status', object: 'active' });
    const first = resumeDelta(ctx.store); // implicit: consumes the delta
    expect(first.counts.factsAsserted).toBeGreaterThan(0);
    const second = resumeDelta(ctx.store); // nothing happened in between
    expect(second.counts.factsAsserted).toBe(0);
    expect(second.counts.notesChanged).toBe(0);
    // an explicit probe of the past still sees everything — pure read
    const probe = resumeDelta(ctx.store, { since: '2020-01-01' });
    expect(probe.counts.factsAsserted).toBeGreaterThan(0);
    const after = resumeDelta(ctx.store); // probe must not have advanced it
    expect(after.counts.factsAsserted).toBe(0);
    ctx.close();
  });

  it('an edit made while the index was stale still surfaces once it catches up', async () => {
    // The ordinary flow: edit the vault in an editor with nothing indexing,
    // then start a session. resume reports what the INDEX knows, but the
    // watermark used to advance by the WALL CLOCK — so the unseen edit's
    // mtime ended up below the watermark and was reported in no delta, ever.
    const ctx = await freshCtx();
    const file = join(ctx.root, 'a.md');
    resumeDelta(ctx.store); // session 1: consumes the seed note
    await new Promise((r) => setTimeout(r, 40));
    await writeFile(file, '# Alpha\n\nEDITED while nothing was indexing\n');

    // session 2: the index has not seen the edit yet, so there is nothing to
    // report — and crucially the watermark must not run past it.
    expect(resumeDelta(ctx.store).counts.notesChanged).toBe(0);

    await indexVault(ctx.store, ctx.root); // lore index / watch catches up
    expect(resumeDelta(ctx.store).counts.notesChanged).toBe(1);
    // and it is not reported twice
    expect(resumeDelta(ctx.store).counts.notesChanged).toBe(0);
    ctx.close();
  });

  it('a future watermark yields an empty delta, and garbage is rejected', async () => {
    const ctx = await freshCtx();
    const d = resumeDelta(ctx.store, { since: '2099-01-01' });
    expect(d.counts).toEqual({ notesChanged: 0, factsAsserted: 0, factsSuperseded: 0 });
    expect(() => resumeDelta(ctx.store, { since: 'yesterday-ish' })).toThrow(/ISO date/);
    ctx.close();
  });
});
