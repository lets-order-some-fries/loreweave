import { appendFileSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import type { LoreContext } from './context.js';
import { indexNoteFile } from './index/indexer.js';

/** Deepest ancestor of `abs` that exists, with symlinks resolved. */
function realExistingAncestor(abs: string): { real: string; tail: string[] } {
  const tail: string[] = [];
  let cur = abs;
  for (;;) {
    try {
      return { real: realpathSync(cur), tail };
    } catch {
      const parent = dirname(cur);
      if (parent === cur) return { real: cur, tail }; // reached the filesystem root
      tail.unshift(cur.slice(parent.length + 1));
      cur = parent;
    }
  }
}

/**
 * Resolve a vault-relative path, refusing traversal outside the vault.
 *
 * `resolve` normalises `..` but does NOT follow symlinks, so the check was
 * lexical only: `../secret.md` was refused while `linked/secret.md`, through a
 * symlinked folder, was allowed straight through. Both paths here are driven
 * by an agent over MCP, so the difference is not academic.
 *
 * Reads and writes get different answers on purpose.
 *
 * `scanVault` follows symlinked folders deliberately — a folder symlinked into
 * a vault used to be silently invisible, which was its own bug — so those
 * notes are indexed, are returned by search, and must be readable. Refusing to
 * read them would leave search returning results that cannot be opened.
 *
 * Writing is not implied by any of that. Linking a folder in so its notes can
 * be found does not ask the engine to create files inside it, so writes are
 * held to the real vault root: symlinks resolved, no exceptions.
 */
export function safeVaultPath(
  root: string,
  rel: string,
  opts: { followSymlinks?: boolean } = {},
): string {
  const abs = resolve(root, rel);
  const rootAbs = resolve(root);
  const inside = (p: string, r: string) => p === r || p.startsWith(r + sep);
  if (!inside(abs, rootAbs)) {
    throw new Error(`path escapes the vault: ${rel}`);
  }
  if (opts.followSymlinks === false) {
    // The target may not exist yet (capture creates it), so containment is
    // checked on the deepest ancestor that does; the rest cannot be a symlink
    // because it is not there.
    const rootReal = realExistingAncestor(rootAbs).real;
    const { real, tail } = realExistingAncestor(abs);
    const resolved = tail.length ? join(real, ...tail) : real;
    if (!inside(resolved, rootReal)) {
      throw new Error(`path escapes the vault through a symlink: ${rel}`);
    }
  }
  return abs;
}

/**
 * Quick capture: append a timestamped bullet to lore/inbox.md (or another
 * vault note). Append-only — the engine never rewrites user prose.
 */
export function capture(ctx: LoreContext, text: string, to = 'lore/inbox.md'): string {
  const clean = text.trim();
  if (!clean) throw new Error('nothing to capture');
  if (!/\.md$/i.test(to)) throw new Error('capture target must be a .md file');
  // Writes never leave the real vault, even through a symlink the user put
  // there for reading.
  const abs = safeVaultPath(ctx.root, to, { followSymlinks: false });
  mkdirSync(dirname(abs), { recursive: true });
  const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
  appendFileSync(abs, `- ${stamp} — ${clean.replace(/\r?\n+/g, ' ')}\n`, 'utf8');
  // Index what was just written, so "capture, then search for it" works. The
  // trap this removes was real enough to have been documented in the MCP tool
  // description as something the caller had to remember.
  indexNoteFile(ctx.store, ctx.root, to, { nlp: ctx.config.nlp });
  ctx.invalidateGraph?.();
  return to;
}

/** Read a note's raw markdown (path-validated). */
export function readNoteRaw(root: string, rel: string): string {
  return readFileSync(safeVaultPath(root, rel), 'utf8');
}
