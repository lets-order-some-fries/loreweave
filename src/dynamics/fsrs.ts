/**
 * Memory dynamics: FSRS-style power-law retrievability with reinforcement
 * on *use* (citation), not mere retrieval — the RMM lesson.
 *
 * R(t, S) = (1 + FACTOR·t/S)^DECAY with FACTOR=19/81, DECAY=-0.5,
 * so R(S, S) = 0.9: stability S is "days until retrievability hits 90%".
 */

const FACTOR = 19 / 81;
const DECAY = -0.5;
/** FSRS-flavored growth constants (difficulty fixed at default). */
const W8 = 1.2;
const W9 = 0.11;
const W10 = 1.01;
export const MAX_STABILITY_DAYS = 3650;

export function retrievability(daysSinceAccess: number, stabilityDays: number): number {
  const t = Math.max(0, daysSinceAccess);
  const s = Math.max(0.01, stabilityDays);
  return Math.pow(1 + (FACTOR * t) / s, DECAY);
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
