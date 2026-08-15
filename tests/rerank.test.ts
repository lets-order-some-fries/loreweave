import { describe, expect, it, beforeEach } from 'vitest';
import { resolveReranker, _resetRerankerCache } from '../src/rerank/index.js';
import { ConfigSchema } from '../src/config.js';

/**
 * Reranking is an enhancement on an optional dependency. The contract that
 * matters is what happens when it is absent or broken: search must still
 * return the results it would otherwise have returned.
 */
describe('optional reranker', () => {
  beforeEach(() => _resetRerankerCache());

  it('is off unless configured', async () => {
    expect(await resolveReranker(ConfigSchema.parse({}))).toBeNull();
    expect(await resolveReranker(ConfigSchema.parse({ rerank: { provider: 'none' } }))).toBeNull();
  });

  it('defaults to a cross-encoder trained for retrieval, not a chat model', () => {
    const cfg = ConfigSchema.parse({ rerank: { provider: 'transformers' } });
    expect(cfg.rerank.model).toMatch(/ms-marco/);
    expect(cfg.rerank.topK).toBeGreaterThanOrEqual(10);
  });

  it('a missing or broken dependency degrades to null, never a throw', async () => {
    const cfg = ConfigSchema.parse({
      rerank: { provider: 'transformers', model: 'this-model-does-not-exist/nowhere' },
    });
    // Resolution must not reject: losing the reranker may not lose the search.
    await expect(resolveReranker(cfg)).resolves.toBeNull();
  });
});
