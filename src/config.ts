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
            lexical: z.number().default(1.0),
            dense: z.number().default(1.0),
            graph: z.number().default(0.8),
          })
          .default({}),
        boosts: z
          .object({
            retrievability: z.number().default(0.15),
            importance: z.number().default(0.15),
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
          })
          .default({}),
        maxEntitiesPerBlockCooccur: z.number().int().default(12),
        similarThreshold: z.number().min(0).max(1).default(0.8),
        similarTopK: z.number().int().min(1).max(50).default(5),
      })
      .default({}),
    nlp: z.boolean().default(true),
    ignore: z.array(z.string()).default([]),
  })
  .default({});

export type LoreConfig = z.infer<typeof ConfigSchema>;

export const LORE_DIR = '.lore';

/** Load .lore/config.json (missing file → defaults; invalid → throws with detail). */
export function loadConfig(vaultRoot: string): LoreConfig {
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
