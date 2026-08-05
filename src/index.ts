/** Loreweave public API. */
export * from './types.js';
export { normalizeKey } from './normalize.js';
export { ConfigSchema, loadConfig, dbPath, LORE_DIR, type LoreConfig } from './config.js';
export { openStore, type Store, type LexicalHit } from './store/db.js';
export { parseNote, sha1 } from './vault/parse.js';
export { scanVault } from './vault/scan.js';
export { indexVault, type IndexOptions } from './index/indexer.js';
export { extractEntities } from './entities/extract.js';
export { buildGraph, type LoreGraph } from './graph/build.js';
export { ppr, type PprOptions } from './graph/ppr.js';
export {
  resolveProvider,
  embedMissingBlocks,
  denseTopK,
  buildSimilarEdges,
  cosine,
  type EmbeddingProvider,
} from './embed/index.js';
export {
  retrievability,
  reinforce,
  importanceHeuristic,
  daysBetween,
} from './dynamics/fsrs.js';
export { markUsed, resolveBlockIds, updateImportance } from './dynamics/usage.js';
export { search, matchQueryEntities, type SearchOptions } from './retrieve/search.js';
export {
  assertFact,
  invalidateFact,
  queryFacts,
  aggregateFacts,
  type AssertFactInput,
  type AssertFactResult,
  type FactQuery,
  type AggregateQuery,
} from './facts/model.js';
export {
  parseFactLines,
  renderFactLine,
  rebuildFactsFromNotes,
  recomputeSupersessions,
  isJournalPath,
  JOURNAL_DIR,
} from './facts/journal.js';
export { dream, renderDigest, renderReviewQueue, type DreamReport } from './dream/dream.js';
export { capture, readNoteRaw, safeVaultPath } from './capture.js';
export { openContext, type LoreContext } from './context.js';
