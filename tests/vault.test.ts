import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseNote } from '../src/vault/parse.js';
import { scanVault } from '../src/vault/scan.js';

describe('parseNote', () => {
  it('parses frontmatter, title, tags', () => {
    const raw = `---\ntitle: My Note\ntags: [alpha, Beta]\n---\n\nBody with #inline-tag here.\n`;
    const n = parseNote('a/b.md', raw, 1);
    expect(n.title).toBe('My Note');
    expect(n.tags.sort()).toEqual(['alpha', 'beta', 'inline-tag']);
    expect(n.warnings).toEqual([]);
  });

  it('survives broken frontmatter without throwing', () => {
    const raw = `---\ntitle: [unclosed\n  bad: {yaml\n---\n\nContent survives.\n`;
    const n = parseNote('x.md', raw, 1);
    expect(n.title).toBe('x');
    expect(n.warnings.length).toBeGreaterThan(0);
    expect(n.blocks.map((b) => b.text).join(' ')).toContain('Content survives');
  });

  it('splits heading-bounded blocks with stable nested anchors', () => {
    const raw = `Preamble text.\n\n# One\n\npara one\n\n## Two\n\npara two\n\n# Three\n\npara three\n`;
    const n = parseNote('n.md', raw, 1);
    const anchors = n.blocks.map((b) => b.anchor);
    expect(anchors).toEqual(['@0', 'One@0', 'One/Two@0', 'Three@0']);
    expect(n.blocks[2]!.heading).toBe('One/Two');
  });

  it('does not treat # lines inside code fences as headings', () => {
    const raw = 'Text\n\n```bash\n# not a heading\necho hi\n```\n\nmore text\n';
    const n = parseNote('n.md', raw, 1);
    expect(n.blocks.length).toBe(1);
    expect(n.blocks[0]!.text).toContain('# not a heading');
  });

  it('parses the wiki-link matrix', () => {
    const raw = `See [[Target]], [[Other|shown]], [[Page#Section]], [[Deep#Part|alias]].`;
    const n = parseNote('n.md', raw, 1);
    expect(n.links).toHaveLength(4);
    expect(n.links[0]).toMatchObject({ target: 'Target', heading: undefined, alias: undefined });
    expect(n.links[1]).toMatchObject({ target: 'Other', alias: 'shown' });
    expect(n.links[2]).toMatchObject({ target: 'Page', heading: 'Section' });
    expect(n.links[3]).toMatchObject({ target: 'Deep', heading: 'Part', alias: 'alias' });
    expect(n.links[0]!.blockAnchor).toBe('@0');
  });

  it('splits oversized sections at paragraph borders with sequence anchors', () => {
    const para = 'word '.repeat(200).trim();
    const raw = `# Big\n\n${para}\n\n${para}\n\n${para}\n`;
    const n = parseNote('n.md', raw, 1);
    const bigAnchors = n.blocks.map((b) => b.anchor);
    expect(bigAnchors).toEqual(['Big@0', 'Big@1', 'Big@2']);
  });

  it('a note that is only a heading is still indexable', () => {
    // Stub notes (created by following a link) and index/MOC notes are often
    // nothing but headings. They produced zero blocks and were invisible: a
    // note titled "Quokka Protocol" could not be found by searching for it.
    const stub = parseNote('stub.md', '# Quokka Protocol\n', 1);
    expect(stub.blocks.length).toBeGreaterThan(0);
    expect(stub.blocks[0]!.text).toContain('Quokka Protocol');

    const moc = parseNote('moc.md', '# Index\n\n## Projects\n\n## People\n', 1);
    const text = moc.blocks.map((b) => b.text).join(' ');
    expect(text).toContain('Projects');
    expect(text).toContain('People');
  });

  it('an empty note produces no blocks', () => {
    expect(parseNote('empty.md', '', 1).blocks).toEqual([]);
    expect(parseNote('ws.md', '   \n\n  \n', 1).blocks).toEqual([]);
  });

  it('headings with bodies are unaffected', () => {
    const n = parseNote('n.md', '# A\n\nbody of a\n\n## B\n\nbody of b\n', 1);
    expect(n.blocks.map((b) => b.text)).toEqual(['body of a', 'body of b']);
  });

  it('handles unicode content and paths', () => {
    const raw = `# Überblick\n\nNaïve café — 中文内容 #标签\n`;
    const n = parseNote('notes/日本語.md', raw, 1);
    expect(n.title).toBe('日本語');
    expect(n.tags).toContain('标签');
    expect(n.blocks[0]!.heading).toBe('Überblick');
  });

  it('block hashes are content-stable', () => {
    const a = parseNote('a.md', '# H\n\nsame text\n', 1);
    const b = parseNote('b.md', '# H\n\nsame text\n', 999);
    expect(a.blocks[0]!.hash).toBe(b.blocks[0]!.hash);
  });
});

describe('scanVault', () => {
  it('finds md files recursively, skips ignored dirs, sorted output', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lw-scan-'));
    await mkdir(join(root, 'sub'), { recursive: true });
    await mkdir(join(root, '.obsidian'), { recursive: true });
    await mkdir(join(root, '.lore'), { recursive: true });
    await writeFile(join(root, 'b.md'), 'b');
    await writeFile(join(root, 'sub', 'a.md'), 'a');
    await writeFile(join(root, 'sub', 'skip.txt'), 'x');
    await writeFile(join(root, '.obsidian', 'hidden.md'), 'x');
    await writeFile(join(root, '.lore', 'index.md'), 'x');
    const files = await scanVault(root);
    expect(files.map((f) => f.path)).toEqual(['b.md', 'sub/a.md']);
  });
});
