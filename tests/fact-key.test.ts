import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertFact, invalidateFact } from '../src/facts/model.js';
import { openContext } from '../src/context.js';
import { buildProgram } from '../src/cli/main.js';
import { createLoreMcpServer } from '../src/mcp/server.js';

/**
 * A fact's slot is (normalizeKey(subject), normalizeKey(predicate)), and
 * normalizeKey strips everything that is not a letter or digit. A subject
 * made only of emoji or punctuation normalises to '' — and every such subject
 * lands in the SAME slot. Measured: `assert 🚀 status launched`, then
 * `assert — status cancelled` reported "superseded: launched", and
 * `invalidate 🎯 status` closed the `—` fact. The facts table held
 * subject=''. Unrelated things were contradicting each other.
 */
async function freshCtx() {
  const root = await mkdtemp(join(tmpdir(), 'lw-factkey-'));
  await mkdir(join(root, '.lore'), { recursive: true });
  return openContext(root);
}

describe('fact keys that normalise to nothing', () => {
  it('assertFact refuses an empty-key subject or predicate, naming the value', async () => {
    const ctx = await freshCtx();
    try {
      expect(() => assertFact(ctx, { subject: '🚀', predicate: 'status', object: 'launched' }))
        .toThrow(/subject "🚀" normalises to nothing/);
      expect(() => assertFact(ctx, { subject: 'Atlas', predicate: '—', object: 'x' }))
        .toThrow(/predicate "—" normalises to nothing/);
      // nothing reached the table, and nothing was journalled
      expect(ctx.store.db.prepare(`SELECT COUNT(*) c FROM facts`).get()).toEqual({ c: 0 });
      // a key that keeps a letter or digit is still fine
      const r = assertFact(ctx, { subject: 'Project 🚀', predicate: 'status', object: 'launched' });
      expect(r.fact.subject).toBe('project');
      expect(r.fact.subjectDisplay).toBe('Project 🚀');
    } finally {
      ctx.close();
    }
  });

  it('invalidateFact refuses the same', async () => {
    const ctx = await freshCtx();
    try {
      assertFact(ctx, { subject: 'Atlas', predicate: 'status', object: 'live' });
      expect(() => invalidateFact(ctx, { subject: '🎯', predicate: 'status' }))
        .toThrow(/subject "🎯" normalises to nothing/);
      expect(() => invalidateFact(ctx, { subject: 'Atlas', predicate: '…' }))
        .toThrow(/predicate "…" normalises to nothing/);
      // the real fact was not touched
      const open = ctx.store.db
        .prepare(`SELECT COUNT(*) c FROM facts WHERE valid_until IS NULL`)
        .get();
      expect(open).toEqual({ c: 1 });
    } finally {
      ctx.close();
    }
  });

  it('the CLI reports it as an error, not a supersession', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lw-factkey-cli-'));
    await mkdir(join(root, '.lore'), { recursive: true });
    const run = async (...args: string[]) => {
      const out: string[] = [];
      const program = buildProgram({ out: (s) => out.push(s), err: () => {} });
      program.exitOverride();
      for (const c of program.commands) c.exitOverride();
      await program.parseAsync(['node', 'lore', '--vault', root, ...args]);
      return out.join('\n');
    };
    await expect(run('assert', '🚀', 'status', 'launched')).rejects.toThrow(/"🚀" normalises to nothing/);
    await expect(run('assert', '—', 'status', 'cancelled')).rejects.toThrow(/"—" normalises to nothing/);
    await expect(run('invalidate', '🎯', 'status')).rejects.toThrow(/"🎯" normalises to nothing/);
    expect(await run('facts', '--history')).toBe('no facts');
  });

  it('the MCP tools return a tool error carrying the value', async () => {
    const ctx = await freshCtx();
    const server = createLoreMcpServer(ctx);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 't', version: '0' });
    await Promise.all([client.connect(ct), server.connect(st)]);
    try {
      const a = (await client.callTool({
        name: 'lore_assert_fact',
        arguments: { subject: '🚀', predicate: 'status', object: 'launched' },
      })) as { isError?: boolean; content: { text: string }[] };
      expect(a.isError).toBe(true);
      expect(a.content[0]!.text).toMatch(/"🚀" normalises to nothing/);
      const i = (await client.callTool({
        name: 'lore_invalidate_fact',
        arguments: { subject: '🎯', predicate: 'status' },
      })) as { isError?: boolean; content: { text: string }[] };
      expect(i.isError).toBe(true);
      expect(i.content[0]!.text).toMatch(/"🎯" normalises to nothing/);
      expect(ctx.store.db.prepare(`SELECT COUNT(*) c FROM facts`).get()).toEqual({ c: 0 });
    } finally {
      await client.close();
      ctx.close();
    }
  });
});
