import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanVault } from '../src/vault/scan.js';

async function vault(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'lw-sym-'));
  await mkdir(join(root, 'sub'), { recursive: true });
  await writeFile(join(root, 'a.md'), '# A\n');
  await writeFile(join(root, 'sub', 'b.md'), '# B\n');
  return root;
}

describe('symlinks', () => {
  it('indexes notes inside a symlinked folder', async () => {
    // A symlink reports as neither file nor directory, so these notes used to
    // be silently invisible with nothing to explain why.
    const root = await vault();
    const shared = await mkdtemp(join(tmpdir(), 'lw-shared-'));
    await writeFile(join(shared, 'shared.md'), '# Shared\n');
    await symlink(shared, join(root, 'linked'));

    const files = (await scanVault(root)).map((f) => f.path).sort();
    expect(files).toContain('linked/shared.md');
    expect(files).toContain('a.md');
  });

  it('terminates on a symlink cycle', async () => {
    const root = await vault();
    // sub/loop -> the vault root: an infinite tree without cycle detection
    await symlink(root, join(root, 'sub', 'loop'));

    const files = await scanVault(root);
    const paths = files.map((f) => f.path);
    expect(paths).toContain('a.md');
    expect(paths).toContain('sub/b.md');
    // each real file appears once, however many ways it can be reached
    expect(new Set(paths).size).toBe(paths.length);
  });

  it('a self-referential link does not duplicate the tree', async () => {
    const root = await vault();
    await symlink(join(root, 'sub'), join(root, 'sub', 'self'));
    const files = await scanVault(root);
    expect(files.filter((f) => f.path.endsWith('b.md')).length).toBe(1);
  });

  it('a dangling symlink is skipped, not fatal', async () => {
    const root = await vault();
    await symlink(join(root, 'does-not-exist'), join(root, 'broken'));
    const files = await scanVault(root);
    expect(files.map((f) => f.path)).toContain('a.md');
  });

  it('following can be turned off', async () => {
    const root = await vault();
    const shared = await mkdtemp(join(tmpdir(), 'lw-shared2-'));
    await writeFile(join(shared, 'shared.md'), '# Shared\n');
    await symlink(shared, join(root, 'linked'));

    const files = (await scanVault(root, [], { followSymlinks: false })).map((f) => f.path);
    expect(files).not.toContain('linked/shared.md');
    expect(files).toContain('a.md');
  });
});
