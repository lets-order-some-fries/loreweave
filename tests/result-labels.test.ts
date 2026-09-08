import { describe, expect, it } from 'vitest';
import { strength } from '../src/cli/main.js';
import { leanHit } from '../src/mcp/server.js';

/**
 * Both surfaces explain WHY a result is here — the README's promise is that
 * every result tells you why. When lexical coverage is zero, both used to fall
 * straight through to link wording without ever consulting the dense score or
 * checking whether the result had any links at all. In a vault with no links
 * and embeddings on — the configuration the README recommends — a correct
 * semantic hit was announced as a graph edge that does not exist. For an agent
 * reading "linked, no term match" on every row, that is a strong signal to
 * discard a result set that was in fact correct.
 */
const hit = (over: Partial<{ coverage: number; lexicalScore: number; dense: number; via: string[] }>) => ({
  notePath: 'a.md', heading: 'A', anchor: '', score: 1, snippet: 's',
  coverage: over.coverage ?? 0,
  lexicalScore: over.lexicalScore ?? 0,
  parts: { dense: over.dense ?? 0 },
  via: over.via ?? [],
});

describe('result labels name the reason the result is here', () => {
  it('a purely semantic hit is called semantic, not linked', () => {
    expect(strength(hit({ dense: 0.42 }))).toMatch(/semantic/i);
    expect(strength(hit({ dense: 0.42 }))).not.toMatch(/link/i);
    expect(leanHit(hit({ dense: 0.42 })).match).toMatch(/semantic/i);
    expect(leanHit(hit({ dense: 0.42 })).match).not.toMatch(/link/i);
  });

  it('a genuinely linked hit is still called linked', () => {
    expect(strength(hit({ via: ['Amara Osei'] }))).toMatch(/link/i);
    expect(leanHit(hit({ via: ['Amara Osei'] })).match).toMatch(/link/i);
  });

  it('no terms, no semantics and no links claims neither', () => {
    expect(strength(hit({}))).not.toMatch(/link|semantic/i);
    expect(leanHit(hit({})).match).not.toMatch(/link|semantic/i);
  });

  it('term coverage still wins over both', () => {
    expect(strength(hit({ coverage: 1, dense: 0.9, via: ['X'] }))).toBe('all terms');
    expect(leanHit(hit({ coverage: 1, dense: 0.9 })).match).toBe('all query terms');
  });
});
