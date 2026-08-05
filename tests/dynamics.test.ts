import { describe, expect, it } from 'vitest';
import {
  MAX_STABILITY_DAYS,
  daysBetween,
  importanceHeuristic,
  reinforce,
  retrievability,
} from '../src/dynamics/fsrs.js';

describe('fsrs dynamics', () => {
  it('R(S,S) ≈ 0.9 (stability = days-to-90%)', () => {
    for (const s of [1, 7, 30, 365]) {
      expect(retrievability(s, s)).toBeCloseTo(0.9, 5);
    }
  });

  it('R decays monotonically and has a fat power-law tail', () => {
    expect(retrievability(0, 10)).toBe(1);
    expect(retrievability(5, 10)).toBeGreaterThan(retrievability(20, 10));
    // power law: even at 100x stability, R stays well above 0
    expect(retrievability(1000, 10)).toBeGreaterThan(0.15);
  });

  it('reinforcement is largest when nearly forgotten (spacing effect)', () => {
    const lowR = reinforce(10, 0.3) / 10;
    const highR = reinforce(10, 0.95) / 10;
    expect(lowR).toBeGreaterThan(highR);
    expect(highR).toBeGreaterThan(1); // still grows
  });

  it('reinforcement has diminishing returns in S and a cap', () => {
    const growthSmall = reinforce(1, 0.9) / 1;
    const growthBig = reinforce(1000, 0.9) / 1000;
    expect(growthSmall).toBeGreaterThan(growthBig);
    expect(reinforce(MAX_STABILITY_DAYS, 0.1)).toBe(MAX_STABILITY_DAYS);
  });

  it('importance stays in [0,1] and rewards linkage', () => {
    const lonely = importanceHeuristic({ inDegree: 0, outDegree: 0, recencyDays: 400 });
    const hub = importanceHeuristic({
      inDegree: 50,
      outDegree: 20,
      frontmatterPriority: 1,
      recencyDays: 1,
    });
    expect(lonely).toBeGreaterThanOrEqual(0);
    expect(hub).toBeLessThanOrEqual(1);
    expect(hub).toBeGreaterThan(lonely);
  });

  it('daysBetween handles null/garbage as Infinity', () => {
    expect(daysBetween(null, new Date())).toBe(Infinity);
    expect(daysBetween('not-a-date', new Date())).toBe(Infinity);
    expect(daysBetween(new Date(Date.now() - 86_400_000).toISOString(), new Date())).toBeCloseTo(
      1,
      1,
    );
  });
});
