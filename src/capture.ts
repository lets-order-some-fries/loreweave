import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import type { LoreContext } from './context.js';

/** Resolve a vault-relative path, refusing traversal outside the vault. */
export function safeVaultPath(root: string, rel: string): string {
  const abs = resolve(root, rel);
  const rootAbs = resolve(root);
  if (abs !== rootAbs && !abs.startsWith(rootAbs + sep)) {
    throw new Error(`path escapes the vault: ${rel}`);
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
  const abs = safeVaultPath(ctx.root, to);
  mkdirSync(dirname(abs), { recursive: true });
  const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
  appendFileSync(abs, `- ${stamp} — ${clean.replace(/\r?\n+/g, ' ')}\n`, 'utf8');
  return to;
}

/** Read a note's raw markdown (path-validated). */
export function readNoteRaw(root: string, rel: string): string {
  return readFileSync(safeVaultPath(root, rel), 'utf8');
}
