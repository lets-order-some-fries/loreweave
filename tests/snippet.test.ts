import { describe, expect, it } from 'vitest';
import { bestSnippet } from '../src/retrieve/search.js';
import { contentTerms } from '../src/normalize.js';

const BLOCK = `- **Target roles / titles:** AI Engineer, Senior AI Engineer, ML Engineer
- **Seniority:** Mid to Senior
- **Location:** No preference
- **Timeline / urgency:** Actively applying now (currently employed)
- **Compensation expectation:** TBD
- **Companies to AVOID:** Axtria, Analytic Edge (C5i) — former employers. Do not apply.`;

describe('bestSnippet', () => {
  it('shows the line that answers the query, not the first term hit', () => {
    // "applying" appears in the Timeline line; the ANSWER is the last line.
    const s = bestSnippet(BLOCK, contentTerms('which companies should I avoid applying to'));
    expect(s).toContain('Companies to AVOID');
    expect(s).toContain('Axtria');
  });

  it('picks a different line for a different question in the same block', () => {
    const s = bestSnippet(BLOCK, contentTerms('what are my target roles'));
    expect(s).toContain('Target roles');
  });

  it('never truncates the matching line away', () => {
    const s = bestSnippet(BLOCK, contentTerms('avoid companies'), 80);
    expect(s).toContain('Companies to AVOID');
  });

  it('falls back to the block head when nothing matches', () => {
    const s = bestSnippet(BLOCK, contentTerms('zzzqqq nothing'));
    expect(s.length).toBeGreaterThan(0);
    expect(s).toContain('Target roles');
  });

  it('finds an answer split across hard-wrapped lines', () => {
    // Most markdown is wrapped, so the answering sentence is routinely split.
    // Scoring single lines made each half count 1, losing to an unrelated
    // earlier line that also counted 1.
    const wrapped = [
      'It indexes, links, remembers, forgets, and dreams.',
      'Some unrelated filler sentence goes here to add length.',
      'Your files stay exactly as they are. The vault is the source of truth; the index is a',
      'cache you can delete at any time.',
    ].join('\n');
    const s = bestSnippet(wrapped, contentTerms('why is the index a cache'));
    expect(s).toContain('index is a');
    expect(s).toContain('cache you can delete');
  });

  it('does not present raw markup as the answer', () => {
    const withHtml = [
      '<h1 align="center">Loreweave</h1>',
      '<p align="center">',
      '  <a href="#quickstart">Quickstart</a>',
      '</p>',
      '---',
      'The index is a disposable cache rebuilt from your notes.',
    ].join('\n');
    const s = bestSnippet(withHtml, contentTerms('index cache'));
    expect(s).toContain('disposable cache');
    expect(s).not.toMatch(/^<[a-z]/i);
  });

  it('handles empty input safely', () => {
    expect(bestSnippet('', contentTerms('anything'))).toBe('');
    expect(bestSnippet('some text', [])).toBe('some text');
  });

  it('collapses whitespace and respects the budget', () => {
    const long = Array.from({ length: 40 }, (_, i) => `line ${i} with filler words`).join('\n');
    const s = bestSnippet(long, ['line'], 100);
    expect(s.length).toBeLessThanOrEqual(110);
    expect(s).not.toMatch(/\n/);
  });
});
