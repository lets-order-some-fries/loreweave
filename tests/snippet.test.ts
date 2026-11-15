import { describe, expect, it } from 'vitest';
import { bestSnippet } from '../src/retrieve/search.js';
import { contentTerms } from '../src/normalize.js';

const BLOCK = `- **Target sites / buildings:** North depot, Harbor annex, Cold store
- **Scope:** Replace and recalibrate
- **Owner:** No assignee yet
- **Timeline / urgency:** Ordering now (current sensors still running)
- **Budget estimate:** TBD
- **Vendors to EXCLUDE:** Globex, Initech — both failed the last site audit. Do not order.`;

describe('bestSnippet', () => {
  it('shows the line that answers the query, not the first term hit', () => {
    // "ordering" appears in the Timeline line; the ANSWER is the last line.
    const s = bestSnippet(BLOCK, contentTerms('which vendors should we exclude when ordering'));
    expect(s).toContain('Vendors to EXCLUDE');
    expect(s).toContain('Globex');
  });

  it('picks a different line for a different question in the same block', () => {
    const s = bestSnippet(BLOCK, contentTerms('what are the target sites'));
    expect(s).toContain('Target sites');
  });

  it('never truncates the matching line away', () => {
    const s = bestSnippet(BLOCK, contentTerms('exclude vendors'), 80);
    expect(s).toContain('Vendors to EXCLUDE');
  });

  it('falls back to the block head when nothing matches', () => {
    const s = bestSnippet(BLOCK, contentTerms('zzzqqq nothing'));
    expect(s.length).toBeGreaterThan(0);
    expect(s).toContain('Target sites');
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

  it('never renders a separator or bare tag as content', () => {
    const withSep = [
      '<h1 align="center">Project Guide</h1>',
      '---',
      'The database is a disposable cache you can delete.',
    ].join('\n');
    const s = bestSnippet(withSep, contentTerms('why is the database a cache'));
    expect(s).toContain('disposable cache');
    expect(s).not.toContain('---');
    expect(s).not.toContain('<');
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

describe('generated source never masquerades as the answer', () => {
  // Every case here is drawn from a real docs vault, where "what should I do
  // when a test fails" returned the right note and the right heading and then
  // showed 800 characters of `digraph tdd_cycle { … }`.
  const DIAGRAM = [
    '```dot',
    'digraph tdd_cycle {',
    '    red [label="RED\\nWrite failing test", shape=box];',
    '    verify_red [label="Verify fails\\ncorrectly", shape=diamond];',
    '    red -> verify_red;',
    '}',
    '```',
  ].join('\n');

  it('a snippet prefers prose over a pure-source window that matches as well', () => {
    const block = `${DIAGRAM}\n\nWhen a test fails, read the failure message before changing anything.`;
    const s = bestSnippet(block, contentTerms('what should I do when a test fails'));
    expect(s).toContain('read the failure message');
    expect(s).not.toContain('digraph');
  });

  it('but source still wins when it is the only thing that answers', () => {
    const block = `${DIAGRAM}\n\nSome unrelated prose about scheduling and meetings.`;
    const s = bestSnippet(block, contentTerms('digraph tdd_cycle shape diamond'));
    expect(s).toContain('digraph');
  });

  it('a snippet never opens with a bare fence marker', () => {
    // "``` Confirm: - Test fails" spends its first characters on punctuation
    // for a renderer that is not running.
    const block = '**MANDATORY.**\n\n```bash\nnpm test path/to/x.test.ts\n```\n\nConfirm the test fails.';
    const s = bestSnippet(block, contentTerms('verify the test fails'));
    expect(s.trimStart().startsWith('```')).toBe(false);
    expect(s).not.toContain('```');
    expect(s).toContain('npm test');
  });
});
