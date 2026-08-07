import { readdir, realpath, stat } from 'node:fs/promises';
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
export async function scanVault(
  root: string,
  ignore: string[] = [],
  opts: { followSymlinks?: boolean } = {},
): Promise<VaultFile[]> {
  const ignoreSet = new Set([...DEFAULT_IGNORES, ...ignore]);
  const follow = opts.followSymlinks !== false;
  const out: VaultFile[] = [];
  // Real paths already walked. A symlinked directory pointing at an ancestor
  // is an infinite tree; following links without this would never terminate.
  const visited = new Set<string>();

  async function walk(dir: string, rel: string): Promise<void> {
    if (follow) {
      let real: string;
      try {
        real = await realpath(dir);
      } catch {
        return; // broken link or vanished directory
      }
      if (visited.has(real)) return;
      visited.add(real);
    }
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return; // unreadable dir: skip, not fatal
    }
    for (const e of entries) {
      const name = e.name;
      // A symlink reports as neither file nor directory, so without this a
      // folder symlinked into the vault was silently skipped — the notes were
      // simply invisible, with nothing to indicate why.
      let isDir = e.isDirectory();
      let isFile = e.isFile();
      if (follow && e.isSymbolicLink()) {
        try {
          const st = await stat(join(dir, name)); // follows the link
          isDir = st.isDirectory();
          isFile = st.isFile();
        } catch {
          continue; // dangling link
        }
      }
      if (isDir) {
        if (name.startsWith('.') || ignoreSet.has(name)) continue;
        await walk(join(dir, name), rel ? `${rel}/${name}` : name);
      } else if (isFile && /\.md$/i.test(name) && !name.startsWith('.')) {
        const relPath = rel ? `${rel}/${name}` : name;
        if (isDerivedNote(relPath)) continue;
        const abs = join(dir, name);
        try {
          const s = await stat(abs);
          out.push({
            path: relPath,
            absPath: abs,
            mtimeMs: s.mtimeMs,
            size: s.size,
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
