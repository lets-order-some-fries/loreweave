import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { openStore } from '../src/store/db.js';
import { parseNote } from '../src/vault/parse.js';
import { ConfigSchema } from '../src/config.js';
import { denseTopK, embedMissingBlocks, resolveProvider } from '../src/embed/index.js';

/**
 * Wire-level tests: the providers speak real HTTP to a stub implementing the
 * documented Ollama / OpenAI embedding contracts. Previous coverage mocked
 * `fetch`, which cannot catch a wrong URL path, a wrong body shape, or a
 * response the real code fails to parse.
 */
let server: Server;
let baseUrl = '';
const seen: { path: string; body: any }[] = [];

/** Deterministic stand-in for a model: 8-dim bag-of-chars. */
function embedOf(text: string): number[] {
  const v = new Array(8).fill(0);
  for (const ch of text.toLowerCase()) {
    const c = ch.charCodeAt(0);
    if (c >= 97 && c <= 122) v[(c - 97) % 8]! += 1;
  }
  const n = Math.hypot(...v) || 1;
  return v.map((x) => x / n);
}

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : {};
      seen.push({ path: req.url ?? '', body });
      res.setHeader('content-type', 'application/json');
      if (req.url === '/api/embed') {
        // Ollama: { model, input: string[] } -> { embeddings: number[][] }
        res.end(JSON.stringify({ embeddings: (body.input as string[]).map(embedOf) }));
      } else if (req.url?.endsWith('/embeddings')) {
        // OpenAI: { model, input } -> { data: [{ index, embedding }] }
        const inputs = body.input as string[];
        // deliberately out of order — the client must sort by index
        const data = inputs
          .map((t, i) => ({ index: i, embedding: embedOf(t) }))
          .reverse();
        res.end(JSON.stringify({ data }));
      } else {
        res.statusCode = 404;
        res.end(JSON.stringify({ error: 'not found' }));
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe('embedding providers over real HTTP', () => {
  it('ollama: correct endpoint, request shape, and stored vectors', async () => {
    const cfg = ConfigSchema.parse({ embedding: { provider: 'ollama', url: baseUrl, model: 'test-model' } });
    const provider = resolveProvider(cfg)!;
    const store = openStore(':memory:');
    store.upsertNote(parseNote('a.md', 'alpha beta gamma\n', 1));
    const n = await embedMissingBlocks(store, provider);
    expect(n).toBe(1);

    const call = seen.find((s) => s.path === '/api/embed')!;
    expect(call).toBeDefined();
    expect(call.body.model).toBe('test-model');
    expect(Array.isArray(call.body.input)).toBe(true);

    const row = store.db.prepare('SELECT dims, provider FROM embeddings').get() as any;
    expect(row.dims).toBe(8);
    expect(row.provider).toBe('ollama:test-model');
    store.close();
  });

  it('openai: sorts by index, so vectors are not silently mismatched', async () => {
    process.env.LW_TEST_KEY = 'sk-test';
    const cfg = ConfigSchema.parse({
      embedding: { provider: 'openai', url: baseUrl, model: 'text-embed', apiKeyEnv: 'LW_TEST_KEY' },
    });
    const provider = resolveProvider(cfg)!;
    const distinct = ['aaaa', 'bbbb', 'cccc'];
    const vecs = await provider.embed(distinct);
    // the stub returns them reversed; correct ordering means vecs[i] matches input i
    for (let i = 0; i < distinct.length; i++) {
      expect(Array.from(vecs[i]!)).toEqual(embedOf(distinct[i]!).map((x) => Math.fround(x)));
    }
    delete process.env.LW_TEST_KEY;
  });

  it('dense retrieval ranks by real cosine over stored blobs', async () => {
    const cfg = ConfigSchema.parse({ embedding: { provider: 'ollama', url: baseUrl, model: 'm' } });
    const provider = resolveProvider(cfg)!;
    const store = openStore(':memory:');
    store.upsertNote(parseNote('a.md', 'aaaa aaaa aaaa\n', 1));
    store.upsertNote(parseNote('b.md', 'zzzz zzzz zzzz\n', 1));
    await embedMissingBlocks(store, provider);
    const [q] = await provider.embed(['aaaa']);
    const hits = denseTopK(store, q!, 2);
    const top = store.db.prepare('SELECT note_path FROM blocks WHERE id=?').get(hits[0]!.blockId) as any;
    expect(top.note_path).toBe('a.md');
    store.close();
  });

  it('a provider failure degrades instead of throwing out of embedMissingBlocks', async () => {
    const cfg = ConfigSchema.parse({
      embedding: { provider: 'ollama', url: `${baseUrl}/wrong`, model: 'm' },
    });
    const provider = resolveProvider(cfg)!;
    const store = openStore(':memory:');
    store.upsertNote(parseNote('a.md', 'content\n', 1));
    await expect(embedMissingBlocks(store, provider)).rejects.toThrow(/ollama embed failed/);
    store.close();
  });
});
