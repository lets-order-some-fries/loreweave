import { describe, expect, it } from 'vitest';
import { rm } from 'node:fs/promises';
import { openStore } from '../src/store/db.js';
import { indexVault } from '../src/index/indexer.js';
import { FIXTURE_VAULT, editFile, makeVault } from './helpers.js';

describe('indexVault', () => {
  it('full journey: add, idempotent re-run, edit, delete', async () => {
    const root = await makeVault(FIXTURE_VAULT);
    const store = openStore(':memory:');

    const r1 = await indexVault(store, root);
    expect(r1.added).toBe(Object.keys(FIXTURE_VAULT).length);
    expect(r1.removed).toBe(0);

    // idempotent second run
    const r2 = await indexVault(store, root);
    expect(r2.added).toBe(0);
    expect(r2.updated).toBe(0);
    expect(r2.unchanged).toBe(r1.added);

    // edit one note
    await editFile(root, 'notes/unrelated.md', '---\ntitle: Grocery Plans\n---\n\nNow with tofu.\n');
    const r3 = await indexVault(store, root);
    expect(r3.updated).toBe(1);
    expect(r3.added).toBe(0);

    // delete a note
    await rm(`${root}/misc/decoy.md`);
    const r4 = await indexVault(store, root);
    expect(r4.removed).toBe(1);
    expect(store.listNotes().has('misc/decoy.md')).toBe(false);

    store.close();
  });

  it('mentions link notes through shared entities', async () => {
    const root = await makeVault(FIXTURE_VAULT);
    const store = openStore(':memory:');
    await indexVault(store, root);
    const rows = store.db
      .prepare(
        `SELECT DISTINCT m.note_path FROM mentions m
         JOIN entities e ON e.id = m.entity_id WHERE e.key = 'amara osei'`,
      )
      .all() as { note_path: string }[];
    const paths = rows.map((r) => r.note_path).sort();
    expect(paths).toContain('people/amara-osei.md');
    expect(paths).toContain('projects/riverbed.md');
    store.close();
  });

  it('journal facts are ingested with bitemporal fields', async () => {
    const root = await makeVault(FIXTURE_VAULT);
    const store = openStore(':memory:');
    await indexVault(store, root);
    const facts = store.db.prepare(`SELECT * FROM facts ORDER BY id`).all() as any[];
    expect(facts.length).toBe(2);
    const work = facts.find((f) => f.predicate === 'works at');
    expect(work.subject).toBe('ambuj');
    expect(work.object).toBe('Motherson');
    expect(work.valid_from).toBe('2025-11-01');
    expect(work.source_type).toBe('stated');
    store.close();
  });

  it('reindex is fact-idempotent (no duplicates)', async () => {
    const root = await makeVault(FIXTURE_VAULT);
    const store = openStore(':memory:');
    await indexVault(store, root);
    await editFile(root, 'notes/new.md', 'trigger a change\n');
    await indexVault(store, root);
    const c = store.db.prepare(`SELECT COUNT(*) c FROM facts`).get() as any;
    expect(c.c).toBe(2);
    store.close();
  });

  it('entity pruning removes orphans after note deletion', async () => {
    const root = await makeVault({ 'a.md': 'About [[Zanzibar Quorum]] only here.\n' });
    const store = openStore(':memory:');
    await indexVault(store, root);
    expect(
      store.db.prepare(`SELECT COUNT(*) c FROM entities WHERE key='zanzibar quorum'`).get(),
    ).toMatchObject({ c: 1 });
    await rm(`${root}/a.md`);
    await indexVault(store, root);
    expect(
      store.db.prepare(`SELECT COUNT(*) c FROM entities WHERE key='zanzibar quorum'`).get(),
    ).toMatchObject({ c: 0 });
    store.close();
  });
});
