import { createHash } from 'node:crypto';
import matter from 'gray-matter';
import type { Block, Note, WikiLink } from '../types.js';

const MAX_BLOCK_WORDS = 350;
/** ~MAX_BLOCK_WORDS of ordinary English prose, used when words run out. */
const MAX_BLOCK_CHARS = 4000;

export function sha1(text: string): string {
  return createHash('sha1').update(text, 'utf8').digest('hex');
}

/** Blank out fenced and inline code so links inside code are not parsed. */
function maskCode(text: string): string {
  return text
    .replace(/```[\s\S]*?(?:```|$)/g, (m) => ' '.repeat(m.length))
    .replace(/~~~[\s\S]*?(?:~~~|$)/g, (m) => ' '.repeat(m.length))
    .replace(/`[^`\n]*`/g, (m) => ' '.repeat(m.length));
}

/** Decode %20-style escapes in markdown link targets; tolerate bad encoding. */
function decodeTarget(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/**
 * Extract links from a text region: `[[wiki links]]` AND relative markdown
 * links to other notes (`[text](../notes/thing.md#heading)`). Most real vaults
 * outside Obsidian use the markdown form exclusively — ignoring it leaves the
 * knowledge graph with almost no edges.
 */
function extractLinks(rawText: string, blockAnchor: string): WikiLink[] {
  const out: WikiLink[] = [];
  const text = maskCode(rawText);

  // --- markdown links: [alias](target.md#heading) ---
  // Only relative links to .md files (or bare relative paths without a
  // scheme) count as note links; http(s), mailto, images and anchors do not.
  const mdRe = /(!?)\[([^\]\n]*)\]\(([^()\s]+)(?:\s+"[^"]*")?\)/g;
  let md: RegExpExecArray | null;
  while ((md = mdRe.exec(text)) !== null) {
    if (md[1] === '!') continue; // image
    const alias = (md[2] ?? '').trim();
    let href = (md[3] ?? '').trim();
    if (!href || /^[a-z][a-z0-9+.-]*:/i.test(href)) continue; // scheme → external
    if (href.startsWith('#')) continue; // in-page anchor
    let heading: string | undefined;
    const hash = href.indexOf('#');
    if (hash >= 0) {
      heading = decodeTarget(href.slice(hash + 1)).trim() || undefined;
      href = href.slice(0, hash);
    }
    href = decodeTarget(href).replace(/^\.\//, '');
    if (!href) continue;
    if (!/\.md$/i.test(href)) continue; // only markdown note targets
    out.push({
      raw: md[0] ?? '',
      target: href,
      heading,
      alias: alias || undefined,
      blockAnchor,
      style: 'markdown',
    });
  }

  // --- wiki links: [[target]], [[target|alias]], [[target#heading]] ---
  const re = /\[\[([^\[\]]+?)\]\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const raw = (m[1] ?? '').trim();
    if (!raw) continue;
    let rest = raw;
    let alias: string | undefined;
    const pipe = rest.indexOf('|');
    if (pipe >= 0) {
      alias = rest.slice(pipe + 1).trim() || undefined;
      rest = rest.slice(0, pipe);
    }
    let heading: string | undefined;
    const hash = rest.indexOf('#');
    if (hash >= 0) {
      heading = rest.slice(hash + 1).trim() || undefined;
      rest = rest.slice(0, hash);
    }
    const target = rest.trim();
    if (!target && !heading) continue;
    out.push({ raw, target, heading, alias, blockAnchor, style: 'wiki' });
  }
  return out;
}

/** Inline #tags (not headings, not URL fragments). */
function extractInlineTags(text: string): string[] {
  const tags = new Set<string>();
  // A tag: '#' preceded by start/whitespace/'(' and followed by a word char;
  // allows letters, digits, -, _, / and unicode letters.
  const re = /(^|[\s(])#([\p{L}\p{N}][\p{L}\p{N}_\/-]*)/gmu;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const tag = (m[2] ?? '').toLowerCase();
    // pure-numeric "tags" are almost always headings/issue refs, skip
    if (!/^\d+$/.test(tag)) tags.add(tag);
  }
  return [...tags];
}

function normalizeTag(t: unknown): string | null {
  if (typeof t !== 'string' && typeof t !== 'number') return null;
  const s = String(t).trim().replace(/^#/, '').toLowerCase();
  return s ? s : null;
}

interface RawSection {
  headingPath: string[];
  lines: string[];
}

/** Split markdown body into heading-bounded sections (preamble first). */
function splitSections(body: string): RawSection[] {
  const lines = body.split(/\r?\n/);
  const sections: RawSection[] = [{ headingPath: [], lines: [] }];
  const stack: { level: number; title: string }[] = [];
  let inFence = false;
  for (const line of lines) {
    const fence = line.match(/^(```|~~~)/);
    if (fence) inFence = !inFence;
    const h = !inFence ? line.match(/^(#{1,6})\s+(.*)$/) : null;
    if (h) {
      const level = (h[1] ?? '').length;
      const title = (h[2] ?? '').trim().replace(/\s+#+\s*$/, '');
      while (stack.length && (stack[stack.length - 1]?.level ?? 0) >= level) stack.pop();
      stack.push({ level, title });
      sections.push({ headingPath: stack.map((s) => s.title), lines: [] });
    } else {
      sections[sections.length - 1]!.lines.push(line);
    }
  }
  return sections;
}

/**
 * Split at a character boundary, never inside a surrogate pair — a lone
 * surrogate is not valid UTF-8 and corrupts the text on its way to SQLite.
 */
function hardSplit(s: string): string[] {
  if (s.length <= MAX_BLOCK_CHARS) return [s];
  const out: string[] = [];
  let i = 0;
  while (i < s.length) {
    let end = Math.min(i + MAX_BLOCK_CHARS, s.length);
    const code = s.charCodeAt(end);
    if (end < s.length && code >= 0xdc00 && code <= 0xdfff) end -= 1;
    out.push(s.slice(i, end));
    i = end;
  }
  return out;
}

/**
 * Hard-split a single oversized paragraph. Without this, MAX_BLOCK_WORDS is
 * only advisory — a pasted log or CSV with no blank lines becomes one enormous
 * block, and everything downstream (FTS snippets, shingling, embedding)
 * degrades from fast to unusable. Measured before this cap: a 1 MB
 * single-paragraph note made `search` take 30 seconds.
 *
 * The word cap alone is measured in the wrong unit for the very case it exists
 * for. A base64 image, a minified payload, an Excalidraw drawing or a CJK
 * paragraph is ONE "word" that can be megabytes long, so `words.length <= 350`
 * passes and the block stays unbounded. Hence the character cap too.
 */
function splitLongParagraph(p: string): string[] {
  const words = p.split(/\s+/);
  if (words.length <= MAX_BLOCK_WORDS) return hardSplit(p);
  const out: string[] = [];
  for (let i = 0; i < words.length; i += MAX_BLOCK_WORDS) {
    out.push(words.slice(i, i + MAX_BLOCK_WORDS).join(' '));
  }
  return out.flatMap(hardSplit);
}

/** Split section text into ~MAX_BLOCK_WORDS chunks, preferring paragraph borders. */
function chunkText(text: string): string[] {
  const paras = text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean)
    .flatMap(splitLongParagraph);
  if (paras.length === 0) return [];
  const chunks: string[] = [];
  let current: string[] = [];
  let words = 0;
  let chars = 0;
  for (const p of paras) {
    const w = p.split(/\s+/).length;
    // Both budgets, for the same reason the split above needs both: one
    // hundred 4 000-character wordless paragraphs count as one hundred words
    // and would be merged straight back into the block we just split apart.
    if (words > 0 && (words + w > MAX_BLOCK_WORDS || chars + p.length > MAX_BLOCK_CHARS)) {
      chunks.push(current.join('\n\n'));
      current = [];
      words = 0;
      chars = 0;
    }
    current.push(p);
    words += w;
    chars += p.length;
  }
  if (current.length) chunks.push(current.join('\n\n'));
  return chunks;
}

/**
 * Filenames that describe a file's ROLE in its folder rather than naming a
 * thing. A vault can hold dozens of these, and treating them all as the same
 * title collapses them into one entity and one fact subject — measured on a
 * real corpus, 39 separate `SKILL.md` files produced a single subject whose
 * facts then superseded each other arbitrarily.
 */
const GENERIC_BASENAMES = new Set([
  'readme', 'index', '_index', 'skill', 'home', 'notes', 'note', 'main',
  'overview', 'about', 'summary', 'doc', 'docs', 'contents', 'toc', 'claude',
  'agents', 'default',
]);


/**
 * YAML turns a bare `started: 2025-03-01` into a Date, and the frontmatter is
 * stored as JSON — so by the time anything reads it back it is the string
 * "2025-03-01T00:00:00.000Z", a timestamp with a timezone the user never
 * wrote. Downstream that became the literal object of a fact, so
 * `count --predicate started` grouped by an instant instead of a day.
 *
 * Normalising here rather than at each reader is deliberate: a guard for this
 * already existed in the fact extractor and was dead, because it tested
 * `instanceof Date` on a value JSON had already turned into a string. The
 * index should simply hold what the vault says.
 *
 * A date-only YAML value lands exactly on midnight UTC; anything with a real
 * time component keeps its full ISO form.
 */
function normalizeFrontmatterValue(v: unknown): unknown {
  if (v instanceof Date) {
    if (Number.isNaN(v.valueOf())) return String(v);
    const iso = v.toISOString();
    return iso.endsWith('T00:00:00.000Z') ? iso.slice(0, 10) : iso;
  }
  if (Array.isArray(v)) return v.map(normalizeFrontmatterValue);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      out[k] = normalizeFrontmatterValue(val);
    }
    return out;
  }
  return v;
}

/**
 * A note's title: explicit frontmatter wins, then a `name` field, then the
 * filename — except when the filename is generic, in which case the parent
 * folder is what actually identifies it (`skills/writing-skills/SKILL.md`
 * is "writing-skills", not "SKILL").
 */
export function resolveTitle(path: string, fm: Record<string, unknown>): string {
  for (const key of ['title', 'name']) {
    const v = fm[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  const parts = path.split('/');
  const base = (parts.pop() ?? path).replace(/\.md$/i, '');
  if (GENERIC_BASENAMES.has(base.toLowerCase()) && parts.length > 0) {
    const parent = parts[parts.length - 1]!;
    if (parent) return parent;
  }
  return base;
}

/**
 * Parse one markdown file into a Note. Never throws on malformed input:
 * frontmatter errors degrade to empty frontmatter + a warning.
 */
export function parseNote(path: string, raw: string, mtimeMs: number, size?: number): Note {
  const warnings: string[] = [];
  let fm: Record<string, unknown> = {};
  let body = raw;
  try {
    const parsed = matter(raw);
    fm = (parsed.data ?? {}) as Record<string, unknown>;
    body = parsed.content;
  } catch (err) {
    warnings.push(`frontmatter parse failed: ${(err as Error).message}`);
    // strip the bad frontmatter fence so it doesn't pollute blocks
    body = raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
  }

  const title = resolveTitle(path, fm);

  // tags: frontmatter (string | array) + inline
  const tagSet = new Set<string>();
  const fmTags = fm.tags ?? fm.tag;
  if (Array.isArray(fmTags)) {
    for (const t of fmTags) {
      const n = normalizeTag(t);
      if (n) tagSet.add(n);
    }
  } else if (typeof fmTags === 'string') {
    for (const t of fmTags.split(/[,\s]+/)) {
      const n = normalizeTag(t);
      if (n) tagSet.add(n);
    }
  }

  const sections = splitSections(body);
  const blocks: Block[] = [];
  const links: WikiLink[] = [];
  const anchorCounts = new Map<string, number>();
  let order = 0;
  for (const sec of sections) {
    const headingKey = sec.headingPath.join('/');
    let chunks = chunkText(sec.lines.join('\n'));
    // A heading with no body IS the content. Stub notes (created by following
    // a link) and index/MOC notes are often nothing but headings; without
    // this they produced zero blocks and were entirely unsearchable — a note
    // titled "Quokka Protocol" could not be found by searching for it.
    if (chunks.length === 0 && sec.headingPath.length > 0) {
      chunks = [sec.headingPath[sec.headingPath.length - 1] ?? ''];
    }
    for (const chunk of chunks) {
      if (!chunk) continue;
      const seq = anchorCounts.get(headingKey) ?? 0;
      anchorCounts.set(headingKey, seq + 1);
      const anchor = `${headingKey}@${seq}`;
      blocks.push({
        anchor,
        heading: headingKey,
        order: order++,
        text: chunk,
        hash: sha1(chunk),
      });
      links.push(...extractLinks(chunk, anchor));
      for (const t of extractInlineTags(chunk)) tagSet.add(t);
    }
    // heading-only sections still contribute their heading as context for
    // link extraction in the heading line itself (rare, skip otherwise)
  }

  // A note whose entire content is frontmatter — a metadata record, a
  // dataview-style entry, a template stub — otherwise produced no blocks and
  // could not be found by its own title.
  if (blocks.length === 0) {
    const parts = [title];
    for (const [k, v] of Object.entries(fm)) {
      if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
        parts.push(`${k}: ${v}`);
      } else if (Array.isArray(v)) {
        for (const item of v) {
          if (typeof item === 'string' || typeof item === 'number') parts.push(String(item));
        }
      }
    }
    const text = parts.filter(Boolean).join(' · ').trim();
    if (text) {
      blocks.push({ anchor: '@0', heading: '', order: 0, text, hash: sha1(text) });
    }
  }

  return {
    path,
    title,
    frontmatter: normalizeFrontmatterValue(fm) as Record<string, unknown>,
    tags: [...tagSet],
    links,
    blocks,
    hash: sha1(raw),
    mtimeMs,
    size: size ?? Buffer.byteLength(raw, 'utf8'),
    warnings,
  };
}

/**
 * True when a block's text is only an echo of its own heading.
 *
 * A section with no body of its own is indexed as its heading so that a note
 * made only of headings can still be found. That text is a stand-in for
 * findability — nobody wrote it — and section names ("Overview", "Usage",
 * "The Process") repeat constantly across a vault, so anything that treats
 * block text as authored content must skip these or it will conclude that two
 * unrelated notes say the same thing. They stay indexed and searchable; the
 * lexical index is what they exist for.
 *
 * Shared by every such consumer on purpose: two copies of this rule would
 * drift, and the failures it prevents are silent ones.
 */
export function isHeadingEcho(heading: string, text: string): boolean {
  const leaf = (heading.split('/').pop() ?? '').trim();
  return leaf !== '' && text.trim() === leaf;
}
