import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { VaultFile } from '../types.js';

const DEFAULT_IGNORES = new Set(['node_modules', '.git', '.obsidian', '.lore', '.trash']);

/**
 * Engine-generated notes under `lore/` that must never be indexed, or the
 * engine's own output becomes its own input: a review queue listing orphans
 * makes those orphans look linked, and digests compete with real notes in
 * search. Journals are the exception — they are the durable fact record and
 * MUST be read back.
 */
const DERIVED_PREFIXES = ['lore/digests/', 'lore/review-queue'];

export function isDerivedNote(path: string): boolean {
  return DERIVED_PREFIXES.some((p) => path.startsWith(p));
}

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
        const relPath = rel ? `${rel}/${name}` : name;
        if (isDerivedNote(relPath)) continue;
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
