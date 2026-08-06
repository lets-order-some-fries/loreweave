import { describe, expect, it } from 'vitest';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, verifyOrReset } from '../src/store/db.js';
import { parseNote } from '../src/vault/parse.js';

async function tmpDb(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), 'lw-dur-')), 'index.db');
}

describe('index durability', () => {
  it('a corrupt index is reset rather than bricking every command', async () => {
    const file = await tmpDb();
    const a = openStore(file);
    a.upsertNote(parseNote('a.md', 'searchable content here\n', 1));
    a.close();

    // scribble over the middle of the file
    const buf = await readFile(file);
    for (let i = 2000; i < Math.min(6000, buf.length); i++) buf[i] = 0xff;
    await writeFile(file, buf);

    const healed: string[] = [];
    const reset = verifyOrReset(file, (m) => healed.push(m));
    expect(reset).toBe(true);
    expect(healed[0]).toMatch(/corrupt/i);

    // and the store is usable again afterwards
    const b = openStore(file);
    expect(b.searchLexical('searchable', 5)).toEqual([]); // empty, not broken
    b.upsertNote(parseNote('a.md', 'searchable content here\n', 1));
    expect(b.searchLexical('searchable', 5)).toHaveLength(1);
    b.close();
  });

  it('a healthy index is never reset', async () => {
    const file = await tmpDb();
    const s = openStore(file);
    s.upsertNote(parseNote('a.md', 'keep me\n', 1));
    s.close();
    expect(verifyOrReset(file)).toBe(false);
    const again = openStore(file);
    expect(again.searchLexical('keep', 5)).toHaveLength(1);
    again.close();
  });

  it('a missing file is not mistaken for corruption', async () => {
    const file = await tmpDb();
    expect(existsSync(file)).toBe(false);
    expect(verifyOrReset(file)).toBe(false);
  });

  it('two stores can open the same file concurrently', async () => {
    // journal_mode=WAL needs an exclusive lock; without the retry this is
    // where a second process died with "database is locked".
    const file = await tmpDb();
    const a = openStore(file);
    const b = openStore(file);
    a.upsertNote(parseNote('a.md', 'from a\n', 1));
    b.upsertNote(parseNote('b.md', 'from b\n', 1));
    expect(a.listNotes().size).toBe(2);
    a.close();
    b.close();
  });
});
