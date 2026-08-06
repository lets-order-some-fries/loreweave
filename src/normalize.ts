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

/**
 * Function words that carry no retrieval signal. Natural-language questions
 * are the primary interface (an MCP agent asks "what are my target roles",
 * not "target roles"), and these words both dilute the lexical match and
 * make coverage under-report: a block containing the exact answer scored
 * 2/5 = "40% of terms — weak" purely for lacking "what are my".
 */
export const STOPWORDS = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'am',
  'do', 'does', 'did', 'doing', 'have', 'has', 'had', 'having', 'will',
  'would', 'shall', 'should', 'can', 'could', 'may', 'might', 'must',
  'what', 'which', 'who', 'whom', 'whose', 'when', 'where', 'why', 'how',
  'i', 'me', 'my', 'mine', 'we', 'us', 'our', 'ours', 'you', 'your', 'yours',
  'he', 'him', 'his', 'she', 'her', 'hers', 'it', 'its', 'they', 'them',
  'their', 'theirs', 'this', 'that', 'these', 'those',
  'of', 'in', 'on', 'at', 'to', 'for', 'with', 'from', 'by', 'about', 'as',
  'into', 'over', 'under', 'again', 'further', 'then', 'once', 'here',
  'there', 'all', 'any', 'both', 'each', 'few', 'more', 'most', 'other',
  'some', 'such', 'no', 'nor', 'not', 'only', 'own', 'same', 'so', 'than',
  'too', 'very', 'just', 'and', 'or', 'but', 'if', 'because', 'while',
  'tell', 'show', 'find', 'give', 'get', 'know', 'want', 'need', 'please',
]);

/**
 * Content words of a query. Falls back to the full token list when a query is
 * nothing but function words, so a search never silently becomes empty.
 */
export function contentTerms(query: string): string[] {
  const tokens = normalizeKey(query).split(' ').filter(Boolean);
  const kept = tokens.filter((t) => !STOPWORDS.has(t));
  return kept.length > 0 ? kept : tokens;
}
