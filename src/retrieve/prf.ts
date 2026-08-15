import type { Store } from '../store/db.js';
import { STOPWORDS, contentTerms, normalizeKey } from '../normalize.js';

/**
 * Pseudo-relevance feedback: ask the top results what else to look for.
 *
 * Some questions are answered by ONE passage; others need several pieces that
 * sit together in the vault. Measured on LoCoMo, whose multi-hop questions
 * carry 3.13 evidence turns on average, loreweave reached 22% of the
 * achievable R@1 there against 40-48% on single-evidence categories — the gap
 * is not finding the first piece, it is finding the rest of the cluster.
 *
 * Rocchio's answer, from 1971 and still the strongest deterministic one: take
 * the terms that distinguish the top few results from the corpus, add them to
 * the query, and search again. No model, no network — the expansion comes from
 * the vault's own text, which also means it can only ever pull in vocabulary
 * the vault actually uses.
 *
 * PRF is famous for query drift, so this is deliberately conservative:
 *  - it runs only when the caller judges the query hard (see `shouldExpand`);
 *  - candidate terms must be RARE (low document frequency) to count as
 *    distinguishing, and common ones are exactly what drift is made of;
 *  - the expansion feeds a SEPARATE ranked list fused at a lower weight, so it
 *    can add evidence but never outvote the user's own words.
 */

/** Terms that distinguish the feedback documents from the rest of the vault. */
export function feedbackTerms(
  store: Store,
  texts: string[],
  queryTerms: string[],
  opts: { max?: number; maxDf?: number } = {},
): string[] {
  const max = opts.max ?? 6;
  const already = new Set(queryTerms);
  const tf = new Map<string, number>();
  for (const text of texts) {
    // count once per document: a word repeated inside one passage is not
    // better evidence than a word appearing across several of them.
    const seen = new Set<string>();
    for (const tok of contentTerms(text)) {
      if (tok.length < 4 || STOPWORDS.has(tok) || already.has(tok)) continue;
      if (!/^[a-z][a-z0-9]*$/.test(tok)) continue; // FTS-safe, and skips numbers
      if (seen.has(tok)) continue;
      seen.add(tok);
      tf.set(tok, (tf.get(tok) ?? 0) + 1);
    }
  }
  if (tf.size === 0) return [];

  const total =
    (store.db.prepare(`SELECT COUNT(*) c FROM blocks WHERE archived=0`).get() as { c: number })
      .c || 1;
  // A term is worth adding when it recurs across the feedback set AND is rare
  // in the vault: recurrence says "this cluster is about it", rarity says "it
  // narrows". Common words score high on the first and nothing on the second,
  // which is precisely the drift PRF is warned about.
  const maxDf = opts.maxDf ?? Math.max(20, Math.ceil(total * 0.05));
  const scored: { term: string; score: number }[] = [];
  const dfStmt = store.db.prepare(
    `SELECT COUNT(*) c FROM blocks_fts WHERE blocks_fts MATCH ?`,
  );
  for (const [term, count] of tf) {
    if (count < 2 && texts.length > 1) continue; // one document is not a pattern
    let d: number;
    try {
      d = (dfStmt.get(`"${term}"`) as { c: number }).c;
    } catch {
      continue;
    }
    if (d === 0 || d > maxDf) continue;
    scored.push({ term, score: count * Math.log(total / d) });
  }
  scored.sort((a, b) => b.score - a.score || (a.term < b.term ? -1 : 1));
  return scored.slice(0, max).map((s) => s.term);
}

/**
 * Is this query worth expanding?
 *
 * Expansion helps hard, verbose, multi-piece questions and hurts precise ones
 * — the selective-QE literature exists because unconditional PRF degrades a
 * meaningful fraction of queries. Two cheap pre-retrieval signals decide:
 * the query has to be substantial enough to be about more than one thing, and
 * the first result must not already be an obvious bullseye.
 */
export function shouldExpand(queryTerms: string[], topCoverage: number): boolean {
  if (queryTerms.length < 4) return false; // short queries are usually precise
  return topCoverage < 0.99; // a hit covering every term needs no help
}

/** Coverage of the query's terms by a passage — the same measure search reports. */
export function coverageOf(text: string, queryTerms: string[]): number {
  if (!queryTerms.length) return 0;
  const hay = normalizeKey(text);
  return queryTerms.filter((t) => hay.includes(t)).length / queryTerms.length;
}
