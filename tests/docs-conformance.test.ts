import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildProgram } from '../src/cli/main.js';
import { createLoreMcpServer } from '../src/mcp/server.js';
import { openStore } from '../src/store/db.js';
import { ConfigSchema } from '../src/config.js';
import { buildGraph, type LoreGraph } from '../src/graph/build.js';
import { buildNoteLinkGraph } from '../src/retrieve/expand.js';
import type { LoreContext } from '../src/context.js';

/**
 * The README is a promise. A previous audit of this codebase found commands
 * and flags documented but not implemented, which is worse than no docs —
 * so the docs are checked against the code on every run.
 */
const README = readFileSync(join(process.cwd(), 'README.md'), 'utf8');
const program = buildProgram({ out: () => {}, err: () => {} });

function documentedCommands(): string[] {
  const names = new Set<string>();
  // rows of the CLI table: | `lore <name> ...` | description |
  for (const m of README.matchAll(/^\|\s*`lore ([a-z-]+)[^`]*`/gm)) names.add(m[1]!);
  return [...names];
}

function documentedFlagsFor(cmd: string): string[] {
  const flags = new Set<string>();
  for (const m of README.matchAll(/^\|\s*`lore ([a-z-]+)([^`]*)`/gm)) {
    if (m[1] !== cmd) continue;
    for (const f of (m[2] ?? '').matchAll(/--([a-z-]+)/g)) flags.add(f[1]!);
  }
  return [...flags];
}

describe('README conformance', () => {
  it('documents at least the core commands', () => {
    const documented = documentedCommands();
    expect(documented.length).toBeGreaterThanOrEqual(10);
    for (const required of ['init', 'index', 'search', 'ask', 'facts', 'dream']) {
      expect(documented).toContain(required);
    }
  });

  it('every documented command exists in the CLI', () => {
    const implemented = new Set(program.commands.map((c) => c.name()));
    const missing = documentedCommands().filter((c) => !implemented.has(c));
    expect(missing).toEqual([]);
  });

  it('every documented flag exists on its command', () => {
    const bad: string[] = [];
    for (const name of documentedCommands()) {
      const cmd = program.commands.find((c) => c.name() === name);
      if (!cmd) continue;
      const opts = new Set(
        cmd.options.flatMap((o) => [o.long?.replace(/^--/, ''), o.short?.replace(/^-/, '')]),
      );
      // commander models --no-x as the negated long flag
      for (const f of documentedFlagsFor(name)) {
        if (!opts.has(f) && !opts.has(`no-${f}`)) bad.push(`${name} --${f}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('every implemented command is documented', () => {
    const documented = new Set(documentedCommands());
    // `serve` is documented in prose (the MCP section) rather than the table
    const undocumented = program.commands
      .map((c) => c.name())
      .filter((n) => !documented.has(n) && n !== 'serve' && n !== 'help');
    expect(undocumented).toEqual([]);
  });

  it('the MCP tool list in the README matches the server', async () => {
    const config = ConfigSchema.parse({});
    const store = openStore(':memory:');
    let cached: LoreGraph | null = null;
    const ctx: LoreContext = {
      root: process.cwd(),
      config,
      store,
      provider: null,
      graph: () => (cached ??= buildGraph(store, config)),
      noteLinks: () => buildNoteLinkGraph(store),
      invalidateGraph: () => (cached = null),
      close: () => store.close(),
    };
    const server = createLoreMcpServer(ctx);
    const registered = new Set(Object.keys((server as any)._registeredTools ?? {}));
    expect(registered.size).toBeGreaterThan(0);

    const mentioned = new Set([...README.matchAll(/`(lore_[a-z_]+)`/g)].map((m) => m[1]!));
    for (const tool of registered) expect(mentioned).toContain(tool);
    for (const tool of mentioned) expect(registered).toContain(tool);

    // the count claimed in prose must match reality
    const claim = README.match(/exposes (\d+) typed tools/);
    if (claim) expect(Number(claim[1])).toBe(registered.size);
    store.close();
  });
});
