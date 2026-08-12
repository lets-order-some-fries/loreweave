import type { LoreGraph } from './build.js';

export interface PprOptions {
  /** Damping: probability of following an edge vs teleporting to seeds. */
  alpha?: number;
  /** Power iterations; 2 suffices for retrieval (NodeRAG). */
  iterations?: number;
}

/**
 * Personalized PageRank via power iteration on the weight-normalized
 * adjacency: p ← (1−α)·seed + α·W p.  Seeds are node-idx → mass (normalized
 * internally). Returns per-node scores.
 */
export function ppr(
  graph: LoreGraph,
  seeds: Map<number, number>,
  opts: PprOptions = {},
): Float64Array {
  const alpha = opts.alpha ?? 0.5;
  const iterations = opts.iterations ?? 2;
  const { n, offsets, neighbors, weights } = graph;
  // Past the first hop, only relational evidence keeps propagating (see
  // LoreGraph.weightsDeep). Falls back to the full weights when a graph
  // predates the split — behavior is then identical to the classic walk.
  const deep = graph.weightsDeep ?? weights;
  const scores = new Float64Array(n);
  if (seeds.size === 0 || n === 0) return scores;

  // normalized seed vector
  let total = 0;
  for (const v of seeds.values()) total += Math.max(0, v);
  if (total <= 0) return scores;
  const seedVec = new Float64Array(n);
  for (const [idx, v] of seeds.entries()) {
    if (idx >= 0 && idx < n && v > 0) seedVec[idx] = v / total;
  }

  // out-strength for normalization, one per weight array
  const strength = new Float64Array(n);
  const strengthDeep = new Float64Array(n);
  for (let u = 0; u < n; u++) {
    for (let e = offsets[u]!; e < offsets[u + 1]!; e++) {
      strength[u]! += weights[e]!;
      strengthDeep[u]! += deep[e]!;
    }
  }

  const p = Float64Array.from(seedVec);
  const next = new Float64Array(n);
  for (let it = 0; it < iterations; it++) {
    const w = it === 0 ? weights : deep;
    const str = it === 0 ? strength : strengthDeep;
    next.fill(0);
    let dangling = 0;
    for (let u = 0; u < n; u++) {
      const pu = p[u]!;
      if (pu === 0) continue;
      const s = str[u]!;
      if (s === 0) {
        dangling += pu; // mass returns to seeds below
        continue;
      }
      const share = pu / s;
      for (let e = offsets[u]!; e < offsets[u + 1]!; e++) {
        next[neighbors[e]!]! += share * w[e]!;
      }
    }
    for (let i = 0; i < n; i++) {
      p[i] = (1 - alpha) * seedVec[i]! + alpha * (next[i]! + dangling * seedVec[i]!);
    }
  }
  return p;
}
