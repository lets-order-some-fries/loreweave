import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chmod, copyFile, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildProgram } from '../src/cli/main.js';
import { openContext } from '../src/context.js';
import { createLoreMcpServer } from '../src/mcp/server.js';
import { indexVault } from '../src/index/indexer.js';
import { assertFact } from '../src/facts/model.js';
import { openStore } from '../src/store/db.js';

/**
 * A read-only index — a vault on a read-only mount, a `.lore/` shared from
 * another account, a backup opened in place — made EVERY command fail with
 * the raw SQLite message "attempt to write a readonly database": search,
 * facts, stats, timeline, all of which only read. openStore upserted
 * schema_version on every open whether or not it had changed, and search
 * logged each result to access_log. Measured with chmod 555 .lore and
 * chmod 444 index.db: search, facts, stats, index, assert, capture all
 * exit 1 with that line and nothing naming the file.
 */
let root: string;
let dbFile: string;

async function run(...args: string[]): Promise<{ out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const program = buildProgram({ out: (s) => out.push(s), err: (s) => err.push(s) });
  program.exitOverride();
  for (const c of program.commands) c.exitOverride();
  await program.parseAsync(['node', 'lore', '--vault', root, ...args]);
  return { out: out.join('\n'), err: err.join('\n') };
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'lw-ro-'));
  await mkdir(join(root, '.lore'), { recursive: true });
  await writeFile(join(root, 'heron.md'), '# Heron\n\nThe heron stands in the shallows.\n');
  const ctx = openContext(root);
  await indexVault(ctx.store, ctx.root);
  assertFact(ctx, { subject: 'Heron', predicate: 'status', object: 'wading', validFrom: '2026-01-01' });
  await indexVault(ctx.store, ctx.root); // pick up the journal note
  ctx.close();
  dbFile = join(root, '.lore', 'index.db');
  await chmod(dbFile, 0o444);
  await chmod(join(root, '.lore'), 0o555);
});

afterAll(async () => {
  await chmod(join(root, '.lore'), 0o755);
  await chmod(dbFile, 0o644);
});

describe('a read-only index', () => {
  it('still answers every read command', async () => {
    expect((await run('search', 'heron')).out).toContain('heron.md');
    expect((await run('facts')).out).toContain('Heron :: status :: wading');
    expect((await run('stats')).out).toMatch(/notes:\s+2/);
    expect((await run('timeline', 'Heron')).out).toContain('wading');
    expect((await run('doctor')).out).toContain('db integrity: ok');
    expect((await run('ask', 'where does the heron stand')).out).toContain('shallows');
  });

  it('refuses every write command with one line naming the path', async () => {
    for (const args of [
      ['index'],
      ['assert', 'Heron', 'status', 'flying'],
      ['invalidate', 'Heron', 'status'],
      ['capture', 'hello'],
      ['mark-used', 'heron.md'],
    ]) {
      const p = run(...args);
      await expect(p, args.join(' ')).rejects.toThrow(/read-only/);
      await expect(p, args.join(' ')).rejects.toThrow(dbFile);
      await expect(p, args.join(' ')).rejects.not.toThrow(/attempt to write/);
    }
  });

  it('a refused assert leaves no half-written journal line', async () => {
    // assertFact writes the journal line before the row on purpose (the
    // markdown is the source of truth) — so the read-only check has to run
    // before either, or the next rebuild replays a fact the user was told
    // was refused.
    await expect(run('assert', 'Heron', 'status', 'flying')).rejects.toThrow(/read-only/);
    const journal = (await run('search', 'flying', '--json')).out;
    expect(JSON.parse(journal)).toEqual([]);
  });

  it('the MCP server reads, and its write tools return the same line', async () => {
    const ctx = openContext(root);
    const server = createLoreMcpServer(ctx);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 't', version: '0' });
    await Promise.all([client.connect(ct), server.connect(st)]);
    try {
      const hits = (await client.callTool({ name: 'lore_search', arguments: { query: 'heron' } })) as {
        isError?: boolean;
        content: { text: string }[];
      };
      expect(hits.isError ?? false).toBe(false);
      expect(hits.content[0]!.text).toContain('heron.md');
      for (const [name, args] of [
        ['lore_capture', { text: 'hello' }],
        ['lore_assert_fact', { subject: 'Heron', predicate: 'status', object: 'flying' }],
        ['lore_mark_used', { notePath: 'heron.md' }],
        ['lore_index', {}],
      ] as const) {
        const r = (await client.callTool({ name, arguments: args })) as {
          isError?: boolean;
          content: { text: string }[];
        };
        expect(r.isError, name).toBe(true);
        expect(r.content[0]!.text, name).toMatch(/read-only/);
        expect(r.content[0]!.text, name).toContain(dbFile);
        expect(r.content[0]!.text, name).not.toMatch(/attempt to write/);
      }
    } finally {
      await client.close();
      ctx.close();
    }
  });

  it('openStore marks the store read-only rather than failing', () => {
    const store = openStore(dbFile);
    try {
      expect(store.readonly).toBe(true);
      expect(store.getMeta('schema_version')).not.toBeNull();
      store.logAccess('retrieved', null, 'q'); // a no-op, not a crash
      expect(() => store.setMeta('k', 'v')).toThrow(/read-only/);
    } finally {
      store.close();
    }
  });
});

describe('a read-only index that still carries a -wal', () => {
  it('answers a search for rows that only the WAL holds', async () => {
    // A backup copied while the engine was open, or a .lore/ shared from
    // another account, commonly carries an un-checkpointed -wal. The snapshot
    // fallback only triggered on SQLITE_READONLY; with a -wal present SQLite
    // reports SQLITE_CANTOPEN instead, and every command died with the raw
    // "unable to open database file".
    const src = await mkdtemp(join(tmpdir(), 'lw-wal-src-'));
    await mkdir(join(src, '.lore'), { recursive: true });
    await writeFile(join(src, 'a.md'), '# A\n\nplain words here.\n');
    const ctx = openContext(src);
    await indexVault(ctx.store, ctx.root);
    await writeFile(join(src, 'b.md'), '# B\n\nthe word quokkatrail appears only here.\n');
    await indexVault(ctx.store, ctx.root); // still open: these rows sit in the -wal
    const dst = await mkdtemp(join(tmpdir(), 'lw-wal-dst-'));
    await mkdir(join(dst, '.lore'), { recursive: true });
    await copyFile(join(src, '.lore', 'index.db'), join(dst, '.lore', 'index.db'));
    await copyFile(join(src, '.lore', 'index.db-wal'), join(dst, '.lore', 'index.db-wal'));
    ctx.close();
    await chmod(join(dst, '.lore', 'index.db'), 0o444);
    await chmod(join(dst, '.lore', 'index.db-wal'), 0o444);
    await chmod(join(dst, '.lore'), 0o555);
    try {
      const out: string[] = [];
      const err: string[] = [];
      const program = buildProgram({ out: (s) => out.push(s), err: (s) => err.push(s) });
      program.exitOverride();
      for (const c of program.commands) c.exitOverride();
      await program.parseAsync(['node', 'lore', '--vault', dst, 'search', 'quokkatrail']);
      expect(out.join('\n')).toContain('b.md');
    } finally {
      await chmod(join(dst, '.lore'), 0o755);
    }
  });
});

