import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { openStore } from '../src/store/db.js';
import { indexVault, indexState } from '../src/index/indexer.js';

/**
 * Interrupting a long index is something people do — Ctrl-C, a closed laptop,
 * a killed container. The index is a disposable cache and recovers by
 * rebuilding, but until it does it describes only itself, and every consumer
 * that reads it as a description of the VAULT will be confidently wrong.
 */
const VAULT: Record<string, string> = {
  'a.md': '# Alpha\n\nLinks to [[Beta]] and [[Gamma]]. Distinctive: PANGOLIN.\n',
  'b.md': '# Beta\n\nBack to [[Alpha]].\n',
  'sub/c.md': '# Gamma\n\nSee [[Beta]].\n',
};

async function makeVault(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'lw-int-'));
  for (const [p, c] of Object.entries(VAULT)) {
    await mkdir(dirname(join(root, p)), { recursive: true });
    await writeFile(join(root, p), c);
  }
  return root;
}

/** The state a killed process leaves behind: a marker naming a dead PID. */
function simulateInterrupt(store: ReturnType<typeof openStore>) {
  // 2^22 is above any real PID on Linux and macOS, so it never collides with
  // a live process and never reads as "still running".
  store.setMeta('index_in_progress', String(2 ** 22));
}

describe('an interrupted index', () => {
  it('is reported as incomplete rather than as a broken vault', async () => {
    // Measured on a 1 200-note vault killed mid-index: `doctor` reported
    // "broken links: 1091" for a vault whose links are all fine — the notes
    // they point at simply had not been indexed yet. A health report that
    // invents a catastrophe is worse than one that says it cannot tell.
    const root = await makeVault();
    const store = openStore(':memory:');
    await indexVault(store, root);
    expect(indexState(store)).toBe('clean');

    simulateInterrupt(store);
    expect(indexState(store)).toBe('interrupted');
    store.close();
  });

  it('a live index is distinguished from a dead one', async () => {
    // A bare "1" could not tell "a previous run crashed" from "another run is
    // happening now", and two concurrent indexes each declared the other dead.
    const store = openStore(':memory:');
    // A genuinely-alive OTHER process (our parent) reads as running.
    store.setMeta('index_in_progress', String(process.ppid));
    expect(indexState(store)).toBe('running');
    // A dead foreign PID reads as interrupted.
    store.setMeta('index_in_progress', String(2 ** 22));
    expect(indexState(store)).toBe('interrupted');
    store.close();
  });

  it('an own-PID marker with no index in flight is a crash, not a live run', async () => {
    // process.kill(self, 0) always succeeds, so an own-PID marker cannot be
    // resolved by liveness — it is exactly what a mid-loop throw leaves behind
    // in a long-lived process (lore watch, the MCP server). Treating it as
    // "running" defeated self-heal: the half-built derived state was never
    // repaired and the marker was then cleared so no later run could fix it.
    const store = openStore(':memory:');
    store.setMeta('index_in_progress', String(process.pid));
    expect(indexState(store)).toBe('interrupted');
    store.close();
  });

  it('recovers to exactly the state a clean index would have produced', async () => {
    const root = await makeVault();

    const recovered = openStore(':memory:');
    await indexVault(recovered, root);
    // throw away half the work, then mark it as interrupted
    recovered.db.prepare(`DELETE FROM notes WHERE path != 'a.md'`).run();
    simulateInterrupt(recovered);
    await indexVault(recovered, root);
    expect(indexState(recovered)).toBe('clean');

    const fresh = openStore(':memory:');
    await indexVault(fresh, root);

    const snap = (s: ReturnType<typeof openStore>) =>
      JSON.stringify(
        s.db
          .prepare(
            `SELECT note_path, anchor, heading, text FROM blocks ORDER BY note_path, anchor`,
          )
          .all(),
      );
    expect(snap(recovered)).toBe(snap(fresh));

    const links = recovered.db.prepare(`SELECT COUNT(*) c FROM links`).get() as { c: number };
    const freshLinks = fresh.db.prepare(`SELECT COUNT(*) c FROM links`).get() as { c: number };
    expect(links.c).toBe(freshLinks.c);

    recovered.close();
    fresh.close();
  });

  it('self-heals a crash whose marker holds THIS process’s own PID', async () => {
    // The real long-lived callers — lore watch, the MCP server — catch a
    // mid-index throw and keep running, so the marker left behind holds their
    // own still-alive PID. process.kill(self, 0) always succeeds, so the old
    // code read that as "running" and never repaired the half-built derived
    // state (nor, after clearing the marker, could any later run). The suite
    // above only ever simulated interruption with a foreign dead PID, so this
    // path was untested.
    const root = await makeVault();
    const store = openStore(':memory:');
    await indexVault(store, root);
    const facts = () =>
      (store.db.prepare(`SELECT COUNT(*) c FROM mentions`).get() as { c: number }).c;
    const before = facts();
    expect(before).toBeGreaterThan(0);

    // Simulate a crash mid-loop in THIS process: wipe derived state, leave the
    // marker holding our own PID.
    store.db.prepare(`DELETE FROM mentions`).run();
    store.setMeta('index_in_progress', String(process.pid));
    expect(indexState(store)).toBe('interrupted');

    // A reindex in the SAME process (no file changes) must full-rebuild and warn.
    const report = await indexVault(store, root);
    expect(facts()).toBe(before); // mentions rebuilt
    expect(report.warnings.some((w) => w.includes('did not finish'))).toBe(true);
    expect(indexState(store)).toBe('clean');
    store.close();
  });

  it('a clean second index in one process does not force a needless full rebuild', async () => {
    // The own-PID handling must not mistake a normally-cleared marker for a
    // crash: a plain reindex should report everything unchanged, not rebuilt.
    const root = await makeVault();
    const store = openStore(':memory:');
    await indexVault(store, root);
    const report = await indexVault(store, root);
    expect(report.added + report.updated + report.removed).toBe(0);
    expect(report.warnings.some((w) => w.includes('did not finish'))).toBe(false);
    store.close();
  });
});
