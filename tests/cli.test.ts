import { beforeAll, describe, expect, it } from 'vitest';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { buildProgram } from '../src/cli/main.js';
import { FIXTURE_VAULT, makeVault } from './helpers.js';

let root: string;

async function run(...args: string[]): Promise<{ out: string; err: string }> {
  const outLines: string[] = [];
  const errLines: string[] = [];
  const program = buildProgram({
    out: (s) => outLines.push(s),
    err: (s) => errLines.push(s),
  });
  program.exitOverride();
  await program.parseAsync(['node', 'lore', '--vault', root, ...args]);
  return { out: outLines.join('\n'), err: errLines.join('\n') };
}

beforeAll(async () => {
  root = await makeVault(FIXTURE_VAULT);
  await mkdir(join(root, '.lore'), { recursive: true });
});

describe('cli', () => {
  it('index → search → stats → doctor journey', async () => {
    const idx = await run('index');
    expect(idx.out).toMatch(/indexed: \+\d+/);

    const s = await run('search', 'meltwater', 'sensor');
    expect(s.out).toContain('data/glacier-dataset.md');

    const s2 = await run('search', 'riverbed', 'protocol', '--json');
    expect(() => JSON.parse(s2.out)).not.toThrow();

    const st = await run('stats');
    expect(st.out).toMatch(/notes:\s+\d+/);
    expect(st.out).toContain('top entities:');

    const doc = await run('doctor');
    expect(doc.out).toContain('db integrity: ok');
    // fixture has no dangling links
    expect(doc.out).toContain('broken links: 0');
  });

  it('doctor actually detects dangling wiki-links', async () => {
    const vault = await makeVault({
      'a.md': 'Points at [[Nonexistent Page]] and [[Real Note]].\n',
      'real-note.md': '---\ntitle: Real Note\n---\n\nI exist.\n',
    });
    await mkdir(join(vault, '.lore'), { recursive: true });
    const saved = root;
    root = vault;
    await run('index');
    const doc = await run('doctor');
    expect(doc.out).toContain('broken links: 1');
    expect(doc.out).toContain('Nonexistent Page');
    root = saved;
  });

  it('assert → facts → count → invalidate journey', async () => {
    await run('index');
    const a = await run('assert', 'Trovark', 'status', 'published', '--valid-from', '2026-08-01');
    expect(a.out).toContain('✓ Trovark :: status :: published');

    const f = await run('facts', '--subject', 'Trovark');
    expect(f.out).toContain('Trovark :: status :: published');

    const c = await run('count', '--predicate', 'status');
    expect(c.out).toMatch(/\d+\s+published/);

    const inv = await run('invalidate', 'Trovark', 'status');
    expect(inv.out).toContain('closed 1 fact(s)');

    const f2 = await run('facts', '--subject', 'Trovark');
    expect(f2.out).toContain('no facts');

    const hist = await run('facts', '--subject', 'Trovark', '--history');
    expect(hist.out).toContain('published');
  });

  it('facts show where they came from', async () => {
    await run('index');
    await run('assert', 'Ledger', 'status', 'shipped', '--valid-from', '2026-08-01');
    const f = await run('facts', '--subject', 'Ledger');
    // a fact with no visible source cannot be checked
    expect(f.out).toContain('Ledger :: status :: shipped');
    expect(f.out).toMatch(/asserted · lore\/journal\//);
  });

  it('history distinguishes asserted facts from ones read out of notes', async () => {
    const vault = await makeVault({
      'l.md': '---\ntitle: Widget\nstatus: draft\ndate: 2026-01-15\n---\n\n# Widget\n\nBody.\n',
    });
    await mkdir(join(vault, '.lore'), { recursive: true });
    const saved = root;
    root = vault;
    await run('index');
    await run('assert', 'Widget', 'status', 'shipped', '--valid-from', '2026-08-01');
    const h = await run('facts', '--subject', 'Widget', '--history');
    expect(h.out).toContain('from note · l.md');
    expect(h.out).toMatch(/asserted · lore\/journal\//);
    expect(h.out).toContain('[superseded]');
    root = saved;
  });

  it('ask surfaces facts + passages', async () => {
    await run('index');
    const r = await run('ask', 'riverbed', 'protocol', 'status');
    expect(r.out).toContain('Passages:');
    expect(r.out).toContain('blocked'); // fact from fixture journal
  });

  it('result lines stay readable however deep the headings are', async () => {
    const deep = await makeVault({
      'deep.md':
        '# A very long top level heading that goes on for a while indeed\n\n' +
        '## Another deeply nested subsection heading with plenty of words in it\n\n' +
        '### And a third level that keeps going and going and going\n\n' +
        'The distinctive payload token is zephyrine.\n',
    });
    await mkdir(join(deep, '.lore'), { recursive: true });
    const saved = root;
    root = deep;
    await run('index');
    const r = await run('search', 'zephyrine');
    const locLine = r.out.split('\n').find((l) => l.startsWith('•'))!;
    // the raw anchor is the full breadcrumb; on real notes it ran to 327 chars
    expect(locLine.length).toBeLessThan(150);
    expect(locLine).toContain('deep.md');

    // --json must still carry the exact anchor for programmatic use
    const j = await run('search', 'zephyrine', '--json');
    const parsed = JSON.parse(j.out);
    expect(parsed[0].anchor).toContain('And a third level');
    root = saved;
  });

  it('capture appends to inbox', async () => {
    const r = await run('capture', 'remember', 'to', 'test', 'capture');
    expect(r.out).toContain('lore/inbox.md');
  });

  it('dream runs and reports', async () => {
    await run('index');
    const r = await run('dream');
    expect(r.out).toMatch(/findings: \d+ duplicates/);
  });

  it('graph export json + dot', async () => {
    await run('index');
    const j = await run('graph', 'export', '--format', 'json');
    const g = JSON.parse(j.out);
    expect(g.nodes.length).toBeGreaterThan(0);
    const d = await run('graph', 'export', '--format', 'dot');
    expect(d.out).toContain('graph lore {');
  });

  it('mark-used reinforces', async () => {
    await run('index');
    const r = await run('mark-used', 'data/glacier-dataset.md');
    expect(r.out).toMatch(/reinforced \d+ block/);
  });
});

describe('ask does not print the facts twice', () => {
  it('suppresses journal records when the facts are already shown', async () => {
    // The journal writes `- [fact] S :: p :: o {…}` on every assert and is
    // indexed on purpose, so it matches the same entity names as the prose.
    // Measured, `ask "who leads project atlas"` returned a journal line about
    // the project's STATUS as its top passage, directly beneath a Facts
    // section that had already said it in words — and it grows, because every
    // assert appends another line.
    const root = await makeVault({
      'atlas.md':
        '---\ntitle: Project Atlas\n---\n\n# Project Atlas\n\n' +
        'Atlas is the ingestion rewrite led by Priya Sharma.\n',
    });
    const out: string[] = [];
    const prog = buildProgram({ out: (s) => out.push(s), err: () => {} });
    const run = (...args: string[]) =>
      prog.parseAsync(['node', 'lore', '--vault', root, ...args]);

    await run('index');
    await run('assert', 'Project Atlas', 'lead', 'Priya Sharma', '--valid-from', '2025-06-01');
    await run('index');

    out.length = 0;
    await run('ask', 'who', 'leads', 'project', 'atlas');
    const text = out.join('\n');
    expect(text).toContain('Facts (currently valid)');
    expect(text).toContain('Priya Sharma');
    expect(text).not.toContain('[fact]'); // not the raw record, twice over
  }, 30_000);

  it('search still returns the journal, because searching for a record should find it', async () => {
    const root = await makeVault({ 'a.md': '# A\n\nSome prose about widgets.\n' });
    const out: string[] = [];
    const prog = buildProgram({ out: (s) => out.push(s), err: () => {} });
    const run = (...args: string[]) =>
      prog.parseAsync(['node', 'lore', '--vault', root, ...args]);
    await run('index');
    await run('assert', 'Widget', 'status', 'shipped', '--valid-from', '2026-01-01');
    await run('index');

    out.length = 0;
    await run('search', 'fact', 'widget', 'status', 'shipped');
    expect(out.join('\n')).toContain('lore/journal/');
  }, 30_000);
});
