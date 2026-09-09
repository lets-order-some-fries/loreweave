import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildProgram } from '../src/cli/main.js';
import { openContext } from '../src/context.js';
import { createLoreMcpServer } from '../src/mcp/server.js';

/**
 * A key in .lore/config.json has to change what the engine DOES, not merely
 * survive a schema round trip. Measured at HEAD: `ignore` was read by nothing
 * that indexes, `nlp:false` and `facts.extract` were dropped by CLI `lore
 * index` and MCP `lore_index`, and the auto-index behind `lore search` used
 * `ignore` only to decide whether the vault was empty. Each test here writes
 * a real config and drives a real entry point.
 */
async function vault(config: Record<string, unknown>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'lw-cfgwire-'));
  await mkdir(join(root, '.lore'), { recursive: true });
  await mkdir(join(root, 'drafts'), { recursive: true });
  await writeFile(join(root, '.lore', 'config.json'), JSON.stringify(config));
  await writeFile(
    join(root, 'keep.md'),
    '# Keep\n\nAlice Johnson met Bob Martinez in Paris.\n\nowner:: Priya Sharma\n',
  );
  await writeFile(join(root, 'drafts', 'secret-draft.md'), '# Draft\n\nZEBRAWOOD unpublished draft text.\n');
  return root;
}

async function runCli(root: string, ...args: string[]): Promise<{ out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const program = buildProgram({ out: (s) => out.push(s), err: (s) => err.push(s) });
  program.exitOverride();
  for (const c of program.commands) c.exitOverride();
  await program.parseAsync(['node', 'lore', '--vault', root, ...args]);
  return { out: out.join('\n'), err: err.join('\n') };
}

function rows<T>(root: string, sql: string): T[] {
  const ctx = openContext(root);
  try {
    return ctx.store.db.prepare(sql).all() as T[];
  } finally {
    ctx.close();
  }
}

const notePaths = (root: string) => rows<{ path: string }>(root, 'SELECT path FROM notes').map((r) => r.path);
const mentionSources = (root: string) =>
  rows<{ source: string }>(root, 'SELECT DISTINCT source FROM mentions').map((r) => r.source);

/** Drive one MCP tool against a real vault, then hand back the store for inspection. */
async function viaMcp(
  root: string,
  name: string,
  args: Record<string, unknown>,
): Promise<{ notes: string[]; sources: string[]; facts: unknown[] }> {
  const ctx = openContext(root);
  const server = createLoreMcpServer(ctx);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 't', version: '0' });
  await Promise.all([client.connect(ct), server.connect(st)]);
  await client.callTool({ name, arguments: args });
  const q = <T>(sql: string) => ctx.store.db.prepare(sql).all() as T[];
  const result = {
    notes: q<{ path: string }>('SELECT path FROM notes').map((r) => r.path),
    sources: q<{ source: string }>('SELECT DISTINCT source FROM mentions').map((r) => r.source),
    facts: q('SELECT subject, predicate, object FROM facts'),
  };
  await client.close();
  ctx.close();
  return result;
}

describe('config keys reach the code that acts on them', () => {
  it('CLI `lore index` honours ignore', async () => {
    const root = await vault({ ignore: ['drafts'] });
    await runCli(root, 'index');
    const paths = notePaths(root);
    expect(paths).toContain('keep.md');
    expect(paths).not.toContain('drafts/secret-draft.md');
  });

  it('CLI `lore search` (the first-run auto-index) honours ignore', async () => {
    const root = await vault({ ignore: ['drafts'] });
    const r = await runCli(root, 'search', 'ZEBRAWOOD');
    expect(r.out).not.toContain('secret-draft');
  });

  it('CLI `lore index` honours nlp:false', async () => {
    const root = await vault({ nlp: false });
    await runCli(root, 'index');
    expect(mentionSources(root)).not.toContain('nlp');
  });

  it('CLI `lore index --no-nlp` still turns NLP off when the config leaves it on', async () => {
    const root = await vault({ nlp: true });
    await runCli(root, 'index', '--no-nlp');
    expect(mentionSources(root)).not.toContain('nlp');
    // and with neither, the config's default (on) applies
    const root2 = await vault({});
    await runCli(root2, 'index');
    expect(mentionSources(root2)).toContain('nlp');
  });

  it('CLI `lore index` honours facts.extract:off', async () => {
    const root = await vault({ facts: { extract: 'off' } });
    await runCli(root, 'index');
    expect(rows(root, 'SELECT subject FROM facts')).toEqual([]);
  });

  it('MCP lore_index honours nlp:false', async () => {
    const root = await vault({ nlp: false });
    const { sources } = await viaMcp(root, 'lore_index', { full: true });
    expect(sources).not.toContain('nlp');
  });

  it('MCP lore_index honours ignore', async () => {
    const root = await vault({ ignore: ['drafts'] });
    const { notes } = await viaMcp(root, 'lore_index', {});
    expect(notes).toContain('keep.md');
    expect(notes).not.toContain('drafts/secret-draft.md');
  });

  it('MCP lore_index honours facts.extract:off', async () => {
    const root = await vault({ facts: { extract: 'off' } });
    const { facts } = await viaMcp(root, 'lore_index', { full: true });
    expect(facts).toEqual([]);
  });
});
