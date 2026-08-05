import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { VaultFile } from '../types.js';

const DEFAULT_IGNORES = new Set(['node_modules', '.git', '.obsidian', '.lore', '.trash']);

/**
 * Recursively find markdown files under `root`.
 * Skips dot-directories and DEFAULT_IGNORES; extra names via `ignore`.
 * Returns vault-relative forward-slash paths, sorted for determinism.
 */
export async function scanVault(root: string, ignore: string[] = []): Promise<VaultFile[]> {
  const ignoreSet = new Set([...DEFAULT_IGNORES, ...ignore]);
  const out: VaultFile[] = [];

  async function walk(dir: string, rel: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return; // unreadable dir: skip, not fatal
    }
    for (const e of entries) {
      const name = e.name;
      if (e.isDirectory()) {
        if (name.startsWith('.') || ignoreSet.has(name)) continue;
        await walk(join(dir, name), rel ? `${rel}/${name}` : name);
      } else if (e.isFile() && /\.md$/i.test(name) && !name.startsWith('.')) {
        const abs = join(dir, name);
        try {
          const s = await stat(abs);
          out.push({
            path: rel ? `${rel}/${name}` : name,
            absPath: abs,
            mtimeMs: s.mtimeMs,
          });
        } catch {
          // raced deletion: skip
        }
      }
    }
  }

  await walk(root, '');
  out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return out;
}
