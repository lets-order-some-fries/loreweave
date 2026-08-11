/**
 * Memory dynamics: FSRS-style power-law retrievability with reinforcement
 * on *use* (citation), not mere retrieval — the RMM lesson.
 *
 * R(t, S) = (1 + F·t/S)^(−decay) with F = 0.9^(−1/decay) − 1, so that
 * R(S, S) = 0.9 for ANY decay: stability S is always "days until
 * retrievability hits 90%". This is FSRS-6's form — its headline change over
 * earlier versions is exactly that the curve SHAPE is a parameter, and it
 * predicts recall better than the fixed-shape curve for 88% of users on the
 * open 700M-review benchmark. decay = 0.5 reproduces the old hard-coded
 * FSRS-4.5 constants (F = 19/81) to floating-point precision; human-fitted values are
 * typically flatter (< 0.2). Per-vault fitting lives in dynamics/fit.ts.
 */

export const DEFAULT_DECAY = 0.5;
export const clampDecay = (d: number): number =>
  Number.isFinite(d) ? Math.min(0.8, Math.max(0.1, d)) : DEFAULT_DECAY;

/** FSRS-flavored growth constants (difficulty fixed at default). */
const W8 = 1.2;
const W9 = 0.11;
const W10 = 1.01;
export const MAX_STABILITY_DAYS = 3650;

export function retrievability(
  daysSinceAccess: number,
  stabilityDays: number,
  decay = DEFAULT_DECAY,
): number {
  const t = Math.max(0, daysSinceAccess);
  const s = Math.max(0.01, stabilityDays);
  const d = clampDecay(decay);
  const factor = Math.pow(0.9, -1 / d) - 1;
  return Math.pow(1 + (factor * t) / s, -d);
}

/**
 * New stability after a successful *use*. Growth is largest when the memory
 * was nearly forgotten (spacing effect, e^(w10·(1−R))) and has diminishing
 * returns in S (S^−w9).
 */
export function reinforce(stabilityDays: number, currentRetrievability: number): number {
  const s = Math.max(0.01, stabilityDays);
  const r = Math.min(1, Math.max(0, currentRetrievability));
  const growth = 1 + Math.exp(W8) * Math.pow(s, -W9) * (Math.exp(W10 * (1 - r)) - 1);
  return Math.min(MAX_STABILITY_DAYS, s * growth);
}

export function daysBetween(fromIso: string | null, to: Date): number {
  if (!fromIso) return Infinity;
  const from = Date.parse(fromIso);
  if (Number.isNaN(from)) return Infinity;
  return Math.max(0, (to.getTime() - from) / 86_400_000);
}

export interface ImportanceSignals {
  inDegree: number;
  outDegree: number;
  /** frontmatter `priority`/`importance` mapped to 0..1, if present. */
  frontmatterPriority?: number;
  /** days since the note was modified. */
  recencyDays: number;
}

/** Heuristic importance in [0,1]; LLM re-rating can overwrite it later. */
export function importanceHeuristic(sig: ImportanceSignals): number {
  let score = 0.15;
  score += 0.1 * Math.log2(1 + Math.max(0, sig.inDegree));
  score += 0.05 * Math.log2(1 + Math.max(0, sig.outDegree));
  if (sig.frontmatterPriority !== undefined) {
    score += 0.3 * Math.min(1, Math.max(0, sig.frontmatterPriority));
  }
  if (sig.recencyDays <= 7) score += 0.1;
  else if (sig.recencyDays <= 30) score += 0.05;
  return Math.min(1, Math.max(0, score));
}
