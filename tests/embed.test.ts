import { describe, expect, it, vi } from 'vitest';
import { openStore } from '../src/store/db.js';
import { parseNote } from '../src/vault/parse.js';
import {
  buildSimilarEdges,
  cosine,
  denseTopK,
  embedMissingBlocks,
  resolveProvider,
} from '../src/embed/index.js';
import { ConfigSchema } from '../src/config.js';

function mockFetch(handler: (url: string, init: RequestInit) => unknown): typeof fetch {
  return vi.fn(async (url: any, init: any) => ({
    ok: true,
    status: 200,
    json: async () => handler(String(url), init),
    text: async () => '',
  })) as unknown as typeof fetch;
}

/** deterministic toy embedding: [len, vowels, spaces] normalized-ish */
function toyVec(text: string): number[] {
  const vowels = (text.match(/[aeiou]/gi) ?? []).length;
  const spaces = (text.match(/\s/g) ?? []).length;
  return [text.length / 100, vowels / 20, spaces / 10];
}

describe('embeddings', () => {
  it('provider none → null; call-sites no-op', () => {
    const cfg = ConfigSchema.parse({});
    expect(resolveProvider(cfg)).toBeNull();
  });

  it('openai provider requires the env var', () => {
    const cfg = ConfigSchema.parse({ embedding: { provider: 'openai', apiKeyEnv: 'LW_TEST_MISSING' } });
    expect(() => resolveProvider(cfg)).toThrow(/LW_TEST_MISSING/);
  });

  it('ollama provider embeds and stores; denseTopK ranks correctly', async () => {
    const cfg = ConfigSchema.parse({ embedding: { provider: 'ollama' } });
    const f = mockFetch((_url, init) => {
      const body = JSON.parse(String(init.body)) as { input: string[] };
      return { embeddings: body.input.map(toyVec) };
    });
    const provider = resolveProvider(cfg, f)!;
    const store = openStore(':memory:');
    store.upsertNote(parseNote('a.md', 'aaaa eeee iiii\n', 1));
    store.upsertNote(parseNote('b.md', 'zzzz qqqq wwww\n', 1));
    const n = await embedMissingBlocks(store, provider);
    expect(n).toBe(2);
    // re-run: nothing missing
    expect(await embedMissingBlocks(store, provider)).toBe(0);

    const q = Float32Array.from(toyVec('aaaa eeee iiii'));
    const hits = denseTopK(store, q, 2);
    expect(hits).toHaveLength(2);
    const top = store.db
      .prepare(`SELECT note_path FROM blocks WHERE id=?`)
      .get(hits[0]!.blockId) as any;
    expect(top.note_path).toBe('a.md');
    store.close();
  });

  it('buildSimilarEdges links near-duplicates only', async () => {
    const cfg = ConfigSchema.parse({ embedding: { provider: 'ollama' } });
    const f = mockFetch((_url, init) => {
      const body = JSON.parse(String(init.body)) as { input: string[] };
      return { embeddings: body.input.map(toyVec) };
    });
    const provider = resolveProvider(cfg, f)!;
    const store = openStore(':memory:');
    store.upsertNote(parseNote('a.md', 'aaaa eeee iiii oooo\n', 1));
    store.upsertNote(parseNote('b.md', 'aaaa eeee iiii uuuu\n', 1)); // near-dup of a
    await embedMissingBlocks(store, provider);
    const edges = buildSimilarEdges(store, { threshold: 0.95, topK: 3 });
    expect(edges).toBeGreaterThanOrEqual(1);
    store.close();
  });

  it('cosine basics', () => {
    expect(cosine(Float32Array.from([1, 0]), Float32Array.from([1, 0]))).toBeCloseTo(1);
    expect(cosine(Float32Array.from([1, 0]), Float32Array.from([0, 1]))).toBeCloseTo(0);
    expect(cosine(Float32Array.from([0, 0]), Float32Array.from([1, 1]))).toBe(0);
  });
});
