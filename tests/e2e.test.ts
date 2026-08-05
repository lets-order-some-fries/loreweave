import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { openStore } from '../src/store/db.js';
import { indexVault } from '../src/index/indexer.js';
import { search } from '../src/retrieve/search.js';
import { assertFact, queryFacts } from '../src/facts/model.js';
import { dream } from '../src/dream/dream.js';
import { ConfigSchema } from '../src/config.js';
import { buildGraph, type LoreGraph } from '../src/graph/build.js';
import { buildNoteLinkGraph } from '../src/retrieve/expand.js';
import type { LoreContext } from '../src/context.js';
import { FIXTURE_VAULT, editFile, makeVault } from './helpers.js';

const exec = promisify(execFile);

function ctxFor(root: string, store: ReturnType<typeof openStore>): LoreContext {
  const config = ConfigSchema.parse({});
  let cached: LoreGraph | null = null;
  return {
    root,
    config,
    store,
    provider: null,
    graph: () => (cached ??= buildGraph(store, config)),
    noteLinks: () => buildNoteLinkGraph(store),
    invalidateGraph: () => (cached = null),
    close: () => store.close(),
  };
}

/** Logical dump of everything derived — used for determinism assertions. */
function dump(store: ReturnType<typeof openStore>): string {
  const q = (sql: string) => JSON.stringify(store.db.prepare(sql).all());
  return [
    q(`SELECT path, title, tags, hash FROM notes ORDER BY path`),
    q(`SELECT note_path, anchor, heading, ord, hash FROM blocks ORDER BY note_path, ord`),
    q(`SELECT note_path, block_anchor, target_norm FROM links ORDER BY note_path, target_norm`),
    q(`SELECT key FROM entities ORDER BY key`),
    q(
      `SELECT e.key, m.note_path, m.block_anchor, m.source FROM mentions m
       JOIN entities e ON e.id=m.entity_id ORDER BY e.key, m.note_path, m.block_anchor, m.source`,
    ),
    q(
      `SELECT subject, predicate, object, valid_from, valid_until, source_type
       FROM facts ORDER BY subject, predicate, COALESCE(valid_from, recorded_at)`,
    ),
  ].join('\n');
}

describe('e2e', () => {
  it('index is deterministic: full rebuild reproduces identical derived state', async () => {
    const root = await makeVault(FIXTURE_VAULT);
    const a = openStore(':memory:');
    await indexVault(a, root);
    const first = dump(a);

    // rebuild in the same store
    await indexVault(a, root, { full: true });
    expect(dump(a)).toBe(first);

    // rebuild in a fresh store
    const b = openStore(':memory:');
    await indexVault(b, root);
    expect(dump(b)).toBe(first);

    a.close();
    b.close();
  });

  it('full journey: index → search → assert → supersede → time-travel → dream → reindex', async () => {
    const root = await makeVault(FIXTURE_VAULT);
    const store = openStore(':memory:');
    const ctx = ctxFor(root, store);

    await indexVault(store, root);
    ctx.invalidateGraph();

    // retrieval works
    const hits = await search(ctx, 'glacier meltwater', { k: 3 });
    expect(hits[0]!.notePath).toBe('data/glacier-dataset.md');

    // knowledge evolves
    assertFact(ctx, {
      subject: 'Riverbed Protocol',
      predicate: 'status',
      object: 'unblocked',
      validFrom: '2026-08-04',
    });
    const current = queryFacts(store, { subject: 'Riverbed Protocol', predicate: 'status' });
    expect(current).toHaveLength(1);
    expect(current[0]!.object).toBe('unblocked');
    const past = queryFacts(store, {
      subject: 'Riverbed Protocol',
      predicate: 'status',
      asOf: '2026-07-25',
    });
    expect(past[0]!.object).toBe('blocked');

    // dream sees the change
    const report = dream(ctx, { apply: true });
    expect(report.contradictions.some((c) => c.kind === 'recent-supersession')).toBe(true);
    expect(existsSync(join(root, 'lore/review-queue.md'))).toBe(true);

    // a human edits the vault; reindex picks it up without losing facts
    await editFile(
      root,
      'projects/riverbed.md',
      '---\ntitle: Riverbed Protocol\n---\n\nNow unblocked and shipping. See [[Amara Osei]].\n',
    );
    const r = await indexVault(store, root);
    expect(r.updated).toBeGreaterThanOrEqual(1);
    ctx.invalidateGraph();
    expect(queryFacts(store, { subject: 'Riverbed Protocol', predicate: 'status' })[0]!.object).toBe(
      'unblocked',
    );

    // digest content is sane
    const digest = await readFile(join(root, `lore/digests/${report.generatedAt.slice(0, 10)}.md`), 'utf8');
    expect(digest).toContain('Vault digest');

    ctx.close();
  });

  it('engine works with zero configuration on an empty vault', async () => {
    const root = await makeVault({ 'only.md': '# Hello\n\njust one note\n' });
    const store = openStore(':memory:');
    const ctx = ctxFor(root, store);
    await indexVault(store, root);
    ctx.invalidateGraph();
    expect((await search(ctx, 'hello')).length).toBeGreaterThan(0);
    expect(() => dream(ctx)).not.toThrow();
    ctx.close();
  });

  it('built CLI binary runs (smoke)', async () => {
    const dist = join(process.cwd(), 'dist/cli/main.js');
    if (!existsSync(dist)) return; // build not run in this environment
    const root = await makeVault(FIXTURE_VAULT);
    await mkdir(join(root, '.lore'), { recursive: true });
    const { stdout } = await exec(process.execPath, [dist, '--vault', root, 'index']);
    expect(stdout).toMatch(/indexed: \+\d+/);
    const s = await exec(process.execPath, [dist, '--vault', root, 'search', 'meltwater']);
    expect(s.stdout).toContain('glacier-dataset');
  });
});
