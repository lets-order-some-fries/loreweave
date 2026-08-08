import { describe, expect, it } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { openStore } from '../src/store/db.js';
import { indexVault } from '../src/index/indexer.js';
import { assertFact } from '../src/facts/model.js';
import { dream } from '../src/dream/dream.js';
import { markUsed, resolveBlockIds } from '../src/dynamics/usage.js';
import { ConfigSchema } from '../src/config.js';
import { buildGraph, type LoreGraph } from '../src/graph/build.js';
import { buildNoteLinkGraph } from '../src/retrieve/expand.js';
import type { LoreContext } from '../src/context.js';
import { FIXTURE_VAULT, makeVault } from './helpers.js';

const DUP_TEXT =
  'The quarterly planning ritual requires stakeholder alignment across engineering product and design before any roadmap commitment is finalized and published to leadership.';

async function ctxWith(extra: Record<string, string>): Promise<LoreContext> {
  const root = await makeVault({ ...FIXTURE_VAULT, ...extra });
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

describe('dream', () => {
  it('detects cross-note duplicate passages', async () => {
    const ctx = await ctxWith({
      'a1.md': `${DUP_TEXT}\n`,
      'a2.md': `${DUP_TEXT}\n`,
    });
    const r = dream(ctx);
    expect(
      r.duplicates.some(
        (d) =>
          [d.a.notePath, d.b.notePath].includes('a1.md') &&
          [d.a.notePath, d.b.notePath].includes('a2.md'),
      ),
    ).toBe(true);
    ctx.close();
  });

  it('flags contested facts and recent supersessions', async () => {
    const ctx = await ctxWith({});
    assertFact(ctx, { subject: 'S', predicate: 'p', object: 'A', validFrom: '2026-01-01' });
    assertFact(ctx, { subject: 'S', predicate: 'p', object: 'B', validFrom: '2026-01-01' });
    assertFact(ctx, { subject: 'T', predicate: 'q', object: 'old', validFrom: '2026-01-01' });
    assertFact(ctx, { subject: 'T', predicate: 'q', object: 'new', validFrom: '2026-08-01' });
    const r = dream(ctx);
    expect(r.contradictions.some((c) => c.kind === 'contested' && c.subject === 's')).toBe(true);
    expect(r.contradictions.some((c) => c.kind === 'recent-supersession' && c.subject === 't')).toBe(
      true,
    );
    ctx.close();
  });

  it('a freshly recorded backdated fact is NOT stale', async () => {
    const ctx = await ctxWith({});
    // Backdating is the whole point of valid_from; gating staleness on it
    // would mark a correct historical record stale the instant you write it.
    assertFact(ctx, {
      subject: 'Historic',
      predicate: 'status',
      object: 'active',
      validFrom: '2019-01-01',
    });
    const r = dream(ctx);
    expect(r.stale.some((s) => s.ref.includes('Historic'))).toBe(false);
    ctx.close();
  });

  it('flags long-recorded open facts and fading important blocks', async () => {
    const ctx = await ctxWith({});
    assertFact(ctx, { subject: 'Old', predicate: 'status', object: 'active', validFrom: '2025-01-01' });
    // age the RECORD time (not the validity) past the 180-day review horizon
    ctx.store.db
      .prepare(`UPDATE facts SET recorded_at=? WHERE subject='old'`)
      .run(new Date(Date.now() - 400 * 86_400_000).toISOString());
    // make a block important but long-unaccessed with low stability
    const ids = resolveBlockIds(ctx.store, 'projects/riverbed.md');
    markUsed(ctx.store, [ids[0]!]);
    ctx.store.db
      .prepare(`UPDATE blocks SET importance=0.9, stability=1, last_accessed=? WHERE id=?`)
      .run(new Date(Date.now() - 90 * 86_400_000).toISOString(), ids[0]!);
    const r = dream(ctx);
    expect(r.stale.some((s) => s.kind === 'fact' && s.ref.includes('Old'))).toBe(true);
    expect(r.stale.some((s) => s.kind === 'block' && s.ref.startsWith('projects/riverbed.md'))).toBe(
      true,
    );
    ctx.close();
  });

  it('suggests links between entity-sharing unlinked notes; skips linked pairs', async () => {
    const ctx = await ctxWith({
      'x1.md': `Discussed [[Quantum Widget]] with [[Priya Sharma]] today.\n`,
      'x2.md': `[[Priya Sharma]] demoed the [[Quantum Widget]] roadmap.\n`,
    });
    const r = dream(ctx);
    const sugg = r.linkSuggestions.find(
      (l) =>
        [l.from, l.to].includes('x1.md') && [l.from, l.to].includes('x2.md'),
    );
    expect(sugg).toBeDefined();
    expect(sugg!.sharedEntities).toContain('priya sharma');
    // riverbed ↔ amara are already wiki-linked: must not be suggested
    expect(
      r.linkSuggestions.some(
        (l) =>
          [l.from, l.to].includes('projects/riverbed.md') &&
          [l.from, l.to].includes('people/amara-osei.md'),
      ),
    ).toBe(false);
    ctx.close();
  });

  it('long notes do not outrank specific ones just for being long', async () => {
    // Raw IDF-sum rewarded length: two sprawling documents about the same
    // project inevitably share vocabulary, so they buried genuinely specific
    // pairs. Normalizing by note size asks whether they share MORE than
    // length alone predicts.
    // Each long note is mostly its OWN material and shares only a slice —
    // the README-vs-research-doc shape. The tiny pair shares everything it has.
    const fillerA = Array.from({ length: 60 }, (_, i) => `[[Alpha Topic ${i}]]`).join(' ');
    const fillerB = Array.from({ length: 60 }, (_, i) => `[[Beta Topic ${i}]]`).join(' ');
    const ctx = await ctxWith({
      'long-a.md': `# Long A\n\n${fillerA} [[Shared One]] [[Shared Two]]\n`,
      'long-b.md': `# Long B\n\n${fillerB} [[Shared One]] [[Shared Two]]\n`,
      'tiny-a.md': '# Tiny A\n\nAbout [[Quokka Protocol]] and [[Nimbus Ledger]].\n',
      'tiny-b.md': '# Tiny B\n\nAlso [[Quokka Protocol]] and [[Nimbus Ledger]].\n',
    });
    const r = dream(ctx);
    const idx = (a: string, b: string) =>
      r.linkSuggestions.findIndex(
        (s) => [s.from, s.to].includes(a) && [s.from, s.to].includes(b),
      );
    const tiny = idx('tiny-a.md', 'tiny-b.md');
    const long = idx('long-a.md', 'long-b.md');
    expect(tiny).toBeGreaterThanOrEqual(0);
    // the tiny pair shares its entire vocabulary; the long pair shares a slice
    if (long >= 0) expect(tiny).toBeLessThan(long);
    ctx.close();
  });

  it('says nothing when no pair stands out', async () => {
    // A Zettelkasten of small atomic notes: every pair co-cites a couple of
    // neighbours, so thousands of pairs score alike and the "top" ones are
    // arbitrary. Thirty arbitrary suggestions are worse than none.
    const notes: Record<string, string> = {};
    const n = 60;
    for (let i = 0; i < n; i++) {
      const links = [1, 2, 3].map((k) => `[[note-${(i * 13 + k * 29) % n}]]`).join(' ');
      notes[`note-${i}.md`] = `---\ntitle: note-${i}\n---\n\n# note-${i}\n\nAtomic note. See ${links}.\n`;
    }
    const ctx = await ctxWith(notes);
    const r = dream(ctx);
    // uniformly-linked notes produce no standout pair
    expect(r.linkSuggestions.length).toBeLessThanOrEqual(5);
    ctx.close();
  });

  it('still reports genuinely distinctive pairs', async () => {
    const ctx = await ctxWith({
      'x1.md': 'Notes on [[Quokka Protocol]], [[Nimbus Ledger]] and [[Tessera Method]].\n',
      'x2.md': 'More on [[Quokka Protocol]], [[Nimbus Ledger]] and [[Tessera Method]].\n',
    });
    const r = dream(ctx);
    expect(
      r.linkSuggestions.some(
        (l) => [l.from, l.to].includes('x1.md') && [l.from, l.to].includes('x2.md'),
      ),
    ).toBe(true);
    ctx.close();
  });

  it('finds orphans, excluding lore/ notes', async () => {
    const ctx = await ctxWith({});
    const r = dream(ctx);
    expect(r.orphans).toContain('notes/unrelated.md');
    expect(r.orphans.every((o) => !o.startsWith('lore/'))).toBe(true);
    ctx.close();
  });

  it('apply writes only under lore/ and the queue is idempotent', async () => {
    const ctx = await ctxWith({});
    const r = dream(ctx, { apply: true });
    expect(r.written.every((w) => w.startsWith('lore/'))).toBe(true);
    const queue = await readFile(join(ctx.root, 'lore/review-queue.md'), 'utf8');
    expect(queue).toContain('# Review queue');
    const countOrphans = (s: string) => s.split('\n').filter((l) => l.includes('orphan:')).length;
    const first = countOrphans(queue);
    expect(first).toBeGreaterThan(0);

    // Running again must NOT duplicate findings (the old behaviour appended
    // the whole report every time).
    dream(ctx, { apply: true });
    const queue2 = await readFile(join(ctx.root, 'lore/review-queue.md'), 'utf8');
    expect(countOrphans(queue2)).toBe(first);
    ctx.close();
  });

  it('ticked review items survive regeneration', async () => {
    const ctx = await ctxWith({});
    dream(ctx, { apply: true });
    const path = join(ctx.root, 'lore/review-queue.md');
    const original = await readFile(path, 'utf8');
    // user ticks the first checkbox
    const ticked = original.replace('- [ ] ', '- [x] ');
    await writeFile(path, ticked, 'utf8');
    const tickedLine = ticked.split('\n').find((l) => l.startsWith('- [x] '))!;

    dream(ctx, { apply: true });
    const after = await readFile(path, 'utf8');
    expect(after).toContain(tickedLine);
    ctx.close();
  });

  it('never indexes its own generated digests or review queue', async () => {
    const ctx = await ctxWith({});
    dream(ctx, { apply: true });
    const before = ctx.store.db.prepare('SELECT COUNT(*) c FROM notes').get() as any;
    await indexVault(ctx.store, ctx.root);
    const after = ctx.store.db.prepare('SELECT COUNT(*) c FROM notes').get() as any;
    expect(after.c).toBe(before.c);
    const paths = (
      ctx.store.db.prepare('SELECT path FROM notes').all() as { path: string }[]
    ).map((r) => r.path);
    expect(paths.some((p) => p.startsWith('lore/digests/'))).toBe(false);
    expect(paths.some((p) => p.startsWith('lore/review-queue'))).toBe(false);
    // journals ARE still indexed — they are the durable fact record
    expect(paths.some((p) => p.startsWith('lore/journal/'))).toBe(true);
    ctx.close();
  });
});

describe('heading echoes are not content', () => {
  it('two sections with the same name are not a duplicate passage', async () => {
    // A section with no body of its own is indexed as an echo of its own
    // heading so a headings-only note stays findable. That text is a stand-in
    // for findability, not something anyone wrote — and section names repeat
    // constantly, so comparing them as content reported "The Process" ≈ "The
    // Process" at Jaccard 1.0 for two unrelated documents. On a real docs
    // vault 40 of 501 blocks were echoes and they produced most of the
    // duplicate findings.
    const ctx = await ctxWith({
      'one.md': '# Executing Plans\n\n## The Process\n\n### Step\n\nDo the first thing.\n',
      'two.md': '# Finishing a Branch\n\n## The Process\n\n### Step\n\nDo a different thing.\n',
    });
    const hit = ctx.store.db
      .prepare(`SELECT COUNT(*) c FROM blocks WHERE text = 'The Process'`)
      .get() as { c: number };
    expect(hit.c).toBe(2); // the echo blocks exist — they are what makes the note findable

    const r = dream(ctx);
    expect(
      r.duplicates.some(
        (d) => [d.a.notePath, d.b.notePath].includes('one.md') && [d.a.notePath, d.b.notePath].includes('two.md'),
      ),
    ).toBe(false);
    ctx.close();
  });

  it('genuinely copy-pasted prose is still caught', async () => {
    // The three pressure-test files in a real vault share a verbatim preamble.
    // Excluding echoes must not blunt the detector on real duplication.
    const boiler =
      'IMPORTANT: This is a real scenario. You must choose and act now. ' +
      'Do not ask hypothetical questions, make the actual decision and then ' +
      'report exactly what you did and why you did it that way.';
    const ctx = await ctxWith({
      'p1.md': `# Pressure Test 1\n\n## Setup\n\n${boiler}\n`,
      'p2.md': `# Pressure Test 2\n\n## Setup\n\n${boiler}\n`,
    });
    const r = dream(ctx);
    expect(
      r.duplicates.some(
        (d) => [d.a.notePath, d.b.notePath].includes('p1.md') && [d.a.notePath, d.b.notePath].includes('p2.md'),
      ),
    ).toBe(true);
    ctx.close();
  });
});

describe('dream performs index maintenance', () => {
  it('merges accumulated full-text segments', async () => {
    // Every edit deletes and reinserts a note's blocks, and FTS5 writes a new
    // segment rather than updating in place. Left alone they accumulate, and
    // search slows down for as long as the vault is used without ever
    // recovering — measured between 15% and 22% slower after twenty rounds of
    // editing, depending on the write pattern, and back to at or below the
    // original after merging.
    //
    // Asserted on the segment count rather than on timing: the mechanism is
    // deterministic and a wall-clock threshold would be flaky for the one
    // thing it is meant to prove.
    const ctx = await ctxWith({});
    const segments = () =>
      (ctx.store.db.prepare(`SELECT COUNT(*) c FROM blocks_fts_data`).get() as { c: number }).c;

    // churn the index the way ordinary editing does
    const ids = ctx.store.db.prepare(`SELECT id, text FROM blocks`).all() as {
      id: number;
      text: string;
    }[];
    const upd = ctx.store.db.prepare(`UPDATE blocks SET fts_text=? WHERE id=?`);
    for (let round = 0; round < 25; round++) {
      for (const b of ids) upd.run(`${b.text} revision ${round}`, b.id);
    }
    const before = segments();
    expect(before).toBeGreaterThan(1);

    dream(ctx);
    expect(segments()).toBeLessThan(before);
    ctx.close();
  });

  it('still reports correctly after merging', async () => {
    // The merge must not disturb the report it shares a pass with.
    const ctx = await ctxWith({
      'a1.md': `${DUP_TEXT}\n`,
      'a2.md': `${DUP_TEXT}\n`,
    });
    const r = dream(ctx);
    expect(r.stats.notes).toBeGreaterThan(0);
    expect(
      r.duplicates.some(
        (d) =>
          [d.a.notePath, d.b.notePath].includes('a1.md') &&
          [d.a.notePath, d.b.notePath].includes('a2.md'),
      ),
    ).toBe(true);
    ctx.close();
  });
});

describe('a change is dated when it happened', () => {
  it('describes a supersession by valid time, not record time', async () => {
    // Supersessions are SELECTED by record time — "what did we learn recently"
    // — but were also DESCRIBED by it. The two differ whenever a fact is
    // backdated, which is most of the time: writing up June's handover in
    // August is ordinary, and reporting it as a change that happened in August
    // is simply false. Importing a year of history in one sitting reported
    // every change as today's.
    const ctx = await ctxWith({});
    assertFact(ctx, {
      subject: 'Priya Sharma',
      predicate: 'role',
      object: 'Senior Engineer',
      validFrom: '2024-01-01',
    });
    assertFact(ctx, {
      subject: 'Priya Sharma',
      predicate: 'role',
      object: 'Staff Engineer',
      validFrom: '2025-06-01',
    });

    const r = dream(ctx);
    const change = r.contradictions.find(
      (c) => c.kind === 'recent-supersession' && c.subject === 'priya sharma',
    );
    expect(change).toBeDefined();
    expect(change!.detail).toContain('effective 2025-06-01');
    // and it still says when it was learned, since that is why it is listed
    expect(change!.detail).toContain('recorded');
    ctx.close();
  });

  it('says it once when the change was recorded the day it happened', async () => {
    // No point printing "effective X, recorded X".
    const today = new Date().toISOString().slice(0, 10);
    const ctx = await ctxWith({});
    assertFact(ctx, { subject: 'S', predicate: 'p', object: 'old', validFrom: '2024-01-01' });
    assertFact(ctx, { subject: 'S', predicate: 'p', object: 'new', validFrom: today });
    const r = dream(ctx);
    const change = r.contradictions.find(
      (c) => c.kind === 'recent-supersession' && c.subject === 's',
    );
    expect(change!.detail).toContain(today);
    expect(change!.detail).not.toContain('effective');
    ctx.close();
  });
});

describe('a linked note is not called an orphan', () => {
  it('resolves ambiguous names the way the link graph does', async () => {
    // dream kept its own one-path-per-name map, so both `[[Overview]]` links
    // were credited to whichever note was enumerated last and the other was
    // reported as an orphan — a false accusation, about a note whose own
    // folder links to it, that a reader would act on.
    const ctx = await ctxWith({
      'projects/atlas/overview.md':
        '---\ntitle: Overview\n---\n\n# Overview\n\nAtlas ingests telemetry.\n',
      'projects/northwind/overview.md':
        '---\ntitle: Overview\n---\n\n# Overview\n\nNorthwind reconciles invoices.\n',
      'projects/atlas/plan.md': '# Atlas Plan\n\nDesign is in [[Overview]].\n',
      'projects/northwind/plan.md': '# Northwind Plan\n\nBilling rules live in [[Overview]].\n',
    });
    const r = dream(ctx);
    expect(r.orphans).not.toContain('projects/atlas/overview.md');
    expect(r.orphans).not.toContain('projects/northwind/overview.md');
    ctx.close();
  });

  it('a genuinely unlinked note is still reported', async () => {
    const ctx = await ctxWith({
      'projects/atlas/overview.md':
        '---\ntitle: Overview\n---\n\n# Overview\n\nAtlas ingests telemetry.\n',
      'projects/atlas/plan.md': '# Atlas Plan\n\nDesign is in [[Overview]].\n',
      'stranded.md': '# Stranded\n\nNothing links here and it links nowhere.\n',
    });
    const r = dream(ctx);
    expect(r.orphans).toContain('stranded.md');
    ctx.close();
  });
});
