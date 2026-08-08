import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, symlink, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { capture, readNoteRaw, safeVaultPath } from '../src/capture.js';
import { openStore } from '../src/store/db.js';
import { ConfigSchema } from '../src/config.js';

/** capture now self-indexes its write, so it needs a real store and config. */
function miniCtx(root: string) {
  return {
    root,
    config: ConfigSchema.parse({}),
    store: openStore(':memory:'),
  } as never;
}

/**
 * `resolve` normalises `..` but does not follow symlinks, so containment was
 * enforced lexically: `../secret.md` was refused while `linked/secret.md`,
 * through a symlinked folder, went straight through. Both of these paths are
 * driven by an agent over MCP.
 */
async function vaultWithSymlink() {
  const base = await mkdtemp(join(tmpdir(), 'lw-esc-'));
  const vault = join(base, 'vault');
  const outside = join(base, 'outside');
  await mkdir(vault, { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(join(outside, 'secret.md'), '# Secret\n\nOutside the vault.\n');
  await writeFile(join(outside, 'target.md'), 'original\n');
  await symlink(outside, join(vault, 'linked'));
  return { vault, outside };
}

describe('vault containment', () => {
  it('refuses plain traversal', async () => {
    const { vault } = await vaultWithSymlink();
    expect(() => readNoteRaw(vault, '../outside/secret.md')).toThrow(/escapes the vault/);
  });

  it('still reads notes reached through a symlinked folder', async () => {
    // scanVault follows symlinked folders deliberately — one used to be
    // silently invisible, which was its own bug — so those notes are indexed
    // and returned by search. Refusing to read them would leave search
    // returning results that cannot be opened.
    const { vault } = await vaultWithSymlink();
    expect(readNoteRaw(vault, 'linked/secret.md')).toContain('Outside the vault');
  });

  it('refuses to WRITE through a symlink', async () => {
    // Linking a folder in so its notes can be found does not ask the engine to
    // create files inside it. Before this, capture appended to a file outside
    // the vault and reported success.
    const { vault, outside } = await vaultWithSymlink();
    expect(() => capture(miniCtx(vault), 'INJECTED', 'linked/target.md')).toThrow(/symlink/);
    expect(await readFile(join(outside, 'target.md'), 'utf8')).toBe('original\n');
  });

  it('still writes normally inside the vault', async () => {
    const { vault } = await vaultWithSymlink();
    expect(capture(miniCtx(vault), 'a real note', 'lore/inbox.md')).toBe('lore/inbox.md');
    expect(await readFile(join(vault, 'lore', 'inbox.md'), 'utf8')).toContain('a real note');
  });

  it('write containment covers paths that do not exist yet', async () => {
    // capture creates its target, so the check has to run on the deepest
    // ancestor that exists rather than on the file itself.
    const { vault } = await vaultWithSymlink();
    expect(() =>
      safeVaultPath(vault, 'linked/new/deep/note.md', { followSymlinks: false }),
    ).toThrow(/symlink/);
    expect(safeVaultPath(vault, 'notes/new/deep/note.md', { followSymlinks: false })).toContain(
      'notes/new/deep/note.md',
    );
  });
});
