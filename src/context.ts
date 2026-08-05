import { loadConfig, dbPath, type LoreConfig } from './config.js';
import { openStore, type Store } from './store/db.js';
import { resolveProvider, type EmbeddingProvider } from './embed/index.js';
import { buildGraph, type LoreGraph } from './graph/build.js';
import { buildNoteLinkGraph, type NoteLinkGraph } from './retrieve/expand.js';

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
  const config = loadConfig(root);
  const store = openStore(overrides?.dbFile ?? dbPath(root));
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
