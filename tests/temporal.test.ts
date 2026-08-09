import { describe, expect, it } from 'vitest';
import { extractDates, parseDateExpression, parseQueryTime } from '../src/temporal/dates.js';

describe('parseDateExpression', () => {
  it('parses ISO dates, months, quarters and years into ranges', () => {
    expect(parseDateExpression('2026-08-05')).toEqual({ from: '2026-08-05', to: '2026-08-05' });
    expect(parseDateExpression('2026-02')).toEqual({ from: '2026-02-01', to: '2026-02-28' });
    expect(parseDateExpression('2024-02')).toEqual({ from: '2024-02-01', to: '2024-02-29' }); // leap
    expect(parseDateExpression('August 2026')).toEqual({ from: '2026-08-01', to: '2026-08-31' });
    expect(parseDateExpression('Q3 2026')).toEqual({ from: '2026-07-01', to: '2026-09-30' });
    expect(parseDateExpression('back in 2019')).toEqual({ from: '2019-01-01', to: '2019-12-31' });
    expect(parseDateExpression('no dates here')).toBeNull();
  });
});

describe('parseQueryTime', () => {
  it('routes "before X" to the day before that window', () => {
    const t = parseQueryTime('where did I live before August 2025?');
    expect(t.kind).toBe('asOf');
    if (t.kind === 'asOf') expect(t.date).toBe('2025-07-31');
  });

  it('routes past-tense questions to the end of the mentioned window', () => {
    const t = parseQueryTime('what was the project status in 2023?');
    expect(t.kind).toBe('asOf');
    if (t.kind === 'asOf') expect(t.date).toBe('2023-12-31');
  });

  it('detects history questions', () => {
    expect(parseQueryTime('show me the history of my job titles').kind).toBe('history');
    expect(parseQueryTime('how has the status changed over time').kind).toBe('history');
  });

  it('is conservative: no temporal cue means no rewriting', () => {
    expect(parseQueryTime('where do I live').kind).toBe('none');
    expect(parseQueryTime('what is the current status').kind).toBe('none');
  });

  it('scopes a bare past date even without a past-tense verb', () => {
    // "where did I live in 2023" has no past-tense cue ('did'/'live' are not in
    // PAST_RE), so it used to return kind:'range' — which the only consumer,
    // `ask`, maps to no scope, answering from CURRENT facts. The near-identical
    // "what WAS my role in 2023" hit PAST_RE and answered correctly, so the
    // result flipped on the presence of a past-tense verb.
    for (const q of ['where did I live in 2023', 'where did I live during 2023']) {
      const t = parseQueryTime(q);
      expect(t.kind, q).toBe('asOf');
      if (t.kind === 'asOf') expect(t.date).toBe('2023-12-31');
    }
    // a present-tense question with no date is still not scoped
    expect(parseQueryTime('where do I live now').kind).toBe('none');
  });
});

describe('extractDates', () => {
  it('prefers frontmatter dates', () => {
    expect(extractDates('body', { date: '2025-06-01' })).toEqual({
      from: '2025-06-01',
      to: '2025-06-01',
    });
  });

  it('falls back to the span of ISO dates in the text', () => {
    const r = extractDates('Started 2024-03-01, ended 2024-09-15, noted 2024-05-02.');
    expect(r).toEqual({ from: '2024-03-01', to: '2024-09-15' });
  });

  it('returns null when there is nothing to find', () => {
    expect(extractDates('no dates at all')).toBeNull();
  });

  it('ignores impossible month values', () => {
    expect(extractDates('version 2024-99-99 of the spec')).toBeNull();
  });
});
