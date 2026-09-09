import { describe, expect, it } from 'vitest';
import { loadConfig, ConfigSchema } from '../src/config.js';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildProgram } from '../src/cli/main.js';
import { openContext } from '../src/context.js';
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

describe('config', () => {
  it('every key `lore init` writes changes what the engine does', async () => {
    // This used to assert that the written values survive ConfigSchema.parse —
    // a schema round trip, which passed while `nlp: false` was being dropped
    // by `lore index` and `ignore` was wired to nothing. A key is honoured
    // when flipping it changes behaviour, so each one is flipped and the
    // effect observed through the real CLI.
    const root = await mkdtemp(join(tmpdir(), 'lw-cfg-'));
    await writeFile(
      join(root, 'note.md'),
      '# Note\n\nAlice Johnson met Bob Martinez in Paris.\n\nowner:: Priya Sharma\n',
    );
    const prog = buildProgram({ out: () => {}, err: () => {} });
    await prog.parseAsync(['node', 'lore', '--vault', root, 'init']);
    const cfgPath = join(root, '.lore', 'config.json');
    const written = JSON.parse(await readFile(cfgPath, 'utf8')) as {
      embedding: { provider: string; model: string; url: string };
      facts: { extract: string };
      nlp: boolean;
    };
    // the file init writes is recognised in full
    const warnings: string[] = [];
    loadConfig(root, (m) => warnings.push(m));
    expect(warnings).toEqual([]);
    expect(Object.keys(written).sort()).toEqual(['embedding', 'facts', 'nlp']);

    const runIndex = async () => {
      const p = buildProgram({ out: () => {}, err: () => {} });
      await p.parseAsync(['node', 'lore', '--vault', root, 'index', '--full']);
    };
    const query = <T>(sql: string): T[] => {
      const ctx = openContext(root);
      try {
        return ctx.store.db.prepare(sql).all() as T[];
      } finally {
        ctx.close();
      }
    };
    const sources = () =>
      query<{ source: string }>('SELECT DISTINCT source FROM mentions').map((r) => r.source);
    const factCount = () => query('SELECT 1 FROM facts').length;

    // as written: NLP on, explicit fact extraction on, no embedding provider
    await runIndex();
    expect(sources()).toContain('nlp');
    expect(factCount()).toBeGreaterThan(0);
    {
      const ctx = openContext(root);
      expect(ctx.provider).toBeNull();
      ctx.close();
    }

    // nlp: false → no NLP mentions
    await writeFile(cfgPath, JSON.stringify({ ...written, nlp: false }));
    await runIndex();
    expect(sources()).not.toContain('nlp');

    // facts.extract: off → nothing mined from the note
    await writeFile(cfgPath, JSON.stringify({ ...written, facts: { extract: 'off' } }));
    await runIndex();
    expect(factCount()).toBe(0);

    // embedding.provider: ollama → a provider is constructed (no network yet)
    await writeFile(
      cfgPath,
      JSON.stringify({ ...written, embedding: { ...written.embedding, provider: 'ollama' } }),
    );
    {
      const ctx = openContext(root);
      expect(ctx.provider).not.toBeNull();
      ctx.close();
    }
  });

  it('names a mistyped or mis-nested key instead of ignoring it', async () => {
    // `{"index": {"nlp": false}}` is a very natural guess — nlp lives at the
    // top level — and it used to be discarded whole with no output at all.
    const root = await mkdtemp(join(tmpdir(), 'lw-cfg-bad-'));
    await mkdir(join(root, '.lore'), { recursive: true });
    await writeFile(
      join(root, '.lore', 'config.json'),
      JSON.stringify({ nlpp: false, index: { nlp: false }, retrieval: { kk: 9 } }),
    );
    const warnings: string[] = [];
    loadConfig(root, (m) => warnings.push(m));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('nlpp');
    expect(warnings[0]).toContain('index');
    expect(warnings[0]).toContain('retrieval.kk');
  });

  it('says nothing about a config that is entirely valid', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lw-cfg-ok-'));
    await mkdir(join(root, '.lore'), { recursive: true });
    await writeFile(
      join(root, '.lore', 'config.json'),
      JSON.stringify({ embedding: { provider: 'ollama' }, nlp: false, retrieval: { k: 12 } }),
    );
    const warnings: string[] = [];
    const cfg = loadConfig(root, (m) => warnings.push(m));
    expect(warnings).toEqual([]);
    expect(cfg.nlp).toBe(false);
    expect(cfg.retrieval.k).toBe(12);
  });
});

describe('README examples show real output', () => {
  // The README's example outputs are the human-facing contract, the same way
  // the tool descriptions are the agent-facing one — and they had drifted the
  // same way: the search example still showed the `#Heading@0` anchor display
  // that was replaced by `› Heading` long ago. A reader comparing their real
  // output against the README would conclude their install was broken.
  it('never shows the dead anchor display format in example output', async () => {
    const readme = await readFile(join(import.meta.dirname, '..', 'README.md'), 'utf8');
    // Result bullets in examples must use the live `path › Heading` display —
    // the old `path#Heading@0` form only ever appears for review-queue
    // duplicate lines, which genuinely print anchors.
    const badBullets = readme
      .split('\n')
      .filter((l) => l.trimStart().startsWith('• ') && /#[^\s]+@\d/.test(l));
    expect(badBullets).toEqual([]);
  });

  it('the assert example includes the journal line the command prints', async () => {
    const readme = await readFile(join(import.meta.dirname, '..', 'README.md'), 'utf8');
    const assertBlock = readme.slice(readme.indexOf('$ lore assert'));
    expect(assertBlock.slice(0, 400)).toContain('journal: lore/journal/');
  });
});
