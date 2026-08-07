import { watch, type FSWatcher } from 'node:fs';
import { join } from 'node:path';
import type { LoreContext } from './context.js';
import { indexVault } from './index/indexer.js';
import { isDerivedNote } from './vault/scan.js';
import type { IndexReport } from './types.js';

export interface WatchOptions {
  /** Quiet period after the last change before reindexing. */
  debounceMs?: number;
  /**
   * Ceiling on how long a reindex may be deferred while changes keep arriving.
   * A plain debounce restarts its timer on every event, so a vault that never
   * goes quiet is never reindexed at all — and the things that keep a vault
   * busy are exactly the ones that matter: a sync client landing another
   * device's notes, a bulk import, `git checkout` of a large branch, an agent
   * capturing as it works. Measured before this ceiling: six seconds of writes
   * 120 ms apart produced zero reindexes, so every search in that window
   * answered from a stale index with nothing to indicate it.
   */
  maxWaitMs?: number;
  onReindex?: (report: IndexReport) => void;
  onError?: (err: Error) => void;
}

export interface Watcher {
  close(): void;
}

/**
 * Reindex on change.
 *
 * Without this, every stale answer traces back to "did you remember to run
 * `lore index`?" — which is a question no one should have to think about, and
 * an agent cannot think about at all. Warm reindexes are ~20-40ms, so the
 * cheapest correct policy is simply to re-run one on a debounce.
 */
export function watchVault(ctx: LoreContext, opts: WatchOptions = {}): Watcher {
  const debounceMs = opts.debounceMs ?? 400;
  // Never below the debounce, or the ceiling would defeat the quiet period.
  const maxWaitMs = Math.max(opts.maxWaitMs ?? 2000, debounceMs);
  let timer: NodeJS.Timeout | null = null;
  /** When the current burst of changes started; null between bursts. */
  let burstStart: number | null = null;
  let running = false;
  let queued = false;
  let watcher: FSWatcher | null = null;

  const reindex = async () => {
    if (running) {
      queued = true; // coalesce: never run two indexes concurrently
      return;
    }
    running = true;
    try {
      const report = await indexVault(ctx.store, ctx.root, {
        factExtract: ctx.config.facts.extract,
        nlp: ctx.config.nlp,
      });
      ctx.invalidateGraph();
      if (report.added || report.updated || report.removed) opts.onReindex?.(report);
    } catch (err) {
      opts.onError?.(err as Error);
    } finally {
      running = false;
      if (queued) {
        queued = false;
        schedule();
      }
    }
  };

  const schedule = () => {
    const now = Date.now();
    burstStart ??= now;
    if (timer) clearTimeout(timer);
    // Normally the full quiet period; as a sustained burst approaches the
    // ceiling this shrinks to zero, so a busy vault reindexes on a steady
    // cadence instead of waiting for a silence that may never come.
    const delay = Math.max(0, Math.min(debounceMs, maxWaitMs - (now - burstStart)));
    timer = setTimeout(() => {
      timer = null;
      burstStart = null;
      void reindex();
    }, delay);
  };

  try {
    watcher = watch(ctx.root, { recursive: true }, (_event, filename) => {
      if (!filename) {
        schedule();
        return;
      }
      const rel = String(filename).split(/[\\/]/).join('/');
      // Ignore the index itself and our own generated notes, or writing a
      // digest would trigger the reindex that regenerates it.
      if (rel.startsWith('.lore/') || rel.includes('/.lore/')) return;
      if (!/\.md$/i.test(rel)) return;
      if (isDerivedNote(rel)) return;
      schedule();
    });
  } catch (err) {
    // recursive watch is unsupported on some platforms/filesystems
    opts.onError?.(
      new Error(
        `cannot watch ${ctx.root}: ${(err as Error).message}. Re-run 'lore index' manually after edits.`,
      ),
    );
  }

  return {
    close() {
      if (timer) clearTimeout(timer);
      watcher?.close();
    },
  };
}

/** Path of the index DB, so callers can avoid watching it. */
export function indexDbPath(root: string): string {
  return join(root, '.lore', 'index.db');
}
