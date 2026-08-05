import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { openStore } from '../src/store/db.js';
import { indexVault } from '../src/index/indexer.js';
import {
  aggregateFacts,
  assertFact,
  invalidateFact,
  queryFacts,
} from '../src/facts/model.js';
import { parseFactLines, renderFactLine } from '../src/facts/journal.js';
import { ConfigSchema } from '../src/config.js';
import { buildGraph, type LoreGraph } from '../src/graph/build.js';
import type { LoreContext } from '../src/context.js';
import { makeVault } from './helpers.js';

async function emptyCtx(): Promise<LoreContext> {
  const root = await makeVault({ 'seed.md': 'hello world\n' });
  const config = ConfigSchema.parse({});
  const store = openStore(':memory:');
  await indexVault(store, root);
  let cached: LoreGraph | null = null;
  return {
    root,
    config,
    store,
    provider: null,
    graph: () => (cached ??= buildGraph(store, config)),
    invalidateGraph: () => (cached = null),
    close: () => store.close(),
  };
}

describe('fact lines', () => {
  it('parse ↔ render round-trip', () => {
    const line = '- [fact] Ambuj :: works_at :: Motherson {valid_from=2025-11-01, confidence=0.9}';
    const parsed = parseFactLines(line);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({
      kind: 'fact',
      subject: 'Ambuj',
      predicate: 'works_at',
      object: 'Motherson',
    });
    const rendered = renderFactLine(parsed[0]!);
    expect(parseFactLines(rendered)[0]).toEqual(parsed[0]);
  });

  it('objects containing :: and braces survive round-trip verbatim', () => {
    const f = {
      kind: 'fact' as const,
      subject: 'Config',
      predicate: 'value',
      object: 'a::b {weird} :: more',
      attrs: { valid_from: '2026-01-01' },
    };
    const parsed = parseFactLines(renderFactLine(f));
    expect(parsed).toHaveLength(1);
    expect(parsed[0]!.object).toBe('a::b {weird} :: more');
    expect(parsed[0]!.attrs.valid_from).toBe('2026-01-01');
  });

  it('newlines and backslashes round-trip losslessly (line-based journal)', () => {
    const object = 'line one\nline two :: fake\\path\r\nend';
    const rendered = renderFactLine({
      kind: 'fact',
      subject: 'Note',
      predicate: 'body',
      object,
      attrs: { valid_from: '2026-01-01' },
    });
    expect(rendered.split('\n')).toHaveLength(1); // stays ONE line
    const parsed = parseFactLines(rendered);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]!.object).toBe(object);
  });

  it('ignores malformed lines', () => {
    expect(parseFactLines('- [fact] only-subject')).toHaveLength(0);
    expect(parseFactLines('- [fact] a :: b')).toHaveLength(0);
    expect(parseFactLines('- normal bullet')).toHaveLength(0);
  });
});

describe('assert / supersede / time-travel', () => {
  it('contradiction supersedes with typed link, never deletes', async () => {
    const ctx = await emptyCtx();
    assertFact(ctx, {
      subject: 'Ambuj',
      predicate: 'lives_in',
      object: 'Lucknow',
      validFrom: '2020-01-01',
    });
    const r2 = assertFact(ctx, {
      subject: 'Ambuj',
      predicate: 'lives_in',
      object: 'Hyderabad',
      validFrom: '2025-11-01',
    });
    expect(r2.superseded).toHaveLength(1);
    expect(r2.superseded[0]!.object).toBe('Lucknow');
    expect(r2.superseded[0]!.validUntil).toBe('2025-11-01');

    // both rows still exist
    const all = queryFacts(ctx.store, { subject: 'Ambuj', includeHistory: true });
    expect(all).toHaveLength(2);
    // typed link exists
    const link = ctx.store.db
      .prepare(`SELECT type FROM fact_links WHERE type='updates'`)
      .all();
    expect(link).toHaveLength(1);
    ctx.close();
  });

  it('current query returns only the fresh fact; asOf time-travels', async () => {
    const ctx = await emptyCtx();
    assertFact(ctx, {
      subject: 'Ambuj',
      predicate: 'lives_in',
      object: 'Lucknow',
      validFrom: '2020-01-01',
    });
    assertFact(ctx, {
      subject: 'Ambuj',
      predicate: 'lives_in',
      object: 'Hyderabad',
      validFrom: '2025-11-01',
    });
    const current = queryFacts(ctx.store, { subject: 'Ambuj', predicate: 'lives_in' });
    expect(current).toHaveLength(1);
    expect(current[0]!.object).toBe('Hyderabad');

    const then = queryFacts(ctx.store, {
      subject: 'Ambuj',
      predicate: 'lives_in',
      asOf: '2023-06-15',
    });
    expect(then).toHaveLength(1);
    expect(then[0]!.object).toBe('Lucknow');

    // on the transition date the new fact wins
    const transition = queryFacts(ctx.store, {
      subject: 'Ambuj',
      predicate: 'lives_in',
      asOf: '2025-11-01',
    });
    expect(transition).toHaveLength(1);
    expect(transition[0]!.object).toBe('Hyderabad');
    ctx.close();
  });

  it('same object re-assertion extends instead of superseding', async () => {
    const ctx = await emptyCtx();
    assertFact(ctx, { subject: 'X', predicate: 'is', object: 'Y', validFrom: '2024-01-01' });
    const r = assertFact(ctx, { subject: 'X', predicate: 'is', object: 'Y', validFrom: '2025-01-01' });
    expect(r.superseded).toHaveLength(0);
    const links = ctx.store.db.prepare(`SELECT type FROM fact_links`).all() as any[];
    expect(links.some((l) => l.type === 'extends')).toBe(true);
    ctx.close();
  });

  it('invalidate closes open facts', async () => {
    const ctx = await emptyCtx();
    assertFact(ctx, { subject: 'P', predicate: 'status', object: 'active', validFrom: '2026-01-01' });
    const r = invalidateFact(ctx, { subject: 'P', predicate: 'status', validUntil: '2026-06-01' });
    expect(r.closed).toBe(1);
    expect(queryFacts(ctx.store, { subject: 'P' })).toHaveLength(0);
    expect(queryFacts(ctx.store, { subject: 'P', asOf: '2026-03-01' })).toHaveLength(1);
    ctx.close();
  });

  it('journal write-back → reindex reproduces identical fact state', async () => {
    const ctx = await emptyCtx();
    assertFact(ctx, {
      subject: 'Ambuj',
      predicate: 'lives_in',
      object: 'Lucknow',
      validFrom: '2020-01-01',
    });
    assertFact(ctx, {
      subject: 'Ambuj',
      predicate: 'lives_in',
      object: 'Hyderabad',
      validFrom: '2025-11-01',
    });
    invalidateFact(ctx, { subject: 'Ambuj', predicate: 'lives_in', validUntil: '2026-07-01' });

    const dump = () =>
      ctx.store.db
        .prepare(
          `SELECT subject, predicate, object, valid_from, valid_until, source_type, confidence
           FROM facts ORDER BY subject, predicate, COALESCE(valid_from, recorded_at)`,
        )
        .all();
    const before = dump();
    expect(before).toHaveLength(2);

    // journal file exists in the vault
    const today = new Date().toISOString().slice(0, 10);
    const journal = await readFile(join(ctx.root, `lore/journal/${today}.md`), 'utf8');
    expect(journal).toContain('[fact] Ambuj :: lives_in :: Hyderabad');
    expect(journal).toContain('[invalidate] Ambuj :: lives_in');

    // full replay from files only
    await indexVault(ctx.store, ctx.root, { full: true });
    expect(dump()).toEqual(before);
    ctx.close();
  });

  it('aggregates count over history (the computable layer)', async () => {
    const ctx = await emptyCtx();
    assertFact(ctx, { subject: 'trip-1', predicate: 'trip_to', object: 'Japan', validFrom: '2025-03-01' });
    assertFact(ctx, { subject: 'trip-2', predicate: 'trip_to', object: 'Japan', validFrom: '2025-09-01' });
    assertFact(ctx, { subject: 'trip-3', predicate: 'trip_to', object: 'Kenya', validFrom: '2026-01-15' });
    const byPlace = aggregateFacts(ctx.store, { predicate: 'trip_to', groupBy: 'object' });
    expect(byPlace[0]).toEqual({ group: 'Japan', count: 2 });
    const in2025 = aggregateFacts(ctx.store, {
      predicate: 'trip_to',
      since: '2025-01-01',
      until: '2025-12-31',
    });
    expect(in2025.reduce((a, b) => a + b.count, 0)).toBe(2);
    ctx.close();
  });

  it('validates inputs', async () => {
    const ctx = await emptyCtx();
    expect(() =>
      assertFact(ctx, { subject: '', predicate: 'p', object: 'o' }),
    ).toThrow(/required/);
    expect(() =>
      assertFact(ctx, { subject: 's', predicate: 'p', object: 'o', validFrom: 'March 5' }),
    ).toThrow(/ISO date/);
    expect(() =>
      assertFact(ctx, { subject: 's', predicate: 'p', object: 'o', confidence: 2 }),
    ).toThrow(/confidence/);
    ctx.close();
  });
});
