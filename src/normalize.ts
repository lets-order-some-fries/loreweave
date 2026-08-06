/**
 * Resolve a relative markdown link target against the linking note's
 * directory, producing a clean vault-relative path (no leading ./ or ../).
 * Returns null if the link escapes the vault root.
 */
export function resolveRelative(notePath: string, href: string): string | null {
  const base = notePath.split('/').slice(0, -1);
  const parts = href.split('/');
  const stack = href.startsWith('/') ? [] : [...base];
  for (const p of parts) {
    if (p === '' || p === '.') continue;
    if (p === '..') {
      if (stack.length === 0) return null; // escapes the vault
      stack.pop();
      continue;
    }
    stack.push(p);
  }
  return stack.length ? stack.join('/') : null;
}

/**
 * The key a link is matched on. Wiki-links match by name; markdown links are
 * paths, so they resolve against the source note and then match on basename —
 * the same key notes register under, so both link styles land on one node.
 */
export function linkMatchKey(
  notePath: string,
  target: string,
  style: 'wiki' | 'markdown',
): string {
  if (style !== 'markdown') return normalizeKey(target);
  const resolved = resolveRelative(notePath, target);
  if (!resolved) return normalizeKey(target);
  return normalizeKey(resolved.split('/').pop() ?? resolved);
}

/**
 * Singularize the final word of an entity key so "PR"/"PRs" and
 * "Test"/"Tests" are one graph node rather than two. Deliberately shallow:
 * only the unambiguous English plural endings, and never on short words
 * where the 's' is likely part of the name.
 */
export function singularizeKey(key: string): string {
  const parts = key.split(' ');
  const last = parts[parts.length - 1];
  if (!last || last.length < 4) return key;
  let singular = last;
  if (/[^aeiou]ies$/.test(last)) singular = `${last.slice(0, -3)}y`;
  else if (/(ches|shes|sses|xes|zes)$/.test(last)) singular = last.slice(0, -2);
  else if (/[^su]s$/.test(last)) singular = last.slice(0, -1);
  if (singular === last || singular.length < 2) return key;
  parts[parts.length - 1] = singular;
  return parts.join(' ');
}

/** Normalize a link target / entity name / fact subject for matching. */
export function normalizeKey(s: string): string {
  return s
    .normalize('NFKC')
    .toLowerCase()
    .trim()
    .replace(/\.md$/i, '')
    .replace(/[‘’“”'"`]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}
