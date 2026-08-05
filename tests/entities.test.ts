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

  it('proper noun runs are extracted from prose', () => {
    const raw = `The report was reviewed by Grace Hopper and later archived in New York.`;
    const n = parseNote('m.md', raw, 1);
    const keys = extractEntities(n).map((m) => m.key);
    expect(keys).toContain('grace hopper');
    expect(keys).toContain('new york');
  });
});
