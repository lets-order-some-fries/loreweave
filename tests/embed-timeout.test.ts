import { describe, expect, it } from 'vitest';
import { resolveProvider } from '../src/embed/index.js';
import { ConfigSchema } from '../src/config.js';

/**
 * Node's fetch has no default timeout. A socket that dies without closing —
 * a laptop suspended mid-index, a paused container, a VPN dropping — leaves
 * the request pending forever, and the indexer hangs with no output and no
 * error. That is strictly worse than failing: the caller cannot tell "slow"
 * from "dead". Observed as a benchmark process that sat for 79 minutes having
 * consumed 9 seconds of CPU.
 */
describe('embedding request timeouts', () => {
  it('passes an abort signal on every request', async () => {
    const seen: (AbortSignal | undefined)[] = [];
    const fakeFetch = (async (_url: string, init: RequestInit & { body: string }) => {
      seen.push(init.signal ?? undefined);
      const body = JSON.parse(init.body) as { input: string[] };
      return { ok: true, json: async () => ({ embeddings: body.input.map(() => [0.1]) }) };
    }) as unknown as typeof fetch;

    const cfg = ConfigSchema.parse({ embedding: { provider: 'ollama' } });
    await resolveProvider(cfg, fakeFetch)!.embed(['hello']);

    expect(seen[0]).toBeInstanceOf(AbortSignal);
  });

  it('reports a hung server as a timeout naming the knob that fixes it', async () => {
    // Never resolves until aborted — exactly the dead-socket case.
    const hangingFetch = ((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          reject(Object.assign(new Error('aborted'), { name: 'TimeoutError' }));
        });
      })) as unknown as typeof fetch;

    const cfg = ConfigSchema.parse({ embedding: { provider: 'ollama', timeoutMs: 1000 } });
    await expect(resolveProvider(cfg, hangingFetch)!.embed(['hello'])).rejects.toThrow(
      /timed out after 1000ms.*embedding\.timeoutMs/s,
    );
  });

  it('leaves non-timeout failures alone rather than mislabelling them', async () => {
    const brokenFetch = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;

    const cfg = ConfigSchema.parse({ embedding: { provider: 'ollama' } });
    await expect(resolveProvider(cfg, brokenFetch)!.embed(['hello'])).rejects.toThrow(
      /ECONNREFUSED/,
    );
  });
});
