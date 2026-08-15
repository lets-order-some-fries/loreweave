import { describe, expect, it } from 'vitest';
import { openStore } from '../src/store/db.js';
import { indexVault } from '../src/index/indexer.js';
import { feedbackTerms, shouldExpand, coverageOf } from '../src/retrieve/prf.js';
import { makeVault } from './helpers.js';

/**
 * PRF adds the vault's own words to a query. Its famous failure is drift, so
 * the guards matter more than the mechanism: expand only hard queries, and
 * only toward terms rare enough to narrow rather than widen.
 */
describe('pseudo-relevance feedback', () => {
  it('picks terms that recur in the feedback set and are rare in the vault', async () => {
    const files: Record<string, string> = {
      'a.md': '# A\n\nThe thornwick calibration drifted during the survey run.\n',
      'b.md': '# B\n\nAnother thornwick calibration note about the survey run.\n',
    };
    // background noise so a common word is genuinely common
    for (let i = 0; i < 40; i++) {
      files[`n${i}.md`] = `# N${i}\n\nRoutine survey paperwork and scheduling notes.\n`;
    }
    const root = await makeVault(files);
    const store = openStore(':memory:');
    await indexVault(store, root);

    const terms = feedbackTerms(
      store,
      [files['a.md']!, files['b.md']!],
      ['calibration'],
    );
    expect(terms).toContain('thornwick'); // recurs, and rare
    expect(terms).not.toContain('calibration'); // already in the query
    expect(terms).not.toContain('survey'); // recurs but is everywhere
    store.close();
  });

  it('a term appearing in only one feedback document is not a pattern', async () => {
    const root = await makeVault({
      'a.md': '# A\n\nThe quillfeather anomaly appeared once.\n',
      'b.md': '# B\n\nUnrelated content entirely.\n',
    });
    const store = openStore(':memory:');
    await indexVault(store, root);
    const terms = feedbackTerms(store, ['The quillfeather anomaly appeared once.', 'Unrelated content entirely.'], []);
    expect(terms).not.toContain('quillfeather');
    store.close();
  });

  it('only hard queries are expanded', () => {
    // short queries are usually precise
    expect(shouldExpand(['ledger', 'migration'], 0.5)).toBe(false);
    // a bullseye needs no help even when long
    expect(shouldExpand(['a', 'b', 'c', 'd'], 1)).toBe(false);
    // verbose and imperfectly covered: the case PRF is for
    expect(shouldExpand(['a', 'b', 'c', 'd'], 0.5)).toBe(true);
  });

  it('coverage is measured the same way search reports it', () => {
    expect(coverageOf('the ledger migration finished', ['ledger', 'migration'])).toBe(1);
    expect(coverageOf('the ledger only', ['ledger', 'migration'])).toBe(0.5);
    expect(coverageOf('anything', [])).toBe(0);
  });
});
