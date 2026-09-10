import { beforeAll, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildProgram } from '../src/cli/main.js';

/**
 * Note text reached the terminal verbatim. A note holding `\x1b[31m…` and an
 * OSC title-set `\x1b]0;HACKED TITLE\x07` came through `lore search`, `ask`
 * and `timeline` intact (verified with cat -v: `^[[31mRED ALERT^[[0m` and
 * `^[]0;HACKED TITLE^G`). A terminal interprets those: colour spoofing, a
 * rewritten window title, cursor moves that overwrite earlier lines to fake
 * a result, OSC 52 clipboard writes on terminals that allow it. Display is
 * sanitised; what is stored, and what --json carries, is not.
 */
const ESC = '\x1b';
// eslint-disable-next-line no-control-regex
const CONTROL = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/;
let root: string;

async function run(...args: string[]): Promise<string> {
  const out: string[] = [];
  const program = buildProgram({ out: (s) => out.push(s), err: () => {} });
  program.exitOverride();
  for (const c of program.commands) c.exitOverride();
  await program.parseAsync(['node', 'lore', '--vault', root, ...args]);
  return out.join('\n');
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'lw-ansi-'));
  await mkdir(join(root, '.lore'), { recursive: true });
  await writeFile(
    join(root, 'z.md'),
    `# Zebrafish notes\n\n## Sec${ESC}[2Ktion\n\nThe zebrafish protocol is ${ESC}[31mRED ALERT${ESC}[0m and ${ESC}]0;HACKED TITLE\x07 embedded.\n`,
  );
  await run('index');
  await run('assert', 'Zebrafish', 'status', `${ESC}]0;HACKED\x07live`, '--valid-from', '2026-01-01');
});

describe('terminal output', () => {
  it('search shows the note without control sequences', async () => {
    const out = await run('search', 'zebrafish', 'protocol');
    expect(out).toContain('z.md');
    expect(out).toContain('RED ALERT');
    expect(out).not.toMatch(CONTROL);
    expect(out).toContain('�');
  });

  it('--json still carries the raw text', async () => {
    const res = JSON.parse(await run('search', 'zebrafish', 'protocol', '--json')) as {
      snippet: string;
      anchor: string;
    }[];
    expect(res.length).toBeGreaterThan(0);
    expect(res.some((r) => r.snippet.includes(`${ESC}[31m`) || r.anchor.includes(`${ESC}[2K`))).toBe(true);
  });

  it('ask, facts and timeline are clean too', async () => {
    for (const args of [
      ['ask', 'zebrafish', 'protocol', 'status'],
      ['facts', '--subject', 'Zebrafish'],
      ['timeline', 'Zebrafish'],
    ]) {
      const out = await run(...args);
      expect(out, args.join(' ')).toContain('live');
      expect(out, args.join(' ')).not.toMatch(CONTROL);
    }
    const tl = JSON.parse(await run('timeline', 'Zebrafish', '--json')) as { value?: string }[];
    expect(tl.some((e) => typeof e.value === 'string' && e.value.includes(ESC))).toBe(true);
  });

  it('tabs and newlines survive — only controls are replaced', async () => {
    // A tab cannot be observed through a search snippet: bestSnippet folds
    // runs of whitespace for display and always has. A fact's object is
    // echoed verbatim, so pair the tab with a control in the same value —
    // the control must go, the tab must stay.
    await run('assert', 'Tabbed', 'columns', `col1\tcol2${ESC}[0m`, '--valid-from', '2026-01-01');
    const out = await run('facts', '--subject', 'Tabbed');
    expect(out).toContain('col1\tcol2');
    expect(out).not.toMatch(CONTROL);
    // The newline between a result's location line and its snippet is the
    // frame's own, and must survive too.
    expect(await run('search', 'zebrafish', 'protocol')).toMatch(/\]\n {2}/);
  });
});
