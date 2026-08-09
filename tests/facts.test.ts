import { describe, expect, it } from 'vitest';
import { renderFactLine, parseFactLines } from '../src/facts/journal.js';
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
import { buildNoteLinkGraph } from '../src/retrieve/expand.js';
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
    noteLinks: () => buildNoteLinkGraph(store),
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
    expect(byPlace.groups[0]).toEqual({ group: 'Japan', count: 2 });
    expect(byPlace.totalGroups).toBe(2); // Japan and Kenya — nothing hidden
    const in2025 = aggregateFacts(ctx.store, {
      predicate: 'trip_to',
      since: '2025-01-01',
      until: '2025-12-31',
    });
    expect(in2025.groups.reduce((a, b) => a + b.count, 0)).toBe(2);
    ctx.close();
  });

  it('reports the number of groups that exist, not just the ones returned', async () => {
    // The query has always capped at 100 groups and said nothing, so "the
    // computable layer" answered a question about 150 distinct values with
    // 100 rows and no indication that it had stopped counting.
    const ctx = await emptyCtx();
    for (let i = 0; i < 150; i++) {
      assertFact(ctx, {
        subject: `s${i}`,
        predicate: 'lives_in',
        object: `City ${i}`,
        validFrom: '2026-01-01',
      });
    }
    const agg = aggregateFacts(ctx.store, { predicate: 'lives_in', groupBy: 'object' });
    expect(agg.groups).toHaveLength(100);
    expect(agg.limit).toBe(100);
    expect(agg.totalGroups).toBe(150);

    const all = aggregateFacts(ctx.store, {
      predicate: 'lives_in',
      groupBy: 'object',
      limit: 500,
    });
    expect(all.groups).toHaveLength(150);
    expect(all.totalGroups).toBe(150);
    ctx.close();
  });

  it('rejects an unknown group-by instead of leaking a SQL error', async () => {
    // `lore count --group-by X` forwards X straight through; an unknown value
    // used to index to `undefined`, reach SQLite as `GROUP BY undefined`, and
    // surface as "no such column: undefined" — an internal error masquerading
    // as the user's mistake. A malformed since/until is likewise a hard error.
    const ctx = await emptyCtx();
    assertFact(ctx, { subject: 's', predicate: 'p', object: 'o', validFrom: '2026-01-01' });
    expect(() =>
      aggregateFacts(ctx.store, { predicate: 'p', groupBy: 'nonsense' as never }),
    ).toThrow(/group-by must be one of/);
    expect(() => aggregateFacts(ctx.store, { since: 'not-a-date' })).toThrow(/ISO date/);
    // the three real columns still work
    for (const groupBy of ['object', 'subject', 'predicate'] as const) {
      expect(aggregateFacts(ctx.store, { predicate: 'p', groupBy }).totalGroups).toBe(1);
    }
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

describe('record-time travel', () => {
  // The store has always kept both axes and only ever let you query one.
  // `asOf` alone rewrites the past every time something is backdated, so it
  // cannot answer why a decision made in March looked right in March.
  const backdateRecord = (ctx: LoreContext, object: string, recordedAt: string) =>
    ctx.store.db
      .prepare(`UPDATE facts SET recorded_at=? WHERE object=?`)
      .run(recordedAt, object);

  it('shows what was believed then, not what is believed now', async () => {
    const ctx = await emptyCtx();
    assertFact(ctx, {
      subject: 'Vendor',
      predicate: 'reliability',
      object: 'good',
      validFrom: '2024-01-01',
    });
    backdateRecord(ctx, 'good', '2024-01-05T00:00:00.000Z');
    // learned much later, but backdated to the same period
    assertFact(ctx, {
      subject: 'Vendor',
      predicate: 'reliability',
      object: 'poor',
      validFrom: '2024-01-01',
    });

    const trueThen = queryFacts(ctx.store, {
      subject: 'Vendor',
      asOf: '2024-06-01',
    });
    expect(trueThen[0]!.object).toBe('poor'); // what we now believe was true

    const knownThen = queryFacts(ctx.store, {
      subject: 'Vendor',
      asKnownAt: '2024-06-01',
    });
    expect(knownThen[0]!.object).toBe('good'); // what the decision was based on
    ctx.close();
  });

  it('excludes facts recorded after the date, however early they are valid from', async () => {
    const ctx = await emptyCtx();
    assertFact(ctx, {
      subject: 'S',
      predicate: 'p',
      object: 'learned late',
      validFrom: '2020-01-01',
    });
    expect(queryFacts(ctx.store, { subject: 'S', asOf: '2021-01-01' })).toHaveLength(1);
    expect(queryFacts(ctx.store, { subject: 'S', asKnownAt: '2021-01-01' })).toHaveLength(0);
    ctx.close();
  });

  it('combines with asOf for "true then, as far as we knew then"', async () => {
    const ctx = await emptyCtx();
    assertFact(ctx, { subject: 'S', predicate: 'p', object: 'first', validFrom: '2024-01-01' });
    backdateRecord(ctx, 'first', '2024-01-02T00:00:00.000Z');
    assertFact(ctx, { subject: 'S', predicate: 'p', object: 'second', validFrom: '2025-01-01' });
    backdateRecord(ctx, 'second', '2025-01-02T00:00:00.000Z');

    const both = queryFacts(ctx.store, {
      subject: 'S',
      asOf: '2024-06-01',
      asKnownAt: '2024-06-01',
    });
    expect(both.map((f) => f.object)).toEqual(['first']);
    ctx.close();
  });

  it('rejects a malformed date', async () => {
    const ctx = await emptyCtx();
    expect(() => queryFacts(ctx.store, { asKnownAt: 'last tuesday' })).toThrow(/ISO date/);
    ctx.close();
  });
});

describe('re-asserting a value does not break the slot', () => {
  it('leaves exactly one current fact after a value is re-confirmed', async () => {
    // Supersession only compared each record with its immediate neighbour, and
    // a same-value successor was linked 'extends' and left OPEN. So with
    // draft(Jan), draft(Mar), final(Aug): Aug closed Mar, and nothing ever
    // closed Jan, because Aug was not its neighbour. The slot was left
    // permanently with two current answers — `lore facts` printed
    // "final (2026-08-01 → now)" and "draft (2026-01-01 → now)" together — and
    // re-confirming a value is an ordinary thing to do.
    const ctx = await emptyCtx();
    assertFact(ctx, { subject: 'Ledger', predicate: 'status', object: 'draft', validFrom: '2026-01-01' });
    assertFact(ctx, { subject: 'Ledger', predicate: 'status', object: 'draft', validFrom: '2026-03-01' });
    assertFact(ctx, { subject: 'Ledger', predicate: 'status', object: 'final', validFrom: '2026-08-01' });

    const current = queryFacts(ctx.store, { subject: 'Ledger', predicate: 'status' });
    expect(current).toHaveLength(1);
    expect(current[0]!.object).toBe('final');
    ctx.close();
  });

  it('two assertions of the same value still leave one current', async () => {
    const ctx = await emptyCtx();
    assertFact(ctx, { subject: 'S', predicate: 'p', object: 'same', validFrom: '2026-01-01' });
    assertFact(ctx, { subject: 'S', predicate: 'p', object: 'same', validFrom: '2026-03-01' });
    const current = queryFacts(ctx.store, { subject: 'S', predicate: 'p' });
    expect(current).toHaveLength(1);
    expect(current[0]!.validFrom).toBe('2026-03-01');
    ctx.close();
  });

  it('point-in-time lands on whichever record covers the date', async () => {
    // Closing on a re-assertion must not lose the earlier period: the value is
    // continuous across the two records.
    const ctx = await emptyCtx();
    assertFact(ctx, { subject: 'Ledger', predicate: 'status', object: 'draft', validFrom: '2026-01-01' });
    assertFact(ctx, { subject: 'Ledger', predicate: 'status', object: 'draft', validFrom: '2026-03-01' });
    assertFact(ctx, { subject: 'Ledger', predicate: 'status', object: 'final', validFrom: '2026-08-01' });
    for (const [date, want] of [
      ['2026-02-01', 'draft'],
      ['2026-05-01', 'draft'],
      ['2026-09-01', 'final'],
    ] as const) {
      const at = queryFacts(ctx.store, { subject: 'Ledger', asOf: date });
      expect(at, `as of ${date}`).toHaveLength(1);
      expect(at[0]!.object, `as of ${date}`).toBe(want);
    }
    ctx.close();
  });

  it('records whether a successor changed the value or re-confirmed it', async () => {
    // fact_links was computed on every recompute and read by nothing.
    const ctx = await emptyCtx();
    assertFact(ctx, { subject: 'Ledger', predicate: 'status', object: 'draft', validFrom: '2026-01-01' });
    assertFact(ctx, { subject: 'Ledger', predicate: 'status', object: 'draft', validFrom: '2026-03-01' });
    assertFact(ctx, { subject: 'Ledger', predicate: 'status', object: 'final', validFrom: '2026-08-01' });
    const links = ctx.store.db
      .prepare(
        `SELECT l.type, a.object AS src, b.object AS dst FROM fact_links l
         JOIN facts a ON a.id = l.src_fact JOIN facts b ON b.id = l.dst_fact
         ORDER BY l.type`,
      )
      .all() as { type: string; src: string; dst: string }[];
    expect(links).toEqual([
      { type: 'extends', src: 'draft', dst: 'draft' },
      { type: 'updates', src: 'final', dst: 'draft' },
    ]);
    ctx.close();
  });
});

describe('a fact line survives being written and read back', () => {
  // The journal is the source of truth, so anything that does not round-trip
  // is data loss in the one place that cannot be re-derived. Verified against
  // generated fields built from the characters that carry meaning in the
  // format — `::`, braces, commas, backslashes, newlines — rather than from
  // tidy examples.
  function rng(seed: number) {
    let s = seed >>> 0;
    return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  }
  const PIECES = [
    'Atlas', 'status', 'shipped', 'Priya Sharma', 'v2.0',
    '::', '{', '}', ',', '=', '[', ']', '|', '\\', '"', "'",
    '- [fact]', '\n', '\t', '  ', '中文', '😀', 'a::b', '{k=v}',
    'valid_from=2026-01-01', '#tag', '[[link]]', '`code`',
  ];

  it('round-trips 300 generated fact lines exactly', () => {
    const pick = (rand: () => number, n: number) =>
      Array.from({ length: n }, () => PIECES[Math.floor(rand() * PIECES.length)]).join('');
    for (let seed = 1; seed <= 300; seed++) {
      const rand = rng(seed);
      const subject = pick(rand, 1 + Math.floor(rand() * 3)).trim() || 'S';
      const predicate = pick(rand, 1 + Math.floor(rand() * 2)).trim() || 'p';
      const object = pick(rand, 1 + Math.floor(rand() * 3)).trim() || 'o';

      const line = renderFactLine({
        kind: 'fact', subject, predicate, object,
        attrs: { valid_from: '2026-01-01' },
      });
      const back = parseFactLines(line);
      expect(back, `seed ${seed}: ${JSON.stringify({ subject, predicate, object })}`).toHaveLength(1);
      expect(back[0]!.subject).toBe(subject);
      expect(back[0]!.predicate).toBe(predicate);
      expect(back[0]!.object).toBe(object);
    }
  });

  it('a subject containing the field delimiter does not re-parse into other fields', () => {
    // Without escaping, subject "a::b" comes back as subject "a", predicate
    // "b", and the real predicate and object fused into one string.
    const line = renderFactLine({
      kind: 'fact', subject: 'a::b', predicate: 'p', object: 'o', attrs: {},
    });
    const back = parseFactLines(line);
    expect(back).toHaveLength(1);
    expect(back[0]!.subject).toBe('a::b');
    expect(back[0]!.predicate).toBe('p');
    expect(back[0]!.object).toBe('o');
  });
});
