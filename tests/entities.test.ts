import { describe, expect, it } from 'vitest';
import { parseNote } from '../src/vault/parse.js';
import { extractEntities } from '../src/entities/extract.js';

describe('extractEntities', () => {
  it('unifies wiki-link and prose mentions of the same name', () => {
    const raw = `---
title: Meeting Notes
---

Talked with Sarah Chen about the roadmap. Follow up with [[Sarah Chen]] next week.
`;
    const n = parseNote('m.md', raw, 1);
    const mentions = extractEntities(n);
    const sarah = mentions.filter((m) => m.key === 'sarah chen');
    expect(sarah.length).toBeGreaterThanOrEqual(2);
    const sources = new Set(sarah.map((m) => m.source));
    expect(sources.has('link')).toBe(true);
    expect(sources.has('nlp')).toBe(true);
  });

  it('note title and tags become entities; junk filtered', () => {
    const raw = `---
title: Machine Learning Lab
tags: [machine-learning]
---

Today I did things. 12345 numbers only.
`;
    const n = parseNote('m.md', raw, 1);
    const mentions = extractEntities(n);
    const keys = mentions.map((m) => m.key);
    expect(keys).toContain('machine learning lab');
    expect(keys).toContain('machine learning');
    expect(keys).not.toContain('12345');
    expect(keys).not.toContain('today');
  });

  it('nlp can be disabled', () => {
    const raw = `Alice Johnson met Bob Smith in Paris.`;
    const n = parseNote('m.md', raw, 1);
    const mentions = extractEntities(n, false);
    expect(mentions.every((m) => m.source !== 'nlp')).toBe(true);
  });

  it('sentence-initial imperatives are not entities', () => {
    // Measured on a real docs corpus, these WERE the top "entities":
    // Use(58), Good(20), Example(19), Core(16) — all outranking real ones.
    const raw = `Use the runner carefully. Good practice is to check first.
Example output follows. Core behaviour is unchanged.`;
    const keys = extractEntities(parseNote('m.md', raw, 1)).map((m) => m.key);
    for (const junk of ['use', 'good', 'example', 'core']) {
      expect(keys).not.toContain(junk);
    }
  });

  it('acronyms survive even as single sentence-initial tokens', () => {
    const raw = `TDD is the practice. API access is required.`;
    const keys = extractEntities(parseNote('m.md', raw, 1)).map((m) => m.key);
    expect(keys).toContain('tdd');
    expect(keys).toContain('api');
  });

  it('multi-word names survive at sentence start', () => {
    const raw = `Grace Hopper wrote the compiler. Gemini CLI shipped later.`;
    const keys = extractEntities(parseNote('m.md', raw, 1)).map((m) => m.key);
    expect(keys).toContain('grace hopper');
    expect(keys).toContain('gemini cli');
  });

  it('singular and plural mentions collapse to one entity', () => {
    const raw = `The team reviewed several Widgets today. A single Widget failed.`;
    const keys = extractEntities(parseNote('m.md', raw, 1))
      .filter((m) => m.source === 'nlp')
      .map((m) => m.key);
    expect(keys.filter((k) => k.startsWith('widget'))).not.toContain('widgets');
  });

  it('proper noun runs are extracted from prose', () => {
    const raw = `The report was reviewed by Grace Hopper and later archived in New York.`;
    const n = parseNote('m.md', raw, 1);
    const keys = extractEntities(n).map((m) => m.key);
    expect(keys).toContain('grace hopper');
    expect(keys).toContain('new york');
  });
});

describe('capitalisation lies that a docs vault tells constantly', () => {
  const nlpNames = (raw: string) =>
    extractEntities(parseNote('n.md', raw, 1))
      .filter((e) => e.source === 'nlp')
      .map((e) => e.display);

  it('a shouted ordinary word is emphasis, not an acronym', () => {
    // The acronym exemption exists to rescue NASA and API FROM the common-word
    // filter. Applied to any all-caps token it resurrected the very words that
    // filter removes — and documentation shouts constantly.
    const names = nlpNames('IF A SKILL APPLIES TO YOUR TASK, YOU MUST USE IT. Never skip.\n');
    expect(names.map((n) => n.toLowerCase())).not.toContain('use');
  });

  it('but a real acronym in the same breath survives', () => {
    const names = nlpNames('You MUST call the NASA telemetry API before takeoff.\n');
    expect(names).toContain('NASA');
    expect(names).toContain('API');
  });

  it('a contraction is not a person', () => {
    // "I'm" tokenises to a capitalised "Im", tags PROPN, and became one of the
    // most-mentioned entities in a vault whose every skill opens by announcing
    // itself: "I'm using the X skill to …".
    const names = nlpNames("I'm using the executing-plans skill. We've verified it. It's fine.\n");
    for (const bad of ['Im', "I'm", 'Weve', "We've", 'Its']) expect(names).not.toContain(bad);
  });

  it('an apostrophe inside a real name is untouched', () => {
    const names = nlpNames("Siobhan O'Brien reviewed it with Luca D'Angelo.\n");
    expect(names.join(' ')).toContain("O'Brien");
    expect(names.join(' ')).toContain("D'Angelo");
  });
});

describe('proper nouns ending in -es are one graph node, not two', () => {
  it('an NLP mention of a -es name shares its key with a wiki-link to it', () => {
    // singularizeKey used to strip the 's' from any vowel+es word, so an NLP
    // mention of "Indiana Jones" keyed as "indiana jone" while a [[Indiana
    // Jones]] link keyed as "indiana jones" — two nodes for one entity, the
    // opposite of the merge the function exists for.
    const note = parseNote(
      'n.md',
      'Discussed [[Indiana Jones]] today. Later, Indiana Jones met Sherlock Holmes in Naples.\n',
      1,
    );
    const keys = new Set(extractEntities(note).map((e) => e.key));
    // the link key and the prose-mention key must coincide
    expect(keys.has('indiana jones')).toBe(true);
    expect(keys.has('indiana jone')).toBe(false);
    // the other -es names survive intact too
    const nlp = extractEntities(note)
      .filter((e) => e.source === 'nlp')
      .map((e) => e.key);
    expect(nlp).toContain('sherlock holmes');
    expect(nlp).toContain('naples');
    expect(nlp.some((k) => /jone$|holme$|naple$/.test(k))).toBe(false);
  });
});
