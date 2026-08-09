import { describe, expect, it } from 'vitest';
import { singularizeKey, resolveRelative, linkMatchKey, contentTerms } from '../src/normalize.js';
import { parseDateExpression, extractDates } from '../src/temporal/dates.js';
import { bestSnippet } from '../src/retrieve/search.js';

describe('singularizeKey', () => {
  it('never mangles names that merely end in s', () => {
    // A wrong merge corrupts an entity permanently; a missed merge costs a node.
    for (const name of ['atlas', 'kansas', 'vegas', 'basis', 'analysis', 'osiris', 'chris', 'lens', 'status', 'process', 'glass']) {
      expect(singularizeKey(name)).toBe(name);
    }
  });

  it('still merges clear plurals', () => {
    expect(singularizeKey('widgets')).toBe('widget'); // consonant + s
    expect(singularizeKey('branches')).toBe('branch'); // -ches
    expect(singularizeKey('stories')).toBe('story'); // consonant + ies
    expect(singularizeKey('boxes')).toBe('box'); // -xes
  });

  it('only touches the final word', () => {
    expect(singularizeKey('quarterly reports')).toBe('quarterly report');
  });

  it('leaves proper nouns ending in vowel + es alone', () => {
    // "James"+s and "note"+s have the SAME surface form (a stem ending in 'e',
    // plus 's'), so no rule can singularize "notes"->"note" without also
    // shredding "James"->"jame". This function's only caller is the NLP
    // entity-key path, where the input is a proper noun far more often than a
    // common-noun plural — and mangling a name (splitting it from its own
    // [[wiki-link]] into two graph nodes) is worse than missing a merge. So
    // vowel + es is deliberately preserved.
    for (const name of ['james', 'jones', 'charles', 'holmes', 'naples', 'wales', 'hermes']) {
      expect(singularizeKey(name)).toBe(name);
    }
    // consonant + es is likewise left as-is (not treated as a plural here)
    expect(singularizeKey('notes')).toBe('notes');
  });
});

describe('resolveRelative', () => {
  it('normalizes . and .. and refuses to escape the vault', () => {
    expect(resolveRelative('d/e/a.md', '../../f.md')).toBe('f.md');
    expect(resolveRelative('a.md', './././b.md')).toBe('b.md');
    expect(resolveRelative('d/a.md', '../../x.md')).toBeNull();
    expect(resolveRelative('a.md', '')).toBeNull();
  });

  it('treats a leading slash as vault-root relative', () => {
    expect(resolveRelative('deep/a.md', '/notes/x.md')).toBe('notes/x.md');
  });

  it('both link styles agree on the key', () => {
    expect(linkMatchKey('n/a.md', '../people/Amara Osei.md', 'markdown')).toBe('amara osei');
    expect(linkMatchKey('n/a.md', 'Amara Osei', 'wiki')).toBe('amara osei');
  });
});

describe('date validation', () => {
  it('rejects impossible dates that would corrupt content time', () => {
    expect(parseDateExpression('2026-02-31')).toBeNull();
    expect(parseDateExpression('2026-13-01')).toBeNull();
    expect(parseDateExpression('2026-00-10')).toBeNull();
  });

  it('accepts real dates including leap days', () => {
    expect(parseDateExpression('2024-02-29')).toEqual({ from: '2024-02-29', to: '2024-02-29' });
    expect(parseDateExpression('2025-02-29')).toBeNull(); // not a leap year
  });

  it('ignores invalid dates when scanning text', () => {
    expect(extractDates('version 2026-13-01 shipped, real date 2026-03-04')).toEqual({
      from: '2026-03-04',
      to: '2026-03-04',
    });
  });
});

describe('degenerate inputs', () => {
  it('snippet budget is clamped rather than producing an ellipsis-only string', () => {
    expect(bestSnippet('alpha beta\ngamma delta', ['gamma'], 0)).toContain('gamma');
    expect(bestSnippet('alpha beta\ngamma delta', ['gamma'], -5)).toContain('gamma');
  });

  it('contentTerms never returns nothing for a real query', () => {
    expect(contentTerms('what is the')).toEqual(['what', 'is', 'the']);
    expect(contentTerms('')).toEqual([]);
  });
});
