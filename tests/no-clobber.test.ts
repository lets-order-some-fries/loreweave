import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildProgram } from '../src/cli/main.js';

/**
 * The vault is the source of truth, so destroying part of it is the one error
 * this engine cannot walk back — an index can be rebuilt, a note cannot.
 *
 * Every write in the codebase is append-only or lives under `lore/` and is
 * regenerated, with one exception: `graph export --out` takes a path the user
 * typed. That one overwrote whatever was there and reported success.
 */
describe('the engine does not clobber notes', () => {
  it('refuses to overwrite an existing file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lw-clobber-'));
    const note = join(root, 'atlas.md');
    await writeFile(note, '# Important\n\nWork I do not want to lose.\n');

    const out: string[] = [];
    const prog = buildProgram({ out: (s) => out.push(s), err: () => {} });
    await prog.parseAsync(['node', 'lore', '--vault', root, 'index']);

    await expect(
      prog.parseAsync(['node', 'lore', '--vault', root, 'graph', 'export', '--out', note]),
    ).rejects.toThrow(/already exists/);
    expect(await readFile(note, 'utf8')).toContain('Work I do not want to lose');
  }, 30_000);

  it('--force is how you say you meant it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lw-clobber2-'));
    await writeFile(join(root, 'a.md'), '# A\n\nBody.\n');
    const target = join(root, 'graph.json');
    await writeFile(target, 'stale');

    const prog = buildProgram({ out: () => {}, err: () => {} });
    await prog.parseAsync(['node', 'lore', '--vault', root, 'index']);
    await prog.parseAsync([
      'node', 'lore', '--vault', root, 'graph', 'export', '--out', target, '--force',
    ]);
    expect(await readFile(target, 'utf8')).toContain('"nodes"');
  }, 30_000);

  it('writing to a new path needs no ceremony', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lw-clobber3-'));
    await writeFile(join(root, 'a.md'), '# A\n\nBody.\n');
    const target = join(root, 'fresh.json');
    const prog = buildProgram({ out: () => {}, err: () => {} });
    await prog.parseAsync(['node', 'lore', '--vault', root, 'index']);
    await prog.parseAsync(['node', 'lore', '--vault', root, 'graph', 'export', '--out', target]);
    expect(await readFile(target, 'utf8')).toContain('"nodes"');
  }, 30_000);

  it('no source file writes without appending or guarding', () => {
    // A grep, so a write added later cannot pass by never being tested. Every
    // truncating write must sit next to an existence check or a containment
    // check; appends and the index file are exempt.
    const ALLOWED_TRUNCATING = new Set([
      'cli/main.ts', // init (guarded by existsSync) and graph --out (guarded above)
      'dream/dream.ts', // review-queue: engine-owned, regenerated, ticks preserved
    ]);
    const offenders: string[] = [];
    const walk = (dir: string, rel: string) => {
      for (const name of readdirSync(dir)) {
        const abs = join(dir, name);
        const r = rel ? `${rel}/${name}` : name;
        if (statSync(abs).isDirectory()) walk(abs, r);
        else if (name.endsWith('.ts')) {
          const src = readFileSync(abs, 'utf8');
          if (/\bwriteFileSync?\s*\(/.test(src) && !ALLOWED_TRUNCATING.has(r)) offenders.push(r);
        }
      }
    };
    walk(join(import.meta.dirname, '..', 'src'), '');
    expect(offenders).toEqual([]);
  });
});
