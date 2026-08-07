import { describe, expect, it } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../src/store/db.js';
import { indexVault } from '../src/index/indexer.js';
import { parseNote } from '../src/vault/parse.js';
import { extractEntities } from '../src/entities/extract.js';

/**
 * Pathological INPUT, not pathological volume. Every case here is one note a
 * real vault actually contains — an Excalidraw drawing, a pasted base64 image,
 * a minified bundle, a CJK page — and each of them used to make indexing take
 * time quadratic in the size of a single unbroken token. These are wall-clock
 * assertions, so they are deliberately loose: they exist to catch a return to
 * quadratic, not to police milliseconds.
 */
describe('scale', () => {
  async function indexOne(content: string): Promise<number> {
    const root = await mkdtemp(join(tmpdir(), 'lw-scale-'));
    await writeFile(join(root, 'a.md'), content);
    const store = openStore(':memory:');
    const t = Date.now();
    await indexVault(store, root);
    const ms = Date.now() - t;
    store.close();
    return ms;
  }

  it('a 2 MB unbroken token indexes in well under a second', async () => {
    // An Excalidraw drawing, a pasted data: URI, a minified bundle. Before the
    // character cap this took roughly half an hour for this one note: the POS
    // tagger is quadratic in token length, and a cap counted in WORDS never
    // fires on a blob that is a single word.
    expect(await indexOne('# Drawing\n\n' + 'A'.repeat(2_000_000) + '\n')).toBeLessThan(4_000);
  }, 30_000);

  it('cost grows linearly, not quadratically, with blob size', async () => {
    const small = await indexOne('# S\n\n' + 'x'.repeat(250_000) + '\n');
    const large = await indexOne('# L\n\n' + 'x'.repeat(1_000_000) + '\n');
    // 4x the input. Linear predicts ~4x; quadratic predicts ~16x. Timing on a
    // loaded CI box is noisy at these speeds, so only reject the blow-up.
    expect(large).toBeLessThan(Math.max(small, 50) * 10);
  }, 30_000);

  it('blocks are bounded in characters, not just words', async () => {
    const blocks = parseNote('a.md', '# T\n\n' + 'x'.repeat(500_000) + '\n', 1).blocks;
    expect(blocks.length).toBeGreaterThan(1);
    for (const b of blocks) expect(b.text.length).toBeLessThanOrEqual(4000);
  });

  it('splitting never severs a surrogate pair', async () => {
    // A lone surrogate is not valid UTF-8; it corrupts the text on its way to
    // SQLite and can make the whole block unsearchable.
    const blocks = parseNote('e.md', '# T\n\n' + '😀'.repeat(30_000) + '\n', 1).blocks;
    const joined = blocks.map((b) => b.text).join('');
    const lone = joined.match(
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
    );
    expect(lone).toBeNull();
    expect(joined.startsWith('😀😀')).toBe(true);
  });

  it('a CJK wall of text has no whitespace and must still be bounded', async () => {
    const blocks = parseNote('cjk.md', '# 标题\n\n' + '知识管理系统'.repeat(20_000) + '\n', 1).blocks;
    expect(blocks.length).toBeGreaterThan(1);
    for (const b of blocks) expect(b.text.length).toBeLessThanOrEqual(4000);
  });

  it('dropping long tokens does not cost real entities', async () => {
    const note = parseNote(
      'p.md',
      'Amara Osei met Priya Sharma about the Riverbed Protocol. ' +
        'The logo is data:image/png;base64,' +
        'iVBORw0KGgo'.repeat(200) +
        ' and NASA signed off.\n',
      1,
    );
    const nlp = extractEntities(note).filter((e) => e.source === 'nlp').map((e) => e.display);
    expect(nlp).toContain('Amara Osei');
    expect(nlp).toContain('Priya Sharma');
    expect(nlp).toContain('Riverbed Protocol');
    expect(nlp).toContain('NASA');
    expect(nlp.some((n) => n.length > 64)).toBe(false);
  });
});
