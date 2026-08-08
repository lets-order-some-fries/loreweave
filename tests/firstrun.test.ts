import { describe, expect, it } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openContext, ensureIndexed } from '../src/context.js';
import { search } from '../src/retrieve/search.js';
import { indexVault } from '../src/index/indexer.js';
import { FIXTURE_VAULT, makeVault } from './helpers.js';

/**
 * The first thing a new user does must not produce the worst answer a
 * knowledge tool can give. `lore search` in a vault of 39 notes replied "no
 * results" — indistinguishable from a genuine miss, at the one moment they
 * have no way to tell the difference. Over MCP it is worse: an agent gets `[]`
 * and reports that the user has nothing written on the subject.
 */
describe('first run', () => {
  it('answers from a vault that has never been indexed', async () => {
    const root = await makeVault(FIXTURE_VAULT);
    const ctx = openContext(root);
    expect((ctx.store.db.prepare('SELECT COUNT(*) c FROM notes').get() as { c: number }).c).toBe(0);

    const didIndex = await ensureIndexed(ctx);
    expect(didIndex).toBe(true);

    const hits = await search(ctx, 'riverbed protocol', { k: 5 });
    expect(hits.length).toBeGreaterThan(0);
    ctx.close();
  });

  it('reports how many notes it is about to index, once', async () => {
    const root = await makeVault(FIXTURE_VAULT);
    const ctx = openContext(root);
    const seen: number[] = [];
    await ensureIndexed(ctx, (n) => seen.push(n));
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBeGreaterThan(0);

    // second call is a no-op: no callback, no re-index
    seen.length = 0;
    expect(await ensureIndexed(ctx, (n) => seen.push(n))).toBe(false);
    expect(seen).toHaveLength(0);
    ctx.close();
  });

  it('leaves an already-indexed vault alone', async () => {
    const root = await makeVault(FIXTURE_VAULT);
    const ctx = openContext(root);
    await indexVault(ctx.store, root);
    const before = ctx.store.db.prepare('SELECT COUNT(*) c FROM notes').get() as { c: number };
    expect(await ensureIndexed(ctx)).toBe(false);
    const after = ctx.store.db.prepare('SELECT COUNT(*) c FROM notes').get() as { c: number };
    expect(after.c).toBe(before.c);
    ctx.close();
  });

  it('says nothing about an empty vault, because "no results" is then true', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lw-empty-'));
    const ctx = openContext(root);
    const seen: number[] = [];
    expect(await ensureIndexed(ctx, (n) => seen.push(n))).toBe(false);
    expect(seen).toHaveLength(0);
    expect(await search(ctx, 'anything at all', { k: 5 })).toEqual([]);
    ctx.close();
  });
});

describe('a mistyped vault path', () => {
  it('says the vault is missing, not that a mkdir failed', async () => {
    // Left to the store this surfaced as
    //   ENOENT: no such file or directory, mkdir '/nope/.lore'
    // — a raw errno naming an internal directory the user has never heard of,
    // for a mistake in the one argument they can see.
    expect(() => openContext(join(tmpdir(), 'lw-definitely-not-here-9f3a2c'))).toThrow(
      /vault not found/,
    );
  });

  it('says so when the path is a file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lw-notdir-'));
    const file = join(root, 'notes.md');
    await writeFile(file, '# not a vault\n');
    expect(() => openContext(file)).toThrow(/not a directory/);
  });
});

describe('the engine can find what it just wrote', () => {
  // The natural agent sequence — record something, then search for it —
  // returned nothing until a full reindex, and the tool description documented
  // the trap instead of removing it. capture and assertFact know exactly which
  // file they appended to, so they index it themselves.
  it('capture is searchable immediately', async () => {
    const root = await makeVault(FIXTURE_VAULT);
    const ctx = openContext(root);
    await ensureIndexed(ctx);
    const { capture } = await import('../src/capture.js');
    capture(ctx, 'XENOPUS decision: streaming compaction wins');
    const hits = await search(ctx, 'XENOPUS', { k: 5, noLog: true });
    expect(hits.some((h) => h.notePath.includes('inbox'))).toBe(true);
    ctx.close();
  });

  it('an asserted fact’s journal entry is searchable immediately', async () => {
    const root = await makeVault(FIXTURE_VAULT);
    const ctx = openContext(root);
    await ensureIndexed(ctx);
    const { assertFact } = await import('../src/facts/model.js');
    assertFact(ctx, {
      subject: 'Quagga Initiative', predicate: 'status', object: 'shipped', validFrom: '2026-08-01',
    });
    const hits = await search(ctx, 'Quagga', { k: 5, noLog: true });
    expect(hits.some((h) => h.notePath.includes('journal'))).toBe(true);
    ctx.close();
  });

  it('the self-index leaves exactly the state a full rebuild produces', async () => {
    // The helper does the per-note work and skips the batch steps, so a later
    // incremental run must see the file as unchanged AND the resulting store
    // must equal a fresh index of the same bytes — otherwise the trap has been
    // traded for a divergence.
    const root = await makeVault(FIXTURE_VAULT);
    const ctx = openContext(root);
    await ensureIndexed(ctx);
    const { capture } = await import('../src/capture.js');
    const { assertFact } = await import('../src/facts/model.js');
    capture(ctx, 'consistency check line');
    assertFact(ctx, {
      subject: 'Consistency', predicate: 'holds', object: 'yes', validFrom: '2026-08-01',
    });

    const { indexVault } = await import('../src/index/indexer.js');
    const report = await indexVault(ctx.store, root);
    expect(report.added + report.updated).toBe(0); // nothing left half-done

    const { openStore } = await import('../src/store/db.js');
    const fresh = openStore(':memory:');
    await indexVault(fresh, root);
    const snap = (s: typeof fresh) =>
      JSON.stringify(
        s.db.prepare(`SELECT note_path, anchor, text FROM blocks ORDER BY note_path, anchor`).all(),
      );
    expect(snap(ctx.store as never)).toBe(snap(fresh));
    fresh.close();
    ctx.close();
  });
});
