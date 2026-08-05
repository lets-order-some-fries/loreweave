/**
 * Shared domain types for Loreweave.
 *
 * The vault (markdown files) is the source of truth; everything else is a
 * derived, rebuildable index. Every derived record carries provenance back
 * to a file path + block anchor + content hash.
 */

/** A wiki-link found in a block: [[Target]], [[Target|alias]], [[Target#Heading]]. */
export interface WikiLink {
  /** Raw text inside the brackets, e.g. "Target#Heading|alias". */
  raw: string;
  /** Link target note title/path (without heading or alias). */
  target: string;
  /** Optional heading fragment after '#'. */
  heading?: string;
  /** Optional display alias after '|'. */
  alias?: string;
  /** Anchor of the block the link occurs in. */
  blockAnchor: string;
  /** How it was written: `[[wiki]]` or `[md](path.md)`. */
  style: 'wiki' | 'markdown';
}

/** A heading-bounded chunk of a note; the retrieval unit. */
export interface Block {
  /** Stable anchor: `<heading path>@<n>` where n disambiguates splits. */
  anchor: string;
  /** Heading breadcrumb, e.g. "Overview/Details" ("" for preamble). */
  heading: string;
  /** Order of the block within the note (0-based). */
  order: number;
  /** Plain text content (markdown, without the heading line). */
  text: string;
  /** sha1 of text. */
  hash: string;
}

/** A parsed markdown note. */
export interface Note {
  /** Vault-relative path with forward slashes, e.g. "projects/loreweave.md". */
  path: string;
  /** Title: frontmatter `title` if present, else file basename. */
  title: string;
  /** Parsed frontmatter (empty object if none/invalid). */
  frontmatter: Record<string, unknown>;
  /** Tags from frontmatter `tags` + inline #tags, normalized, deduped. */
  tags: string[];
  /** All wiki-links in the note. */
  links: WikiLink[];
  blocks: Block[];
  /** sha1 over the raw file content. */
  hash: string;
  mtimeMs: number;
  /** Non-fatal parse warnings (bad frontmatter etc.). */
  warnings: string[];
}

/** A file discovered by the vault scanner. */
export interface VaultFile {
  /** Vault-relative path, forward slashes. */
  path: string;
  /** Absolute path on disk. */
  absPath: string;
  mtimeMs: number;
}

/** An entity mention inside a block. */
export interface EntityMention {
  /** Normalized entity key (see normalizeEntity). */
  key: string;
  /** Display form as first seen. */
  display: string;
  /** Where the mention came from. */
  source: 'link' | 'tag' | 'frontmatter' | 'nlp';
  /** Extraction confidence 0..1 (link 1.0, tag/frontmatter 0.9, nlp 0.6). */
  confidence: number;
  /** Block anchor the mention occurs in ("" = note-level, e.g. frontmatter). */
  blockAnchor: string;
}

/** Edge types of the knowledge graph (relation-free by design). */
export type EdgeType = 'LINK' | 'MENTION' | 'COOCCUR' | 'SIMILAR' | 'TAG';

/** Bitemporal fact: an atomic proposition with validity + record time. */
export interface Fact {
  id: number;
  /** Normalized subject key. */
  subject: string;
  predicate: string;
  object: string;
  /** Display (un-normalized) forms. */
  subjectDisplay: string;
  /** Valid time: when the fact holds in the world (ISO date or datetime). */
  validFrom: string | null;
  validUntil: string | null;
  /** Transaction time: when the system recorded / superseded it (ISO datetime). */
  recordedAt: string;
  supersededAt: string | null;
  supersededBy: number | null;
  /** stated: user-asserted; extracted: parsed from a note; inferred: derived. */
  sourceType: 'stated' | 'extracted' | 'inferred';
  /** Provenance: note path + block anchor ("" when asserted via journal write). */
  notePath: string | null;
  blockAnchor: string | null;
  confidence: number;
}

/** Typed relation between fact versions (Supermemory's minimal ontology). */
export type FactLinkType = 'updates' | 'extends' | 'derives';

export interface SearchResult {
  notePath: string;
  anchor: string;
  heading: string;
  snippet: string;
  /** Final fused score (higher is better). */
  score: number;
  /** Score components for explainability. */
  parts: {
    lexical: number;
    dense: number;
    graph: number;
    retrievability: number;
    importance: number;
  };
  /** Entities connecting this result to the query (graph explanation). */
  via: string[];
}

/** Report from an indexing run. */
export interface IndexReport {
  added: number;
  updated: number;
  removed: number;
  unchanged: number;
  warnings: string[];
  durationMs: number;
}
