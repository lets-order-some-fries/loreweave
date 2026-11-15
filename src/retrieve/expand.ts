import type { Store } from '../store/db.js';
import { normalizeKey } from '../normalize.js';

/**
 * Note-level link expansion.
 *
 * PPR over blocks+entities is dominated by co-occurrence noise: a query
 * entity's mass leaks into every note that happens to name it. The vault's
 * *explicit* links are a far higher-precision signal, so this walks those
 * directly from the notes lexical retrieval already found confident.
 *
 * That is exactly the multi-hop case: the answer note shares no vocabulary
 * with the query, but is one or two links from a note that does.
 */

export interface NoteLinkGraph {
  /** note path → note paths it links to (resolved) */
  out: Map<string, string[]>;
  /** note path → note paths linking to it */
  in: Map<string, string[]>;
  /** normalized title/basename → note path, for "the query names this note" */
  byName: Map<string, string>;
}

/**
 * Seed weights for expansion.
 *
 * A note whose TITLE the query names is a far better hop origin than a note
 * that merely scores well lexically: "Coldspar Traverse hardware" is asking
 * about the Coldspar Traverse note's neighbourhood, even when some other note
 * happens to win BM25. Getting this wrong sends the walk down the wrong
 * branch entirely.
 */
export function seedNotes(
  graph: NoteLinkGraph,
  query: string,
  lexicalNotes: string[],
  max: number,
): { notePath: string; weight: number }[] {
  const named = new Set<string>();
  const tokens = normalizeKey(query).split(' ').filter(Boolean);
  for (let len = Math.min(5, tokens.length); len >= 1; len--) {
    for (let i = 0; i + len <= tokens.length; i++) {
      const gram = tokens.slice(i, i + len).join(' ');
      // single common words are not note references
      if (len === 1 && gram.length < 4) continue;
      const path = graph.byName.get(gram);
      if (path) named.add(path);
    }
  }
  // When the query names notes explicitly, expand from ONLY those: mixing in
  // lexical seeds sends the walk down unrelated branches whose neighbours
  // then outrank the real answer. Lexical seeds are the fallback for queries
  // that name nothing.
  if (named.size > 0) {
    return [...named].slice(0, max).map((notePath) => ({ notePath, weight: 1 }));
  }
  const out: { notePath: string; weight: number }[] = [];
  let rank = 0;
  for (const p of lexicalNotes) {
    rank++;
    out.push({ notePath: p, weight: 0.35 / (rank + 1) });
    if (out.length >= max) break;
  }
  return out;
}

/**
 * Every name a note answers to → the notes that answer to it.
 *
 * A name is not unique. Two projects both having an `overview.md`, or two notes
 * both titled "Notes", is the ordinary shape of a vault with per-topic folders.
 */
export function buildNameIndex(
  notes: { path: string; title: string }[],
): Map<string, string[]> {
  const out = new Map<string, string[]>();
  // Membership via a parallel Set, not `arr.includes`: a vault with one
  // README.md per folder puts every one of them in a single bucket, and the
  // linear rescan per insert made building the index quadratic in the size of
  // the largest colliding name.
  const members = new Map<string, Set<string>>();
  const add = (key: string, path: string) => {
    if (!key) return;
    const arr = out.get(key);
    if (arr) {
      const seen = members.get(key)!;
      if (!seen.has(path)) {
        seen.add(path);
        arr.push(path);
      }
    } else {
      out.set(key, [path]);
      members.set(key, new Set([path]));
    }
  };
  for (const n of notes) {
    add(normalizeKey(n.title), n.path);
    add(normalizeKey(n.path), n.path);
    add(normalizeKey(n.path.split('/').pop() ?? n.path), n.path);
  }
  for (const arr of out.values()) arr.sort();
  return out;
}

/**
 * Precomputed answers for the ambiguous names in a name index.
 *
 * name → (directory prefix → the note under that prefix this name resolves to).
 */
export type NameResolver = Map<string, Map<string, string>>;

/**
 * Turn the "nearest note wins" rule into a lookup.
 *
 * Scanning every candidate for every link is quadratic in the size of the
 * colliding bucket, and the buckets that collide are exactly the ones every
 * note links to: one README.md or index.md per folder, one SKILL.md per skill.
 * A 20,000-note handbook with a README per section spent ten seconds per
 * search inside that scan — invisible to eval/scale.mjs, which only ever
 * generates uniquely-named notes.
 *
 * Registering each candidate under every prefix of its own directory turns the
 * scan into "walk down the linking note's directory while the prefix still
 * matches something". Keeping the lexicographically smallest path per prefix
 * reproduces the old tie-break, which took the first of the sorted bucket.
 */
export function buildNameResolver(candidates: Map<string, string[]>): NameResolver {
  const resolver: NameResolver = new Map();
  for (const [name, arr] of candidates) {
    if (arr.length < 2) continue; // unambiguous names never reach the scan
    const byPrefix = new Map<string, string>();
    for (const path of arr) {
      const dirs = path.split('/');
      dirs.pop();
      let prefix = '';
      for (let k = 0; ; k++) {
        const cur = byPrefix.get(prefix);
        if (cur === undefined || path < cur) byPrefix.set(prefix, path);
        if (k >= dirs.length) break;
        prefix = k === 0 ? dirs[0]! : `${prefix}/${dirs[k]!}`;
      }
    }
    resolver.set(name, byPrefix);
  }
  return resolver;
}

/**
 * Resolve a link target to a note, preferring the one nearest the note doing
 * the linking.
 *
 * The index used to be one path per name, so two notes sharing a title meant
 * the last one enumerated won and BOTH links pointed at it — `[[Overview]]`
 * written inside `projects/atlas/` could resolve to `projects/northwind/`,
 * silently, and searching for something only Atlas says would surface
 * Northwind's notes through the borrowed edge.
 *
 * Nearest means the longest shared directory prefix, which is what a link
 * inside a folder means by any reading, and what other markdown tools do.
 * Ties fall back to the sorted order so the graph is at least stable.
 *
 * Pass `resolver` (from `buildNameResolver`) when resolving many links against
 * one index: without it every ambiguous name is rescanned per link.
 */
export function resolveNoteName(
  candidates: Map<string, string[]>,
  target: string,
  from: string,
  resolver?: NameResolver,
): string | undefined {
  const arr = candidates.get(target);
  if (!arr || arr.length === 0) return undefined;
  if (arr.length === 1) return arr[0];
  const byPrefix = resolver?.get(target);
  if (byPrefix) {
    const dirs = from.split('/');
    dirs.pop();
    let prefix = '';
    let best = byPrefix.get('')!;
    for (let k = 0; k < dirs.length; k++) {
      prefix = k === 0 ? dirs[0]! : `${prefix}/${dirs[k]!}`;
      // Nothing shares this prefix, so nothing shares a longer one either.
      const hit = byPrefix.get(prefix);
      if (hit === undefined) break;
      best = hit;
    }
    return best;
  }
  const fromDirs = from.split('/').slice(0, -1);
  let best = arr[0]!;
  let bestShared = -1;
  for (const path of arr) {
    const dirs = path.split('/').slice(0, -1);
    let shared = 0;
    while (shared < dirs.length && shared < fromDirs.length && dirs[shared] === fromDirs[shared]) {
      shared++;
    }
    if (shared > bestShared) {
      bestShared = shared;
      best = path;
    }
  }
  return best;
}

/** Build the resolved note→note link graph (both directions). */
export function buildNoteLinkGraph(store: Store): NoteLinkGraph {
  const notes = store.db.prepare(`SELECT path, title FROM notes`).all() as {
    path: string;
    title: string;
  }[];
  const candidates = buildNameIndex(notes);
  const resolver = buildNameResolver(candidates);
  // One representative per name, for the "the query names this note" seed.
  // Sorted, so an ambiguous name at least picks the same note every run.
  const byKey = new Map<string, string>();
  for (const [k, paths] of candidates) byKey.set(k, paths[0]!);
  const out = new Map<string, string[]>();
  const inn = new Map<string, string[]>();
  const seen = new Set<string>();
  const links = store.db.prepare(`SELECT DISTINCT note_path, target_norm FROM links`).all() as {
    note_path: string;
    target_norm: string;
  }[];
  for (const l of links) {
    const dst = resolveNoteName(candidates, l.target_norm, l.note_path, resolver);
    if (!dst || dst === l.note_path) continue;
    const key = `${l.note_path}\u0000${dst}`;
    if (seen.has(key)) continue;
    seen.add(key);
    (out.get(l.note_path) ?? out.set(l.note_path, []).get(l.note_path)!).push(dst);
    (inn.get(dst) ?? inn.set(dst, []).get(dst)!).push(l.note_path);
  }
  return { out, in: inn, byName: byKey };
}

export interface ExpansionOptions {
  /** How many seed notes to expand from. */
  seeds?: number;
  /** Hops to walk (1 or 2). */
  hops?: number;
  /** Score multiplier per hop. */
  decay?: number;
  /** Ignore hub notes linking to more than this many notes (indexes/MOCs). */
  hubCap?: number;
}

/**
 * Walk out from `seedNotes` along links, returning note → expansion score.
 * Seeds themselves are excluded: they are already ranked lexically, and the
 * point of expansion is to surface what lexical search cannot see.
 */
export function expandNotes(
  graph: NoteLinkGraph,
  seedNotes: { notePath: string; weight: number }[],
  opts: ExpansionOptions = {},
): Map<string, number> {
  const hops = opts.hops ?? 2;
  const decay = opts.decay ?? 0.45;
  const hubCap = opts.hubCap ?? 40;

  const scores = new Map<string, number>();
  const seeds = new Set(seedNotes.map((s) => s.notePath));
  let frontier = new Map<string, number>();
  for (const s of seedNotes) {
    frontier.set(s.notePath, Math.max(frontier.get(s.notePath) ?? 0, s.weight));
  }

  const visited = new Set<string>(frontier.keys());
  for (let hop = 1; hop <= hops; hop++) {
    const next = new Map<string, number>();
    for (const [note, w] of frontier) {
      const neighbours = [...(graph.out.get(note) ?? []), ...(graph.in.get(note) ?? [])];
      // A note linking to everything (an index/MOC) says nothing about
      // which of its targets is relevant.
      if (neighbours.length > hubCap) continue;
      const share = (w * Math.pow(decay, hop)) / Math.max(1, Math.sqrt(neighbours.length));
      for (const nb of neighbours) {
        if (seeds.has(nb)) continue;
        next.set(nb, (next.get(nb) ?? 0) + share);
        scores.set(nb, (scores.get(nb) ?? 0) + share);
      }
    }
    // only continue outward from newly discovered notes
    for (const k of next.keys()) {
      if (visited.has(k)) next.delete(k);
      else visited.add(k);
    }
    if (next.size === 0) break;
    frontier = next;
  }
  return scores;
}
