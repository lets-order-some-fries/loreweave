import type { Store } from '../store/db.js';

/**
 * Controlled-vocabulary rings for RELATION and TYPE words — the vocabulary a
 * question uses about the vault rather than from it. "Ironbark Archive
 * benefactor" fails lexically because 'benefactor' appears in zero notes,
 * while the vault says "Funded by [[Quillon Endowment]]" — the relation is
 * present under a different surface form, and no statistic derived from the
 * vault can bridge the two (there are no co-occurrences to derive it from).
 *
 * A shipped synonym table is data, not a model: same input, same output, no
 * network, no inference — the same standing as a stemmer table or stopword
 * list, and the mechanism rule-based relation linkers (Falcon 2.0) have used
 * over Wikidata's alias table for years. English-only by construction, so it
 * lives in one place as plain data a locale could replace.
 *
 * Two hard limits keep it honest:
 *  - a ring member is only ever USED for a query term with zero hits in this
 *    vault (df = 0) — if the user's word exists in the corpus, their word wins;
 *  - only ring-mates that DO occur in this vault are substituted in, so
 *    expansion can never inject vocabulary the vault does not use.
 */
const RINGS: string[][] = [
  ['benefactor', 'funder', 'sponsor', 'patron', 'backer', 'funded', 'funding', 'funds', 'grant', 'endowment', 'bequest'],
  ['outpost', 'station', 'site', 'base', 'camp', 'post'],
  ['hardware', 'equipment', 'instrument', 'instruments', 'device', 'apparatus', 'gear'],
  ['fabricator', 'maker', 'builder', 'manufacturer', 'built', 'fabricated', 'constructed'],
  ['boss', 'lead', 'leader', 'head', 'director', 'chief', 'led'],
  ['initiative', 'project', 'programme', 'program', 'effort', 'strand', 'venture'],
  ['headquartered', 'based', 'housed', 'stationed', 'located'],
  ['owner', 'keeper', 'custodian', 'steward', 'maintainer'],
  ['employer', 'company', 'firm', 'organisation', 'organization'],
  ['author', 'writer', 'wrote', 'authored', 'penned'],
  ['price', 'cost', 'budget', 'value', 'award'],
  ['founded', 'established', 'started', 'began', 'inception'],
  ['successor', 'replacement', 'superseded', 'replaced', 'succeeded'],
  ['boss', 'supervisor', 'manager'],
  ['salary', 'pay', 'compensation', 'wage'],
];

/**
 * Rings sharing any word are ONE ring, for every member.
 *
 * The old merge folded a shared word's rings together only in that word's own
 * entry: 'boss' (in both the leadership and supervisor rings) reached
 * 'lead'/'led', while 'supervisor' and 'manager' — its declared synonyms —
 * reached nothing. Which word the user happened to type silently decided
 * whether routing worked at all.
 */
const ringOf = new Map<string, string[]>();
{
  const merged: string[][] = [];
  for (const ring of RINGS) {
    const overlapping = merged.filter((m) => m.some((w) => ring.includes(w)));
    const union = new Set([...ring, ...overlapping.flat()]);
    for (const m of overlapping) merged.splice(merged.indexOf(m), 1);
    merged.push([...union]);
  }
  for (const ring of merged) for (const w of ring) ringOf.set(w, ring);
}

/** Corpus document frequency of a single normalized term (0 = absent). */
function df(store: Store, term: string): number {
  if (!/^[a-z0-9]+$/i.test(term)) return 1; // only plain words are safe in MATCH
  try {
    const r = store.db
      .prepare(`SELECT COUNT(*) c FROM blocks_fts WHERE blocks_fts MATCH ?`)
      .get(`"${term}"`) as { c: number };
    return r.c;
  } catch {
    return 1; // an unparsable term is not evidence of absence
  }
}

/**
 * Does the query carry any DEAD content term — a plain word of 3+ letters
 * with zero hits in this vault? This is the classic pre-retrieval
 * hardness signature (vocabulary mismatch): the user is describing the
 * vault in words the vault does not use, which is exactly when shallow
 * link expansion starves and a deeper walk pays for itself.
 */
export function hasDeadTerm(store: Store, qTerms: string[]): boolean {
  for (const term of qTerms) {
    if (term.length < 3) continue;
    if (!/^[a-z]+$/i.test(term)) continue; // numbers/dates are not vocabulary
    if (df(store, term) === 0) return true;
  }
  return false;
}

/**
 * In-corpus ring-mates for the query's DEAD terms (df = 0), capped so one
 * dead word cannot flood the OR query. Returns [] when every query word
 * exists in the vault — the common case costs one df probe per content term.
 */
export function expandDeadTerms(store: Store, qTerms: string[], maxPerTerm = 3): string[] {
  const out: string[] = [];
  for (const term of qTerms) {
    const ring = ringOf.get(term);
    if (!ring) continue;
    if (df(store, term) > 0) continue; // the user's word exists; it wins
    let added = 0;
    for (const mate of ring) {
      if (mate === term || out.includes(mate)) continue;
      if (df(store, mate) > 0) {
        out.push(mate);
        added++;
        if (added >= maxPerTerm) break;
      }
    }
  }
  return out;
}
