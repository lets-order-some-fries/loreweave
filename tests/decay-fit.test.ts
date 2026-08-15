import { describe, expect, it } from 'vitest';
import { openStore } from '../src/store/db.js';
import { DEFAULT_DECAY, retrievability } from '../src/dynamics/fsrs.js';
import { fitDecay, storeDecay, vaultDecay } from '../src/dynamics/fit.js';

/**
 * FSRS-6's headline change is that the forgetting curve's SHAPE is a
 * parameter. The invariant that makes stability meaningful must survive any
 * shape: R(S, S) = 0.9 — "stability is days until retrievability hits 90%".
 */
describe('FSRS-6 curve', () => {
  it('R(S,S) = 0.9 for every decay in range', () => {
    for (const d of [0.1, 0.2, 0.35, 0.5, 0.65, 0.8]) {
      expect(retrievability(10, 10, d)).toBeCloseTo(0.9, 10);
    }
  });

  it('decay 0.5 reproduces the old FSRS-4.5 constants exactly', () => {
    // Old code: (1 + (19/81)·t/s)^(-0.5). Backward compatibility is exact,
    // not approximate — existing vaults must rank identically until a fit
    // says otherwise.
    const old = (t: number, s: number) => Math.pow(1 + ((19 / 81) * t) / s, -0.5);
    for (const [t, s] of [[0, 10], [5, 10], [10, 10], [100, 10], [365, 30]] as const) {
      expect(retrievability(t, s, 0.5)).toBeCloseTo(old(t, s), 15);
      expect(retrievability(t, s)).toBeCloseTo(old(t, s), 15); // and it is the default
    }
  });

  it('a flatter decay retains more at long horizons, same 90% anchor', () => {
    // Human-fitted decays (<0.2) mean slower long-run forgetting. At t = 10S
    // the flat curve must sit well above the steep one; at t = S both at 0.9.
    expect(retrievability(100, 10, 0.15)).toBeGreaterThan(retrievability(100, 10, 0.5));
    expect(retrievability(1, 10, 0.15)).toBeGreaterThan(0.9);
  });

  it('an out-of-range or garbage decay clamps instead of corrupting scores', () => {
    expect(retrievability(50, 10, 5)).toBe(retrievability(50, 10, 0.8));
    expect(retrievability(50, 10, Number.NaN)).toBe(retrievability(50, 10, DEFAULT_DECAY));
  });
});

/** access_log.block_id has a real FK — give it real blocks to point at. */
function seedBlocks(store: ReturnType<typeof openStore>, n: number): void {
  store.db
    .prepare(
      `INSERT INTO notes(path,title,frontmatter,tags,hash,mtime_ms,size,indexed_at)
       VALUES ('n.md','N','{}','[]','h',0,0,'2026-01-01')`,
    )
    .run();
  const b = store.db.prepare(
    `INSERT INTO blocks(id,note_path,anchor,heading,ord,text,hash) VALUES (?,'n.md',?,'',?,?,?)`,
  );
  for (let i = 1; i <= n; i++) b.run(i, `a${i}`, i, `block ${i}`, `h${i}`);
}

/** Build an access log where use does / does not survive long gaps. */
function logHistory(
  store: ReturnType<typeof openStore>,
  pattern: 'long-memory' | 'short-memory',
): void {
  const day = 86_400_000;
  const t0 = Date.parse('2026-01-01T00:00:00Z');
  seedBlocks(store, 60);
  const ins = store.db.prepare(`INSERT INTO access_log(at,kind,query,block_id) VALUES (?,?,?,?)`);
  // 60 blocks, each: used at day 0, retrieved after a LONG gap, then either
  // used again (long-memory vault: old knowledge still pays off) or ignored
  // (short-memory vault: only fresh material gets used).
  for (let b = 1; b <= 60; b++) {
    ins.run(new Date(t0 + b * 1000).toISOString(), 'used', null, b);
    const gap = 30 * day; // 30 days later it resurfaces in results
    ins.run(new Date(t0 + b * 1000 + gap).toISOString(), 'retrieved', 'q', b);
    if (pattern === 'long-memory') {
      ins.run(new Date(t0 + b * 1000 + gap + 60_000).toISOString(), 'used', null, b);
    }
  }
}

describe('per-vault decay fit', () => {
  it('a vault whose old knowledge still gets used fits a flatter curve', () => {
    const store = openStore(':memory:');
    logHistory(store, 'long-memory');
    const fit = fitDecay(store);
    expect(fit).not.toBeNull();
    // Every 30-day-old retrieval led to a use: the curve that explains this
    // retains more at long gaps, i.e. a LOWER decay than the default.
    expect(fit!.decay).toBeLessThan(DEFAULT_DECAY);
    expect(fit!.logLoss).toBeLessThanOrEqual(fit!.defaultLogLoss);
    store.close();
  });

  it('a vault where only fresh material gets used fits a steeper curve', () => {
    const store = openStore(':memory:');
    logHistory(store, 'short-memory');
    const fit = fitDecay(store);
    expect(fit).not.toBeNull();
    // Every 30-day-old retrieval was ignored: low predicted R fits better,
    // i.e. decay at or above the default.
    expect(fit!.decay).toBeGreaterThanOrEqual(DEFAULT_DECAY);
    store.close();
  });

  it('one use does not relabel a week of ignored retrievals as successes', () => {
    // A block used once a week had EVERY retrieval that week counted a hit —
    // including the ignored ones this module's doc calls misses — so the fit
    // saw ~100% recall and chased inter-event cadence instead of memory. Each
    // use credits at most the nearest preceding retrieval now.
    const store = openStore(':memory:');
    seedBlocks(store, 6);
    const ins = store.db.prepare(`INSERT INTO access_log(at,kind,query,block_id) VALUES (?,?,?,?)`);
    const day = 86_400_000;
    const t0 = Date.parse('2026-01-01T00:00:00Z');
    for (let blk = 1; blk <= 6; blk++) {
      for (let week = 0; week < 4; week++) {
        for (let i = 0; i < 10; i++) {
          ins.run(new Date(t0 + week * 7 * day + i * 3600_000).toISOString(), 'retrieved', 'q', blk);
        }
        ins.run(new Date(t0 + week * 7 * day + 6 * day).toISOString(), 'used', null, blk);
      }
    }
    const fit = fitDecay(store)!;
    // Mostly-ignored retrievals must read as mostly-misses: a near-zero loss
    // would mean the labels had been inflated to all-success again.
    expect(fit.logLoss).toBeGreaterThan(0.5);
    store.close();
  });

  it('thin history refuses to fit — the default shape stays', () => {
    const store = openStore(':memory:');
    seedBlocks(store, 1);
    const ins = store.db.prepare(`INSERT INTO access_log(at,kind,query,block_id) VALUES (?,?,?,?)`);
    ins.run('2026-01-01T00:00:00Z', 'used', null, 1);
    ins.run('2026-01-05T00:00:00Z', 'retrieved', 'q', 1);
    expect(fitDecay(store)).toBeNull();
    expect(vaultDecay(store)).toBe(DEFAULT_DECAY);
    store.close();
  });

  it('a stored fit is what every consumer reads back, clamped', () => {
    const store = openStore(':memory:');
    storeDecay(store, 0.15);
    expect(vaultDecay(store)).toBe(0.15);
    storeDecay(store, 99);
    expect(vaultDecay(store)).toBe(0.8);
    store.close();
  });
});
