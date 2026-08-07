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
    store.setMeta('index_in_progress', String(process.pid));
    expect(indexState(store)).toBe('running');
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
});
