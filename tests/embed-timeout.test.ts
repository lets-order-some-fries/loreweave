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
 *
 * These cases pin the single-attempt behaviour, so they set maxRetries: 0.
 * Retry behaviour is pinned separately below.
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

    const cfg = ConfigSchema.parse({
      embedding: { provider: 'ollama', timeoutMs: 1000, maxRetries: 0 },
    });
    await expect(resolveProvider(cfg, hangingFetch)!.embed(['hello'])).rejects.toThrow(
      /timed out after 1000ms.*embedding\.timeoutMs/s,
    );
  });

  it('leaves non-timeout failures alone rather than mislabelling them', async () => {
    const brokenFetch = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;

    const cfg = ConfigSchema.parse({ embedding: { provider: 'ollama', maxRetries: 0 } });
    await expect(resolveProvider(cfg, brokenFetch)!.embed(['hello'])).rejects.toThrow(
      /ECONNREFUSED/,
    );
  });
});

/**
 * A local embedding server under memory pressure stops answering for a stretch
 * and then recovers on its own. Without retries one such stall aborts an index
 * that may be hours in — observed as a 500-question benchmark that died at
 * question 450, losing three and a half hours to a server that answered in
 * 67 ms once the run was gone.
 */
describe('embedding request retries', () => {
  const okResponse = (input: string[]) => ({
    ok: true,
    status: 200,
    json: async () => ({ embeddings: input.map(() => [0.1]) }),
  });

  it('survives a transient stall and returns the eventual success', async () => {
    let calls = 0;
    const flakyFetch = (async (_url: string, init: RequestInit & { body: string }) => {
      calls++;
      if (calls === 1) throw Object.assign(new Error('aborted'), { name: 'TimeoutError' });
      return okResponse((JSON.parse(init.body) as { input: string[] }).input);
    }) as unknown as typeof fetch;

    const cfg = ConfigSchema.parse({
      embedding: { provider: 'ollama', timeoutMs: 1000, maxRetries: 2 },
    });
    const out = await resolveProvider(cfg, flakyFetch)!.embed(['hello']);

    expect(calls).toBe(2);
    expect(out).toHaveLength(1);
  });

  it('gives up after the configured number of retries', async () => {
    let calls = 0;
    const deadFetch = (async () => {
      calls++;
      throw Object.assign(new Error('aborted'), { name: 'TimeoutError' });
    }) as unknown as typeof fetch;

    const cfg = ConfigSchema.parse({
      embedding: { provider: 'ollama', timeoutMs: 1000, maxRetries: 1 },
    });
    await expect(resolveProvider(cfg, deadFetch)!.embed(['hello'])).rejects.toThrow(/timed out/);

    // One initial attempt plus one retry — retries are attempts *after* the first.
    expect(calls).toBe(2);
  });

  it('retries a 503 but not a 400, because a bad request stays bad', async () => {
    const statusFetch = (status: number) => {
      let calls = 0;
      const impl = (async (_url: string, init: RequestInit & { body: string }) => {
        calls++;
        if (calls === 1) return { ok: false, status, text: async () => 'nope' };
        return okResponse((JSON.parse(init.body) as { input: string[] }).input);
      }) as unknown as typeof fetch;
      return { impl, calls: () => calls };
    };

    const transient = statusFetch(503);
    const cfg = ConfigSchema.parse({
      embedding: { provider: 'ollama', timeoutMs: 1000, maxRetries: 2 },
    });
    await resolveProvider(cfg, transient.impl)!.embed(['hello']);
    expect(transient.calls()).toBe(2);

    const permanent = statusFetch(400);
    await expect(resolveProvider(cfg, permanent.impl)!.embed(['hello'])).rejects.toThrow(/400/);
    expect(permanent.calls()).toBe(1);
  });
});
