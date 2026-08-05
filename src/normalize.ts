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
