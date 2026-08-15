import winkNLP, { type WinkMethods } from 'wink-nlp';
import model from 'wink-eng-lite-web-model';
import type { EntityMention, Note } from '../types.js';
import { linkMatchKey, normalizeKey, singularizeKey } from '../normalize.js';

let _nlp: WinkMethods | null = null;
function nlp(): WinkMethods {
  if (!_nlp) _nlp = winkNLP(model, ['pos']);
  return _nlp;
}

const STOP_ENTITIES = new Set([
  'i', 'me', 'my', 'we', 'you', 'it', 'the', 'a', 'an', 'this', 'that', 'these', 'those',
  'today', 'tomorrow', 'yesterday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday',
  'saturday', 'sunday', 'january', 'february', 'march', 'april', 'may', 'june', 'july',
  'august', 'september', 'october', 'november', 'december', 'ok', 'okay', 'yes', 'no',
  'note', 'notes', 'todo', 'https', 'http', 'www', 'com',
]);

function acceptable(key: string): boolean {
  if (key.length < 2) return false;
  if (/^\d+$/.test(key)) return false;
  if (STOP_ENTITIES.has(key)) return false;
  return true;
}

/**
 * No proper noun is 64 characters long. Anything that is — a base64 data URI,
 * a JWT, a hash, a minified payload, an Excalidraw blob, a CJK paragraph — is
 * noise to an English POS tagger, and dropping it is not merely tidy: the
 * tagger is QUADRATIC in the length of a single unbroken token. Measured:
 * 200 000 characters of ordinary prose tag in 26 ms; 200 000 characters with
 * no whitespace in it take 20 seconds, so a 2 MB pasted blob would hold a
 * single note hostage for roughly half an hour.
 */
const MAX_NLP_TOKEN = 64;

/** Strip markdown noise before NLP so PROPN detection sees prose. */
function stripMarkdown(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ') // fenced code
    .replace(/`[^`\n]*`/g, ' ') // inline code
    .replace(/\[\[([^\[\]]+?)\]\]/g, (_m, inner: string) => {
      // keep alias or target text so sentence structure survives
      const pipe = inner.indexOf('|');
      return pipe >= 0 ? inner.slice(pipe + 1) : inner.split('#')[0] ?? '';
    })
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ') // images
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // md links → text
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/^[>\-*+]\s+/gm, '')
    .replace(/[*_~]{1,3}/g, '')
    .replace(new RegExp(`\\S{${MAX_NLP_TOKEN},}`, 'gu'), ' ');
}

/**
 * Words that are routinely capitalized at the start of a sentence or heading
 * and therefore mis-tagged PROPN. Measured on a real docs corpus, these were
 * the top "entities" in the vault — "Use" (58), "Good" (20), "Example" (19) —
 * all outranking genuine ones.
 */
const COMMON_INITIAL = new Set([
  'use', 'used', 'using', 'add', 'added', 'run', 'running', 'write', 'writing',
  'make', 'making', 'check', 'checking', 'see', 'note', 'notes', 'when', 'why',
  'what', 'how', 'where', 'who', 'this', 'that', 'these', 'those', 'the', 'a',
  'an', 'good', 'bad', 'better', 'best', 'example', 'examples', 'core', 'test',
  'tests', 'testing', 'do', 'dont', 'never', 'always', 'if', 'for', 'with',
  'from', 'into', 'and', 'or', 'but', 'each', 'every', 'all', 'any', 'some',
  'first', 'second', 'third', 'next', 'last', 'then', 'now', 'here', 'there',
  'it', 'its', 'you', 'your', 'we', 'our', 'they', 'their', 'he', 'she',
  'keep', 'stop', 'start', 'create', 'delete', 'update', 'remove', 'set',
  'get', 'put', 'call', 'read', 'load', 'save', 'open', 'close', 'find',
  'fix', 'build', 'ship', 'let', 'lets', 'given', 'once', 'after', 'before',
  'because', 'so', 'also', 'only', 'just', 'still', 'even', 'more', 'most',
  'less', 'least', 'both', 'either', 'neither', 'not', 'no', 'yes', 'ok',
  'important', 'required', 'optional', 'default', 'overview', 'summary',
  'usage', 'result', 'results', 'output', 'input', 'step', 'steps', 'rule',
  'rules', 'process', 'flow', 'red', 'flags', 'principles', 'pattern',
  'patterns', 'anti', 'common', 'quick', 'full', 'new', 'old',
  // generic single nouns that are capitalized in headings and lists
  'multiple', 'phase', 'phases', 'reference', 'references', 'section',
  'sections', 'item', 'items', 'value', 'values', 'name', 'names', 'type',
  'types', 'file', 'files', 'code', 'error', 'errors', 'warning', 'warnings',
  'version', 'format', 'order', 'level', 'mode', 'state', 'status', 'detail',
  'details', 'context', 'content', 'description', 'title', 'page', 'line',
  'lines', 'word', 'words', 'point', 'points', 'case', 'cases', 'issue',
  'issues', 'change', 'changes', 'option', 'options', 'setting', 'settings',
  'config', 'goal', 'goals', 'problem', 'solution', 'answer', 'question',
  'questions', 'reason', 'purpose', 'scope', 'plan', 'plans', 'phase',
  // pronouns and generic determiners that open list items rather than sentences,
  // so the sentence-initial rule above never sees them
  'same', 'self', 'other', 'others', 'such', 'own', 'via', 'per', 'etc',
  'yes', 'nope', 'maybe', 'done', 'todo', 'wip', 'na',
]);

const ACRONYM_RE = /^[\p{Lu}][\p{Lu}\p{N}]{1,7}$/u;

/**
 * An all-caps token is an acronym unless it is simply an ordinary word being
 * shouted. Documentation shouts constantly — "YOU MUST USE IT", "NEVER do
 * this", "ALWAYS verify" — and the acronym exemption exists to rescue NASA and
 * API FROM the common-word filter, so it must not resurrect the very words
 * that filter is there to remove. Measured on a real docs vault, `USE` became
 * an entity this way and then seeded graph expansion for "when should I use a
 * worktree", pulling in a note about persuasion technique.
 */
export function isAcronymToken(tok: string): boolean {
  return (
    ACRONYM_RE.test(tok) && tok === tok.toUpperCase() && !COMMON_INITIAL.has(tok.toLowerCase())
  );
}

/**
 * "I'm" tokenizes to a capitalised "Im" and tags PROPN, so it became one of
 * the most-mentioned entities in a vault whose skills all open by announcing
 * themselves. A trailing apostrophe plus one or two letters is a contraction
 * in English and never part of a name — O'Brien and D'Angelo are unaffected,
 * their apostrophe is not a short suffix.
 */
function isContraction(tok: string): boolean {
  return /['\u2019]\p{L}{1,2}$/u.test(tok);
}

/**
 * Consecutive PROPN runs → candidate names, filtered for the two ways English
 * capitalization lies to a POS tagger: sentence-initial words and single
 * generic nouns. Multi-word names and acronyms are kept; a lone capitalized
 * common word is not an entity.
 */
function properNounRuns(text: string): string[] {
  const doc = nlp().readDoc(text);
  const its = nlp().its;
  const out: string[] = [];

  doc.sentences().each((sentence: any) => {
    const tokens: { value: string; pos: string }[] = [];
    sentence.tokens().each((t: any) => {
      tokens.push({ value: t.out(), pos: t.out(its.pos) });
    });
    let run: { value: string; index: number }[] = [];
    const flush = () => {
      if (run.length === 0 || run.length > 5) {
        run = [];
        return;
      }
      // Drop leading tokens that are only capitalized because they open the
      // sentence (or a Title Case heading fragment).
      while (
        run.length > 0 &&
        run[0]!.index === 0 &&
        COMMON_INITIAL.has(run[0]!.value.toLowerCase())
      ) {
        run.shift();
      }
      // Any remaining common word inside a single-token run is noise.
      if (run.length === 1) {
        const only = run[0]!.value;
        const isAcronym = isAcronymToken(only);
        if (!isAcronym && COMMON_INITIAL.has(only.toLowerCase())) {
          run = [];
          return;
        }
        // A lone capitalized word that opened the sentence is unreliable
        // unless it is an acronym.
        if (!isAcronym && run[0]!.index === 0) {
          run = [];
          return;
        }
      }
      if (run.length > 0) out.push(run.map((r) => r.value).join(' '));
      run = [];
    };
    tokens.forEach((t, i) => {
      if (t.pos === 'PROPN' && /\p{L}/u.test(t.value) && !isContraction(t.value))
        run.push({ value: t.value, index: i });
      else flush();
    });
    flush();
  });
  return out;
}

/**
 * Extract entity mentions from a note. Confidence by source:
 * wiki-link 1.0 · note title 1.0 · tag/frontmatter 0.9 · NLP proper noun 0.6.
 */
export function extractEntities(note: Note, useNlp = true): EntityMention[] {
  const seen = new Map<string, EntityMention>();
  const add = (m: EntityMention) => {
    if (!acceptable(m.key)) return;
    const dedupeKey = `${m.key} ${m.blockAnchor} ${m.source}`;
    const prev = seen.get(dedupeKey);
    if (!prev || prev.confidence < m.confidence) seen.set(dedupeKey, m);
  };

  // The note itself is an entity.
  add({
    key: normalizeKey(note.title),
    display: note.title,
    source: 'frontmatter',
    confidence: 1.0,
    blockAnchor: '',
  });

  for (const l of note.links) {
    const raw = l.target || l.heading || '';
    if (!raw) continue;
    const key = linkMatchKey(note.path, raw, l.style);
    // For markdown links the readable name is the alias or the file basename,
    // never the raw relative path.
    const display =
      l.style === 'markdown'
        ? l.alias || (raw.split('/').pop() ?? raw).replace(/\.md$/i, '')
        : raw;
    add({
      key,
      display,
      source: 'link',
      confidence: 1.0,
      blockAnchor: l.blockAnchor,
    });
  }

  for (const t of note.tags) {
    add({
      key: normalizeKey(t.replace(/[\/_-]+/g, ' ')),
      display: t,
      source: 'tag',
      confidence: 0.9,
      blockAnchor: '',
    });
  }

  // `aliases: Bobby` is YAML Obsidian accepts, and the GRAPH layer already
  // coerced the scalar form — but the extractor only read arrays, so the alias
  // never became an entity and the same-as edge the graph was written to build
  // silently never existed. Two layers disagreeing about the same frontmatter
  // is worse than either rule alone.
  const rawAliases = note.frontmatter.aliases ?? note.frontmatter.alias;
  const aliases = Array.isArray(rawAliases) ? rawAliases : rawAliases ? [rawAliases] : [];
  {
    for (const a of aliases) {
      if (typeof a === 'string' && a.trim()) {
        add({
          key: normalizeKey(a),
          display: a.trim(),
          source: 'frontmatter',
          confidence: 0.9,
          blockAnchor: '',
        });
      }
    }
  }

  if (useNlp) {
    for (const b of note.blocks) {
      const prose = stripMarkdown(b.text);
      if (prose.trim().length < 3) continue;
      for (const name of properNounRuns(prose)) {
        add({
          // singularize so PR/PRs land on one node
          key: singularizeKey(normalizeKey(name)),
          display: name,
          source: 'nlp',
          confidence: 0.6,
          blockAnchor: b.anchor,
        });
      }
    }
  }

  return [...seen.values()];
}
