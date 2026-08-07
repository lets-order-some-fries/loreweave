import { statSync } from 'node:fs';
import { loadConfig, dbPath, type LoreConfig } from './config.js';
import { openStore, type Store } from './store/db.js';
import { resolveProvider, type EmbeddingProvider } from './embed/index.js';
import { buildGraph, type LoreGraph } from './graph/build.js';
import { buildNoteLinkGraph, type NoteLinkGraph } from './retrieve/expand.js';
import { indexVault } from './index/indexer.js';
import { scanVault } from './vault/scan.js';

/** Shared runtime handle passed to retrieval, facts, dream, CLI, MCP. */
export interface LoreContext {
  root: string;
  config: LoreConfig;
  store: Store;
  provider: EmbeddingProvider | null;
  /** Lazily built + cached graph; invalidate after indexing. */
  graph(): LoreGraph;
  /** Lazily built + cached note→note link graph; same invalidation. */
  noteLinks(): NoteLinkGraph;
  invalidateGraph(): void;
  close(): void;
}

export function openContext(root: string, overrides?: { dbFile?: string }): LoreContext {
  // A typo'd --vault should say so. Left to the store, it surfaced as
  // `ENOENT: no such file or directory, mkdir '/nope/.lore'` — a raw errno
  // naming an internal directory the user has never heard of, for a mistake
  // they made in the argument they can see.
  let stat;
  try {
    stat = statSync(root);
  } catch {
    throw new Error(`vault not found: ${root}`);
  }
  if (!stat.isDirectory()) throw new Error(`vault is not a directory: ${root}`);
  const config = loadConfig(root);
  const store = openStore(overrides?.dbFile ?? dbPath(root), {
    onHeal: (msg) => console.error(`[loreweave] ${msg}`),
  });
  let provider: EmbeddingProvider | null = null;
  let providerError: string | null = null;
  try {
    provider = resolveProvider(config);
  } catch (err) {
    providerError = (err as Error).message;
    provider = null;
  }
  if (providerError) {
    // degrade to lexical+graph, but tell the user once
    console.error(`[loreweave] embeddings disabled: ${providerError}`);
  }
  let cached: LoreGraph | null = null;
  let cachedLinks: NoteLinkGraph | null = null;
  return {
    root,
    config,
    store,
    provider,
    graph() {
      if (!cached) cached = buildGraph(store, config);
      return cached;
    },
    noteLinks() {
      if (!cachedLinks) cachedLinks = buildNoteLinkGraph(store);
      return cachedLinks;
    },
    invalidateGraph() {
      cached = null;
      cachedLinks = null;
    },
    close() {
      store.close();
    },
  };
}

/**
 * Index the vault if the index is empty but the vault is not.
 *
 * Without this, the very first thing a new user does produces the worst answer
 * a knowledge tool can give. `lore search` in a vault of 39 notes replied "no
 * results" — indistinguishable from a genuine miss, at the one moment they
 * have no way to tell the difference. Every command lied the same way except
 * `doctor`, which alone said "last index: never".
 *
 * An agent over MCP has it worse: it receives an empty array and reports,
 * confidently, that the user has nothing written on the subject. There is no
 * error to notice and nothing to retry.
 *
 * Commands that report on the INDEX rather than answer from it — `doctor`,
 * `stats`, `index` — deliberately do not call this: their job is to show the
 * true state, including that it is empty.
 *
 * Costs one scan the first time and nothing afterwards.
 */
export async function ensureIndexed(
  ctx: LoreContext,
  onFirstIndex?: (noteCount: number) => void,
): Promise<boolean> {
  const row = ctx.store.db.prepare('SELECT COUNT(*) c FROM notes').get() as { c: number };
  if (row.c > 0) return false;
  const files = await scanVault(ctx.root, ctx.config.ignore);
  if (files.length === 0) return false; // genuinely empty vault: "no results" is true
  onFirstIndex?.(files.length);
  await indexVault(ctx.store, ctx.root, {
    factExtract: ctx.config.facts.extract,
    nlp: ctx.config.nlp,
  });
  ctx.invalidateGraph();
  return true;
}
