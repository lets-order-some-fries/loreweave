import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { scanVault } from '../src/vault/scan.js';
import { readNoteRaw } from '../src/capture.js';
import { openStore } from '../src/store/db.js';
import { indexVault } from '../src/index/indexer.js';

/**
 * SECURITY.md's first-priority class is "the CLI or MCP server reading files
 * outside the vault it was pointed at". The write side already refuses to
 * leave the real vault through a symlink; the read side followed one
 * anywhere, so a note written into a shared vault by anyone — the threat
 * model this engine assumes everywhere else — could name the file the indexer
 * would read, search would return and lore_read_note would serve in full.
 */
async function escapeVault() {
  const base = await mkdtemp(join(tmpdir(), 'lw-esc2-'));
  const vault = join(base, 'vault');
  const outside = join(base, 'outside');
  await mkdir(join(vault, 'inner', 'deep'), { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(join(vault, 'a.md'), '# A\n\nan ordinary note about kestrels\n');
  await writeFile(join(vault, 'inner', 'deep', 'in.md'), '# In\n\ninside the vault\n');
  await writeFile(join(outside, 'private-diary.md'), '# Diary\n\nmy password is hunter2\n');
  await symlink(join(outside, 'private-diary.md'), join(vault, 'linked.md'));
  await symlink(outside, join(vault, 'linkeddir'));
  // a link that stays inside the vault: deliberate, and still followed
  await symlink(join(vault, 'inner', 'deep', 'in.md'), join(vault, 'alias.md'));
  return { vault, outside };
}

describe('the vault boundary on the read side', () => {
  it('does not index a note that lives outside the vault, by either shape of link', async () => {
    const { vault } = await escapeVault();
    const paths = (await scanVault(vault)).map((f) => f.path);
    expect(paths).not.toContain('linked.md');
    expect(paths).not.toContain('linkeddir/private-diary.md');
    // and a link that stays inside the vault is still followed
    expect(paths).toContain('alias.md');
    expect(paths).toContain('inner/deep/in.md');
    expect(paths).toContain('a.md');
  });

  it('holds the same line when the vault path is spelled another way', async ({ skip }) => {
    // One directory, several names: `C:\Users\RUNNER~1` is `runneradmin`
    // (an 8.3 short name — GitHub's Windows runners put one in TEMP), and on a
    // case-insensitive volume VAULT is vault. The root was resolved by one
    // realpath and each link by the other, and only one of the two rewrites
    // the spelling, so on windows-2022 the test above lost alias.md — every
    // link inside the vault was "outside" it, while plain files were fine.
    // Letter case reproduces that on macOS too. A link's own target can be
    // written either way as well, so twin.md is alias.md with its target in
    // the other spelling, and `current` is the folder shape of it: `archive`
    // is ignored by name, so the link is the only way in.
    const { vault } = await escapeVault();
    const spelled = join(dirname(vault), 'VAULT');
    if (!existsSync(spelled)) skip('case-sensitive volume: VAULT is not vault here');
    await symlink(join(spelled, 'inner', 'deep', 'in.md'), join(vault, 'twin.md'));
    await mkdir(join(vault, 'archive', '2026'), { recursive: true });
    await writeFile(join(vault, 'archive', '2026', 'q3.md'), '# Q3\n\nthis quarter\n');
    await symlink(join(spelled, 'archive', '2026'), join(vault, 'current'));
    const paths = (await scanVault(spelled, ['archive'])).map((f) => f.path);
    expect(paths).toContain('alias.md');
    expect(paths).toContain('twin.md');
    expect(paths).toContain('current/q3.md');
    expect(paths).not.toContain('linked.md');
    expect(paths).not.toContain('linkeddir/private-diary.md');
    expect(readNoteRaw(spelled, 'alias.md')).toContain('inside the vault');
    expect(readNoteRaw(spelled, 'twin.md')).toContain('inside the vault');
    expect(readNoteRaw(spelled, 'current/q3.md')).toContain('this quarter');
    expect(readNoteRaw(spelled, 'a.md')).toContain('kestrels');
    expect(() => readNoteRaw(spelled, 'linked.md')).toThrow(/outside the vault/);
    expect(() => readNoteRaw(spelled, 'linkeddir/private-diary.md')).toThrow(/outside the vault/);
  });

  it('keeps the out-of-vault text out of the index and out of search', async () => {
    const { vault } = await escapeVault();
    const store = openStore(':memory:');
    await indexVault(store, vault);
    expect(store.searchLexical('hunter2', 5)).toEqual([]);
    store.close();
  });

  it('refuses to read it, and says the boundary is why', async () => {
    const { vault } = await escapeVault();
    expect(() => readNoteRaw(vault, 'linked.md')).toThrow(/outside the vault/);
    expect(() => readNoteRaw(vault, 'linkeddir/private-diary.md')).toThrow(/outside the vault/);
    expect(readNoteRaw(vault, 'alias.md')).toContain('inside the vault');
  });

  it('still follows external links when the vault owner asks for it in config', async () => {
    // The config file is written by the person who owns the vault, not by
    // whatever wrote a note into it, so it is the right place for this
    // decision to live. Off by default; on, the old behaviour is intact.
    const { vault } = await escapeVault();
    const paths = (await scanVault(vault, [], { followExternal: true })).map((f) => f.path);
    expect(paths).toContain('linked.md');
    expect(paths).toContain('linkeddir/private-diary.md');
    expect(readNoteRaw(vault, 'linked.md', [], { allowExternal: true })).toContain('hunter2');
  });
});
