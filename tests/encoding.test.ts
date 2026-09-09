import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../src/store/db.js';
import { indexVault } from '../src/index/indexer.js';
import { readNoteRaw } from '../src/capture.js';
import { buildProgram } from '../src/cli/main.js';

/**
 * Every note was read as UTF-8, whatever it was. A UTF-16 file — what
 * Notepad and PowerShell's `>` write by default — became U+FFFD soup:
 * measured title 'utf16', first block bytes EFBFBDEFBFBD23, and its words
 * unsearchable, with `lore index` reporting no warning at all. A latin-1
 * file lost every accented word the same way, in silence.
 */
const utf16le = (s: string) => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(s, 'utf16le')]);
const utf16be = (s: string) => {
  const le = Buffer.from(s, 'utf16le');
  return Buffer.concat([Buffer.from([0xfe, 0xff]), le.swap16()]);
};
const utf8bom = (s: string) => Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(s, 'utf8')]);
const latin1 = (s: string) => Buffer.from(s, 'latin1');

async function vault(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'lw-enc-'));
  await mkdir(join(root, '.lore'), { recursive: true });
  await writeFile(join(root, 'utf16le.md'), utf16le('# Kestrel notes\n\nThe kestrel hovers over the meadow.\n'));
  await writeFile(join(root, 'utf16be.md'), utf16be('# Merlin notes\n\nThe merlin hunts at dusk.\n'));
  await writeFile(
    join(root, 'bom.md'),
    utf8bom('---\ntitle: Bommed Note\n---\n\n# Heading\n\nA plain UTF-8 file with a byte-order mark.\n'),
  );
  await writeFile(join(root, 'latin1.md'), latin1('# Café\n\nA naïve résumé, saved as Latin-1.\n'));
  await writeFile(join(root, 'plain.md'), '# Plain\n\nordinary utf-8\n');
  return root;
}

describe('note encodings', () => {
  it('a UTF-16 note, either byte order, is indexed as its text', async () => {
    const root = await vault();
    const store = openStore(':memory:');
    const report = await indexVault(store, root);
    const titles = Object.fromEntries(
      (store.db.prepare('SELECT path, title FROM notes').all() as { path: string; title: string }[]).map(
        (r) => [r.path, r.title],
      ),
    );
    expect(titles['utf16le.md']).toBe('Kestrel notes');
    expect(titles['utf16be.md']).toBe('Merlin notes');
    expect(store.searchLexical('kestrel', 5).map((h) => h.notePath)).toEqual(['utf16le.md']);
    expect(store.searchLexical('merlin', 5).map((h) => h.notePath)).toEqual(['utf16be.md']);
    const blocks = store.db
      .prepare(`SELECT text FROM blocks WHERE note_path IN ('utf16le.md','utf16be.md','bom.md')`)
      .all() as { text: string }[];
    for (const b of blocks) {
      expect(b.text).not.toContain('�');
      expect(b.text).not.toContain('﻿');
    }
    // a decoded-correctly file is not something to warn about
    expect(report.warnings.filter((w) => /utf16|bom\.md/.test(w))).toEqual([]);
    store.close();
  });

  it('a UTF-8 byte-order mark is stripped, so frontmatter still parses', async () => {
    const root = await vault();
    const store = openStore(':memory:');
    await indexVault(store, root);
    const row = store.db.prepare(`SELECT title FROM notes WHERE path='bom.md'`).get() as { title: string };
    expect(row.title).toBe('Bommed Note');
    store.close();
  });

  it('a note that is not UTF-8 is indexed best-effort with a warning naming it', async () => {
    const root = await vault();
    const store = openStore(':memory:');
    const report = await indexVault(store, root);
    const about = report.warnings.filter((w) => w.startsWith('latin1.md:'));
    expect(about).toHaveLength(1);
    expect(about[0]).toMatch(/UTF-8/);
    // still indexed — the ASCII words are searchable — but honestly marked
    expect(store.searchLexical('saved', 5).map((h) => h.notePath)).toEqual(['latin1.md']);
    store.close();
  });

  it('`lore index` shows the warning', async () => {
    const root = await vault();
    const err: string[] = [];
    const program = buildProgram({ out: () => {}, err: (s) => err.push(s) });
    program.exitOverride();
    for (const c of program.commands) c.exitOverride();
    await program.parseAsync(['node', 'lore', '--vault', root, 'index']);
    expect(err.filter((l) => l.includes('latin1.md'))).toHaveLength(1);
    expect(err.filter((l) => /utf16|bom\.md|plain\.md/.test(l))).toEqual([]);
  });

  it('read_note decodes the same way the indexer does', async () => {
    const root = await vault();
    expect(readNoteRaw(root, 'utf16le.md')).toContain('kestrel hovers');
    expect(readNoteRaw(root, 'utf16be.md')).toContain('merlin hunts');
    expect(readNoteRaw(root, 'bom.md')).not.toContain('﻿');
    expect(readNoteRaw(root, 'plain.md')).toBe('# Plain\n\nordinary utf-8\n');
  });
});
