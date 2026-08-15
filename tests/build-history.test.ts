import { describe, expect, it } from 'vitest';
import { mkdtemp, writeFile, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../src/store/db.js';
import { indexVault } from '../src/index/indexer.js';
import { queryFacts } from '../src/facts/model.js';
import { PARSER_VERSION } from '../src/store/schema.js';

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
