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

  it('ask surfaces facts + passages', async () => {
    await run('index');
    const r = await run('ask', 'riverbed', 'protocol', 'status');
    expect(r.out).toContain('Passages:');
    expect(r.out).toContain('blocked'); // fact from fixture journal
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
