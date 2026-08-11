/** Loreweave public API. */
export * from './types.js';
export {
  normalizeKey,
  singularizeKey,
  contentTerms,
  resolveRelative,
  linkMatchKey,
  STOPWORDS,
} from './normalize.js';
export { ConfigSchema, loadConfig, dbPath, LORE_DIR, type LoreConfig } from './config.js';
export { openStore, verifyOrReset, type Store, type LexicalHit } from './store/db.js';
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
export { search, matchQueryEntities, bestSnippet, type SearchOptions } from './retrieve/search.js';
export {
  buildNoteLinkGraph,
  expandNotes,
  type NoteLinkGraph,
  type ExpansionOptions,
} from './retrieve/expand.js';
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
export { watchVault, type Watcher, type WatchOptions } from './watch.js';
export { isDerivedNote } from './vault/scan.js';
export {
  extractFactsFromNote,
  type ExtractedFact,
  type ExtractionMode,
} from './facts/extract.js';
export { parseQueryTime, parseDateExpression, extractDates } from './temporal/dates.js';
export { buildTimeline, type TimelineEntry, type TimelineOptions } from './temporal/timeline.js';
