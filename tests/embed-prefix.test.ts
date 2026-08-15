import { describe, expect, it } from 'vitest';
import { resolveProvider, prefixesFor } from '../src/embed/index.js';
import { ConfigSchema } from '../src/config.js';

/**
 * Asymmetric retrieval models are TRAINED with a task prefix. Without one,
 * queries and passages land in the same region of the space and the dense
 * channel stops discriminating — measured here as embeddings making retrieval
 * WORSE than no embeddings at all (0.31.0), and reversed the moment the
 * prefixes were sent (kestrel r@5 0.750 → 0.825).
 */
describe('embedding task prefixes', () => {
  it('infers the prefixes each model family was trained with', () => {
    const For = (model: string) => prefixesFor(ConfigSchema.parse({ embedding: { model } }));
    expect(For('nomic-embed-text')).toEqual({
      query: 'search_query: ',
      document: 'search_document: ',
    });
    expect(For('intfloat/e5-large-v2')).toEqual({ query: 'query: ', document: 'passage: ' });
    expect(For('bge-large-en').document).toBe('');
    expect(For('bge-large-en').query).toMatch(/^Represent this sentence/);
    // mixedbread and Snowflake Arctic trained retrieval on the same
    // instruction as BGE. Falling through to the symmetric default costs
    // recall silently rather than failing, so each family is pinned here.
    expect(For('mxbai-embed-large').query).toMatch(/^Represent this sentence/);
    expect(For('mxbai-embed-large').document).toBe('');
    expect(For('snowflake-arctic-embed:335m').query).toMatch(/^Represent this sentence/);
    // symmetric models want nothing at all
    expect(For('text-embedding-3-small')).toEqual({ query: '', document: '' });
  });

  it('config wins over inference, and "" means no prefix rather than unset', () => {
    const cfg = ConfigSchema.parse({
      embedding: { model: 'nomic-embed-text', queryPrefix: '', documentPrefix: 'passage: ' },
    });
    expect(prefixesFor(cfg)).toEqual({ query: '', document: 'passage: ' });
  });

  it('sends the query prefix on queries and the document prefix on passages', async () => {
    const seen: { texts: string[] }[] = [];
    const fakeFetch = (async (_url: string, init: { body: string }) => {
      const body = JSON.parse(init.body) as { input: string[] };
      seen.push({ texts: body.input });
      return {
        ok: true,
        json: async () => ({ embeddings: body.input.map(() => [0.1, 0.2, 0.3]) }),
      };
    }) as unknown as typeof fetch;

    const cfg = ConfigSchema.parse({
      embedding: { provider: 'ollama', model: 'nomic-embed-text' },
    });
    const provider = resolveProvider(cfg, fakeFetch)!;
    await provider.embed(['what changed in March'], 'query');
    await provider.embed(['The ledger migration finished.'], 'document');
    // the default is 'document', because indexing is the caller that omits it
    await provider.embed(['Another passage.']);

    expect(seen[0]!.texts).toEqual(['search_query: what changed in March']);
    expect(seen[1]!.texts).toEqual(['search_document: The ledger migration finished.']);
    expect(seen[2]!.texts).toEqual(['search_document: Another passage.']);
  });

  it('a model needing no prefix is passed through untouched', async () => {
    const seen: string[][] = [];
    const fakeFetch = (async (_url: string, init: { body: string }) => {
      const body = JSON.parse(init.body) as { input: string[] };
      seen.push(body.input);
      return { ok: true, json: async () => ({ embeddings: body.input.map(() => [1, 0]) }) };
    }) as unknown as typeof fetch;
    const cfg = ConfigSchema.parse({
      embedding: { provider: 'ollama', model: 'text-embedding-3-small' },
    });
    await resolveProvider(cfg, fakeFetch)!.embed(['plain text'], 'query');
    expect(seen[0]).toEqual(['plain text']);
  });
});
