import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { z } from 'zod';

export const ConfigSchema = z
  .object({
    embedding: z
      .object({
        provider: z.enum(['none', 'ollama', 'openai']).default('none'),
        model: z.string().default('nomic-embed-text'),
        url: z.string().default('http://localhost:11434'),
        /** Name of the env var holding the API key (never the key itself). */
        apiKeyEnv: z.string().default('OPENAI_API_KEY'),
        batchSize: z.number().int().min(1).max(512).default(32),
        /**
         * Task prefixes for instruction-tuned embedding models.
         *
         * Asymmetric retrieval models are TRAINED with a task prefix and are
         * out of distribution without one — nomic-embed-text wants
         * "search_query: " on queries and "search_document: " on passages,
         * E5 wants "query: "/"passage: ". Omitted, both sides get embedded as
         * if they were the same kind of text, which is exactly the condition
         * that made the dense channel LOWER retrieval quality here (0.31.0).
         * Left unset, they are inferred from the model name; set them to ""
         * to force none, or to your model's own strings.
         */
        queryPrefix: z.string().optional(),
        documentPrefix: z.string().optional(),
      })
      .default({}),
    retrieval: z
      .object({
        k: z.number().int().min(1).max(100).default(8),
        candidates: z.number().int().min(10).max(500).default(40),
        pprAlpha: z.number().min(0).max(1).default(0.5),
        pprIterations: z.number().int().min(1).max(20).default(2),
        rrfK: z.number().min(1).default(60),
        weights: z
          .object({
            /** True weights: scale each list's contribution to the RRF sum. */
            lexical: z.number().default(1.0),
            dense: z.number().default(1.0),
            /**
             * Pseudo-relevance feedback: a second lexical pass over terms the
             * top results share. Fused BELOW the user's own words on purpose —
             * it may add evidence, never outvote the query. 0 disables.
             */
            prf: z.number().default(0.4),
            /**
             * ON/OFF, not a weight, despite the name and the company it keeps.
             *
             * Entity-PPR and link expansion are recall mechanisms: they add
             * notes nothing else found, spliced in by position, and never
             * compete on score. Measured, treating expansion as a peer ranking
             * list moved MRR 0.489 -> 0.208, because a note reached by one
             * link outranked an exact lexical match. So only `> 0` is read and
             * the magnitude is discarded.
             *
             * This field used to default to 0.35 and describe itself as
             * "weighted below lexical", which is a weighting that does not
             * happen — setting 0.7 expecting more graph influence changed
             * nothing at all. The default is 1 so the number matches what the
             * code does with it.
             */
            graph: z.number().default(1.0),
            /** ON/OFF, for the same reason as `graph`. */
            expansion: z.number().default(1.0),
          })
          .default({}),
        /** How many top lexical notes to expand links from. */
        expansionSeeds: z.number().int().min(1).max(20).default(5),
        /** Link-expansion depth. 2 finds every two-hop answer (multihop reach
         *  100% on the eval) at a measured precision cost in dense vaults;
         *  the shipped default keeps precision. */
        expansionHops: z.number().int().min(1).max(3).default(1),
        expansionDecay: z.number().min(0).max(1).default(0.45),
        /** Expansion results slot in after this many fused results. */
        expansionPromoteAfter: z.number().int().min(0).max(50).default(2),
        /** Return one result per note, choosing that note's most relevant block. */
        oneBlockPerNote: z.boolean().default(true),
        boosts: z
          .object({
            retrievability: z.number().default(0.15),
            importance: z.number().default(0.15),
            /** Boost for blocks whose content time overlaps a window the query
             *  itself names ("in March 2025"). Soft emphasis, never a filter:
             *  a query mentioning a year is not always about that year. */
            temporal: z.number().default(0.3),
            /** Recency preference when the query asks about NOW ("current
             *  status", "where does X live now"). Applies only to blocks with
             *  real content dates, newest scaled to the full boost. */
            recency: z.number().default(0.3),
            /** Term-proximity bonus: blocks preserving the query's word
             *  order ("ledger migration" as a phrase) outrank blocks with
             *  the same words scattered (sequential-dependence signal). */
            proximity: z.number().default(0.1),
          })
          .default({}),
      })
      .default({}),
    graph: z
      .object({
        edgeWeights: z
          .object({
            LINK: z.number().default(1.0),
            MENTION: z.number().default(0.7),
            COOCCUR: z.number().default(0.4),
            SIMILAR: z.number().default(0.8),
            TAG: z.number().default(0.5),
            /** Same-entity edges: declared frontmatter aliases and
             *  acronym ↔ expansion pairs. High weight on purpose — these are
             *  identity claims, not co-occurrence evidence. */
            SAMEAS: z.number().default(0.9),
            /** Fact edges: subject ↔ object of currently-valid facts. The
             *  strongest relational evidence the vault has — a stated or
             *  extracted relation, not a co-occurrence guess. */
            FACT: z.number().default(1.0),
          })
          .default({}),
        maxEntitiesPerBlockCooccur: z.number().int().default(12),
        similarThreshold: z.number().min(0).max(1).default(0.8),
        similarTopK: z.number().int().min(1).max(50).default(5),
      })
      .default({}),
    facts: z
      .object({
        /**
         * explicit: frontmatter + `key:: value` + `- [key] value` (default).
         * all: also mine `- **Key:** value` / `- Key: value` prose formatting.
         * off: only `- [fact]` lines you or an agent wrote.
         */
        extract: z.enum(['explicit', 'all', 'off']).default('explicit'),
      })
      .default({}),
    nlp: z.boolean().default(true),
    ignore: z.array(z.string()).default([]),
    /**
     * Rows of retrieval history to keep. Everything else in the index is
     * derivable from the markdown and can be rebuilt by deleting `.lore`; this
     * table is not, and nothing pruned it. Measured: five rows per search, one
     * per result, each carrying the full query text — an agent searching 200
     * times a day accumulates ~365 000 rows a year of a log nothing reads
     * except a COUNT, and which no command shows the user.
     *
     * Bounded rather than removed: the count is a real activity signal, and a
     * recent window is the part with any use in it. Set to 0 to keep none.
     */
    accessLogRows: z.number().int().min(0).default(5000),
  })
  .default({});

export type LoreConfig = z.infer<typeof ConfigSchema>;

export const LORE_DIR = '.lore';

/** Load .lore/config.json (missing file → defaults; invalid → throws with detail). */
/**
 * Every key path a config may contain, derived from a fully-defaulted parse
 * rather than from the schema's internals — so it stays correct on its own as
 * the schema changes. Arrays are leaves.
 */
function knownConfigPaths(): Set<string> {
  const out = new Set<string>();
  const walk = (o: unknown, prefix: string) => {
    if (!o || typeof o !== 'object' || Array.isArray(o)) return;
    for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
      const path = prefix ? `${prefix}.${k}` : k;
      out.add(path);
      walk(v, path);
    }
  };
  walk(ConfigSchema.parse({}), '');
  return out;
}

/**
 * Report config keys that will be ignored.
 *
 * Zod strips unknown keys rather than rejecting them, so a typo or a wrong
 * nesting level was accepted in silence and simply did nothing: `"nlpp": false`
 * left NLP running, and `{"index": {"nlp": false}}` — a very natural guess,
 * and one I made myself while working on this code — was discarded whole.
 * Config is the worst possible place for that, because the user edits a file
 * by hand and gets no feedback at all that they missed.
 *
 * A warning, not an error: refusing to start over an unrecognised key would
 * mean a config written for a newer version bricks an older one.
 */
function unknownConfigPaths(json: unknown): string[] {
  const known = knownConfigPaths();
  const out: string[] = [];
  const walk = (o: unknown, prefix: string) => {
    if (!o || typeof o !== 'object' || Array.isArray(o)) return;
    for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
      const path = prefix ? `${prefix}.${k}` : k;
      if (!known.has(path)) {
        out.push(path);
        continue; // do not descend: everything under it is unknown too
      }
      walk(v, path);
    }
  };
  walk(json, '');
  return out;
}

export function loadConfig(vaultRoot: string, onWarn?: (msg: string) => void): LoreConfig {
  let raw: string;
  try {
    raw = readFileSync(join(vaultRoot, LORE_DIR, 'config.json'), 'utf8');
  } catch {
    return ConfigSchema.parse({});
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw new Error(`.lore/config.json is not valid JSON: ${(err as Error).message}`);
  }
  const res = ConfigSchema.safeParse(json);
  if (!res.success) {
    throw new Error(`.lore/config.json invalid: ${res.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  }
  if (onWarn) {
    const unknown = unknownConfigPaths(json);
    if (unknown.length) {
      onWarn(
        `.lore/config.json: ignoring unrecognised ${unknown.length === 1 ? 'key' : 'keys'} ` +
          `${unknown.join(', ')} — check spelling and nesting`,
      );
    }
  }
  return res.data;
}

export function dbPath(vaultRoot: string): string {
  return join(vaultRoot, LORE_DIR, 'index.db');
}

/** Walk up from `start` looking for a .lore directory; fall back to `start`. */
export function findVaultRoot(start: string): string {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, LORE_DIR))) return dir;
    const parent = resolve(dir, '..');
    if (parent === dir) return resolve(start);
    dir = parent;
  }
}
