import { describe, expect, it } from 'vitest';
import { mkdtemp, writeFile, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../src/store/db.js';
import { indexVault } from '../src/index/indexer.js';
import { queryFacts } from '../src/facts/model.js';
import { PARSER_VERSION } from '../src/store/schema.js';
import { search } from '../src/retrieve/search.js';
import { buildGraph } from '../src/graph/build.js';
import { buildNoteLinkGraph } from '../src/retrieve/expand.js';
import { buildTimeline } from '../src/temporal/timeline.js';
import { ConfigSchema } from '../src/config.js';
import type { LoreContext } from '../src/context.js';

/**
 * The engine's load-bearing promise: outputs are a function of the VAULT, not
 * of how or when the index was built. Two ways that broke, both shipped after
 * the property was first tested — a wall clock leaking into replay, and a
 * parser that learned new things without telling the cache.
 */
describe('answers do not depend on index build history', () => {
  it('an unrelated edit does not re-date a fact recorded in a plain note', async () => {
    // rebuildFactsFromNotes wipes and replays the whole table on every index
    // that touches any note, and undated records fell back to the CLOCK — so
    // editing an unrelated note moved a fact's recorded_at, `as-known-at`
    // answers shifted, and `resume` announced facts nobody had asserted.
    const root = await mkdtemp(join(tmpdir(), 'lw-bh-'));
    await writeFile(
      join(root, 'pumps.md'),
      '# Pumps\n\n- [fact] drossfen pump :: status :: overhauled\n',
    );
    await writeFile(join(root, 'other.md'), '# Other\n\nunrelated prose.\n');
    const store = openStore(':memory:');
    await indexVault(store, root, { factExtract: 'explicit' });
    const first = queryFacts(store, { subject: 'drossfen pump' })[0]!;

    await new Promise((r) => setTimeout(r, 25));
    await appendFile(join(root, 'other.md'), '\nAn edit to a DIFFERENT note.\n');
    await indexVault(store, root, { factExtract: 'explicit' });
    const second = queryFacts(store, { subject: 'drossfen pump' })[0]!;

    expect(second.recordedAt).toBe(first.recordedAt);
    store.close();
  });

  it('a cache written by an older parser is reparsed, not trusted', async () => {
    // The indexer skips a file whose mtime, size and hash all match, so a
    // release that teaches the parser something new (prose dates, H1 titles)
    // left untouched notes carrying what the OLD parser recorded — for good.
    const root = await mkdtemp(join(tmpdir(), 'lw-pv-'));
    await writeFile(
      join(root, 'field-notes.md'),
      '# Ravelin\n\nBudget approved in June 2023 for the ravelin refit.\n',
    );
    const dbFile = join(root, 'index.db');

    const old = openStore(dbFile);
    await indexVault(old, root);
    // What an older binary leaves behind: identical file fingerprints, derived
    // data its parser could not produce, and no parser stamp.
    old.db.prepare(`UPDATE blocks SET event_from=NULL, event_to=NULL`).run();
    old.db.prepare(`UPDATE notes SET title='field-notes'`).run();
    old.db.prepare(`DELETE FROM meta WHERE key='parser_version'`).run();
    old.close();

    const upgraded = openStore(dbFile); // opening the cache is what heals it
    const report = await indexVault(upgraded, root);
    const block = upgraded.db
      .prepare(`SELECT event_from FROM blocks WHERE note_path='field-notes.md'`)
      .get() as { event_from: string | null };
    const note = upgraded.db
      .prepare(`SELECT title FROM notes WHERE path='field-notes.md'`)
      .get() as { title: string };

    expect(report.updated).toBe(1); // reparsed, not skipped
    expect(block.event_from).toBe('2023-06-01');
    expect(note.title).toBe('Ravelin');
    expect(upgraded.getMeta('parser_version')).toBe(String(PARSER_VERSION));
    upgraded.close();
  });

  it('editing a note keeps the access history of its surviving blocks', async () => {
    // access_log.block_id is ON DELETE SET NULL and every edit deletes all of
    // a note's blocks, so one edit erased that note's whole retrieval history
    // — including blocks whose text never changed and whose stability is
    // carefully carried over. fitDecay trains on exactly those events, so the
    // vaults someone actually works in trained on the least data.
    const root = await mkdtemp(join(tmpdir(), 'lw-al-'));
    const file = join(root, 'a.md');
    await writeFile(file, '# A\n\nFirst paragraph is stable.\n\n## Second\n\nThis part changes.\n');
    const store = openStore(':memory:');
    await indexVault(store, root);
    const first = store.db.prepare(`SELECT id FROM blocks ORDER BY ord LIMIT 1`).get() as { id: number };
    store.logAccess('used', first.id, 'q');
    store.logAccess('retrieved', first.id, 'q');

    await writeFile(file, '# A\n\nFirst paragraph is stable.\n\n## Second\n\nEDITED text now.\n');
    await indexVault(store, root);

    const kept = store.db
      .prepare(`SELECT COUNT(*) c FROM access_log WHERE block_id IS NOT NULL`)
      .get() as { c: number };
    expect(kept.c).toBe(2);
    // and they point at the CURRENT row for that unchanged block
    const nowId = store.db
      .prepare(`SELECT id FROM blocks ORDER BY ord LIMIT 1`)
      .get() as { id: number };
    const pointed = store.db
      .prepare(`SELECT COUNT(*) c FROM access_log WHERE block_id=?`)
      .get(nowId.id) as { c: number };
    expect(pointed.c).toBe(2);
    store.close();
  });

  it('search order is the same whether the index was built fresh or grew', async () => {
    // Two notes tagged the same way tie exactly on PPR mass — ordinary vault
    // structure. Ties fell through to node index = block rowid = insertion
    // order, so a fresh index and an incremental one ranked the byte-identical
    // vault differently. Graph nodes are ordered by content now.
    const files: Record<string, string> = {
      'hub.md': '---\ntitle: Kestrelmoor\n---\n\n# Kestrelmoor\n\nThe kestrelmoor programme coordinates the upland surveys.\n',
      'alpha.md': '---\ntitle: Alpha\ntags: [kestrelmoor]\n---\n\n# Alpha\n\nBench calibration of the drift meter.\n',
      'beta.md': '---\ntitle: Beta\ntags: [kestrelmoor]\n---\n\n# Beta\n\nField calibration of the drift meter.\n',
    };
    const order = async (mode: 'fresh' | 'grown') => {
      const root = await mkdtemp(join(tmpdir(), `lw-det-${mode}-`));
      const store = openStore(':memory:');
      if (mode === 'fresh') {
        for (const [p2, c] of Object.entries(files)) await writeFile(join(root, p2), c);
        await indexVault(store, root);
      } else {
        await writeFile(join(root, 'hub.md'), files['hub.md']!);
        await writeFile(join(root, 'beta.md'), files['beta.md']!);
        await indexVault(store, root);
        await writeFile(join(root, 'alpha.md'), files['alpha.md']!);
        await indexVault(store, root);
      }
      const config = ConfigSchema.parse({});
      let cached: ReturnType<typeof buildGraph> | null = null;
      const ctx = {
        root, config, store, provider: null,
        graph: () => (cached ??= buildGraph(store, config)),
        noteLinks: () => buildNoteLinkGraph(store),
        invalidateGraph: () => (cached = null),
        close: () => store.close(),
      } as unknown as LoreContext;
      const res = (await search(ctx, 'kestrelmoor', { noLog: true })).map((r) => r.notePath);
      store.close();
      return res.join(' > ');
    };
    expect(await order('grown')).toBe(await order('fresh'));
  });

  it('timeline order is the same whether the index was built fresh or grew', async () => {
    const a = '---\ntitle: A\ndate: 2025-05-05\n---\n\n# A\n\n[[Wrenfield Depot]] took delivery of the pumps.\n';
    const b = '---\ntitle: B\ndate: 2025-05-05\n---\n\n# B\n\n[[Wrenfield Depot]] logged the same delivery separately.\n';
    const order = async (mode: 'fresh' | 'grown') => {
      const root = await mkdtemp(join(tmpdir(), `lw-tl-${mode}-`));
      const store = openStore(':memory:');
      if (mode === 'fresh') {
        await writeFile(join(root, 'a.md'), a);
        await writeFile(join(root, 'b.md'), b);
        await indexVault(store, root);
      } else {
        await writeFile(join(root, 'b.md'), b);
        await indexVault(store, root);
        await writeFile(join(root, 'a.md'), a);
        await indexVault(store, root);
      }
      const out = buildTimeline(store, 'Wrenfield Depot').map((e) => e.notePath).join(' > ');
      store.close();
      return out;
    };
    expect(await order('grown')).toBe(await order('fresh'));
  });

  it('a cache at the current parser version is left alone', async () => {
    // The heal must not fire on every open: that would reparse the whole
    // vault on every command.
    const root = await mkdtemp(join(tmpdir(), 'lw-pv2-'));
    await writeFile(join(root, 'a.md'), '# A\n\nplain content.\n');
    const dbFile = join(root, 'index.db');
    const first = openStore(dbFile);
    await indexVault(first, root);
    first.close();

    const second = openStore(dbFile);
    const report = await indexVault(second, root);
    expect(report.unchanged).toBe(1);
    expect(report.updated).toBe(0);
    second.close();
  });
});
