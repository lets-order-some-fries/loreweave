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
