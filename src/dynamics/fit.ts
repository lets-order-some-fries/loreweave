import type { Store } from '../store/db.js';
import { DEFAULT_DECAY, clampDecay, reinforce, retrievability } from './fsrs.js';

/**
 * Fit the vault's forgetting-curve shape from its own access history.
 *
 * The signal is the one the engine already records and already trusts for
 * reinforcement: a block RETRIEVED (shown as a result) that then gets marked
 * USED within the horizon is a success — the memory was worth having ready;
 * retrieved-and-ignored is a miss. At each retrieval we know the gap since
 * the block's previous event and can replay what its stability was, so each
 * event yields (predicted R, actual outcome) — and log loss over those pairs
 * ranks candidate decays. This is srs-benchmark's method scaled to the data
 * a notes engine actually has; no LLM, no network, same log → same fit.
 *
 * Deliberately conservative: below `minEvents` labeled events the fit is
 * noise, so the answer is null and the default shape stays. The fitted value
 * is stored by the caller (dream) in meta `fsrs_decay`, which every
 * retrievability consumer reads through `vaultDecay`.
 */

export interface DecayFit {
  decay: number;
  events: number;
  /** Mean log loss at the chosen decay (lower is better-calibrated). */
  logLoss: number;
  /** Mean log loss at DEFAULT_DECAY, for "did fitting help". */
  defaultLogLoss: number;
}

const DAY_MS = 86_400_000;
const META_KEY = 'fsrs_decay';

export function vaultDecay(store: Store): number {
  const raw = store.getMeta(META_KEY);
  if (raw === null) return DEFAULT_DECAY;
  const v = Number(raw);
  return Number.isFinite(v) ? clampDecay(v) : DEFAULT_DECAY;
}

export function fitDecay(
  store: Store,
  opts: { horizonDays?: number; minEvents?: number } = {},
): DecayFit | null {
  const horizon = (opts.horizonDays ?? 7) * DAY_MS;
  const minEvents = opts.minEvents ?? 50;

  const rows = store.db
    .prepare(
      `SELECT at, kind, block_id FROM access_log
       WHERE block_id IS NOT NULL AND kind IN ('retrieved','used')
       ORDER BY at, id`,
    )
    .all() as { at: string; kind: 'retrieved' | 'used'; block_id: number }[];

  const byBlock = new Map<number, { at: number; kind: 'retrieved' | 'used' }[]>();
  for (const r of rows) {
    const at = Date.parse(r.at);
    if (Number.isNaN(at)) continue;
    const list = byBlock.get(r.block_id);
    const ev = { at, kind: r.kind };
    if (list) list.push(ev);
    else byBlock.set(r.block_id, [ev]);
  }

  const evaluate = (decay: number): { loss: number; n: number } => {
    let total = 0;
    let n = 0;
    for (const events of byBlock.values()) {
      // Each 'used' credits at most ONE retrieval: the nearest preceding one
      // inside the horizon. Crediting every retrieval in the window made a
      // block used once a week score ~100% recall — its ignored retrievals,
      // which this module's own doc calls misses, were relabelled successes.
      // The optimizer then fitted inter-event CADENCE rather than memory
      // (measured: dense cadence → 0.8, sparse → 0.1), and a 0.1 fit pushes
      // R below findStale's 0.3 threshold so far out that `lore review`
      // could never surface a block again.
      const credited = new Set<number>();
      for (let i = 0; i < events.length; i++) {
        if (events[i]!.kind !== 'used') continue;
        for (let j = i - 1; j >= 0; j--) {
          if (events[j]!.kind !== 'retrieved') continue;
          if (events[i]!.at - events[j]!.at > horizon) break;
          if (!credited.has(j)) {
            credited.add(j);
            break;
          }
        }
      }
      let stability = 1.0;
      let prevAt: number | null = null;
      for (let i = 0; i < events.length; i++) {
        const ev = events[i]!;
        if (ev.kind === 'retrieved' && prevAt !== null) {
          const t = (ev.at - prevAt) / DAY_MS;
          const r = retrievability(t, stability, decay);
          const used = credited.has(i);
          const p = Math.min(1 - 1e-6, Math.max(1e-6, r));
          total += used ? -Math.log(p) : -Math.log(1 - p);
          n++;
        }
        if (ev.kind === 'used') {
          const t = prevAt === null ? 0 : (ev.at - prevAt) / DAY_MS;
          stability = reinforce(stability, retrievability(t, stability, decay));
        }
        prevAt = ev.at;
      }
    }
    return { loss: n > 0 ? total / n : Infinity, n };
  };

  const defaultEval = evaluate(DEFAULT_DECAY);
  if (defaultEval.n < minEvents) return null;

  let best = { decay: DEFAULT_DECAY, loss: defaultEval.loss };
  for (let d = 0.1; d <= 0.801; d += 0.05) {
    const decay = Number(d.toFixed(2));
    const { loss } = evaluate(decay);
    if (loss < best.loss) best = { decay, loss };
  }

  return {
    decay: best.decay,
    events: defaultEval.n,
    logLoss: Number(best.loss.toFixed(4)),
    defaultLogLoss: Number(defaultEval.loss.toFixed(4)),
  };
}

/** Persist a fit (dream calls this so the whole engine picks it up). */
export function storeDecay(store: Store, decay: number): void {
  store.setMeta(META_KEY, String(clampDecay(decay)));
}
