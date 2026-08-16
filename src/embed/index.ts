import { isHeadingEcho } from '../vault/parse.js';
import type { Store } from '../store/db.js';
import type { LoreConfig } from '../config.js';

export type EmbedRole = 'query' | 'document';

export interface EmbeddingProvider {
  name: string;
  model: string;
  /**
   * `role` selects the task prefix an asymmetric model was trained with.
   * Defaults to 'document' so existing callers keep indexing behaviour.
   */
  embed(texts: string[], role?: EmbedRole): Promise<Float32Array[]>;
}

/**
 * The task prefixes each model family was trained with.
 *
 * These are not decoration. An asymmetric retrieval model learns "queries look
 * like THIS, passages look like THAT" from the prefix, and without it both
 * sides land in the same region of the space — measured here as a dense
 * channel that made ranking WORSE than no dense channel at all.
 */
function defaultPrefixes(model: string): { query: string; document: string } {
  const m = model.toLowerCase();
  if (m.includes('nomic-embed')) return { query: 'search_query: ', document: 'search_document: ' };
  if (m.includes('e5')) return { query: 'query: ', document: 'passage: ' };
  // BGE, mixedbread and Snowflake Arctic all trained retrieval on the same
  // instruction, and all three want it on the query side only.
  if (m.includes('bge') || m.includes('mxbai') || m.includes('arctic-embed')) {
    return { query: 'Represent this sentence for searching relevant passages: ', document: '' };
  }
  // OpenAI's text-embedding-3-* and most symmetric models want nothing.
  return { query: '', document: '' };
}

/** Config wins over inference; '' is a real answer meaning "no prefix". */
export function prefixesFor(config: LoreConfig): { query: string; document: string } {
  const auto = defaultPrefixes(config.embedding.model);
  return {
    query: config.embedding.queryPrefix ?? auto.query,
    document: config.embedding.documentPrefix ?? auto.document,
  };
}

/** null when provider is 'none' — every call-site must handle that cleanly. */
export function resolveProvider(config: LoreConfig, fetchImpl: typeof fetch = fetch): EmbeddingProvider | null {
  const e = config.embedding;
  if (e.provider === 'none') return null;
  const prefixes = prefixesFor(config);
  if (e.provider === 'ollama') {
    return withPrefixes(
      ollamaProvider(e.url, e.model, fetchImpl, e.timeoutMs, e.maxRetries),
      prefixes,
    );
  }
  if (e.provider === 'openai') {
    const key = process.env[e.apiKeyEnv];
    if (!key) {
      throw new Error(
        `embedding provider 'openai' configured but env var ${e.apiKeyEnv} is not set`,
      );
    }
    return withPrefixes(
      openaiProvider(e.url, e.model, key, fetchImpl, e.timeoutMs, e.maxRetries),
      prefixes,
    );
  }
  return null;
}

/** Wrap a raw provider so every call carries its task prefix. */
function withPrefixes(
  inner: EmbeddingProvider,
  prefixes: { query: string; document: string },
): EmbeddingProvider {
  if (!prefixes.query && !prefixes.document) return inner;
  return {
    name: inner.name,
    model: inner.model,
    embed: (texts, role = 'document') => {
      const p = role === 'query' ? prefixes.query : prefixes.document;
      return inner.embed(p ? texts.map((t) => p + t) : texts, role);
    },
  };
}

/**
 * A request that can hang forever is worse than one that fails: the caller
 * gets no output, no error, and no way to tell "slow" from "dead". Node's
 * fetch has no default timeout, so we always supply one.
 */
async function withTimeout(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
  what: string,
): Promise<Response> {
  try {
    return await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    const name = (err as { name?: string } | undefined)?.name;
    if (name === 'TimeoutError' || name === 'AbortError') {
      throw new Error(
        `${what} timed out after ${timeoutMs}ms. The server accepted the connection but never ` +
          `replied — if it is alive and merely slow, raise embedding.timeoutMs.`,
      );
    }
    throw err;
  }
}

/**
 * Statuses worth trying again. A 4xx means the request itself is wrong and
 * will be just as wrong next time; these five mean "not now".
 */
const TRANSIENT_STATUS = new Set([408, 429, 500, 502, 503, 504]);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Timeout plus bounded retry with exponential backoff.
 *
 * Indexing a large vault is a long chain of requests where any one of them can
 * hit a momentary stall, and dying on the first one throws away all the work
 * before it. Retries cover the transient faults — timeouts, dropped sockets,
 * 503s — and deliberately do not cover 4xx, where trying again just fails
 * slower. The final attempt's response is returned even when it is a transient
 * status, so the caller still reports the server's own error text rather than
 * one invented here.
 */
async function withRetry(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
  what: string,
  maxRetries: number,
): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const last = attempt >= maxRetries;
    try {
      const res = await withTimeout(fetchImpl, url, init, timeoutMs, what);
      if (last || !TRANSIENT_STATUS.has(res.status)) return res;
      // Drain the body we are discarding so the socket is released.
      await res.text().catch(() => undefined);
    } catch (err) {
      if (last) throw err;
    }
    await sleep(1000 * 2 ** attempt);
  }
}

function ollamaProvider(
  url: string,
  model: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
  maxRetries: number,
): EmbeddingProvider {
  return {
    name: 'ollama',
    model,
    async embed(texts) {
      const res = await withRetry(
        fetchImpl,
        `${url.replace(/\/$/, '')}/api/embed`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model, input: texts }),
        },
        timeoutMs,
        'ollama embed',
        maxRetries,
      );
      if (!res.ok) throw new Error(`ollama embed failed: ${res.status} ${await res.text()}`);
      const json = (await res.json()) as { embeddings: number[][] };
      if (!Array.isArray(json.embeddings) || json.embeddings.length !== texts.length) {
        throw new Error('ollama embed: unexpected response shape');
      }
      return json.embeddings.map((v) => Float32Array.from(v));
    },
  };
}

function openaiProvider(
  baseUrl: string,
  model: string,
  apiKey: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
  maxRetries: number,
): EmbeddingProvider {
  const base = baseUrl.includes('11434') ? 'https://api.openai.com/v1' : baseUrl.replace(/\/$/, '');
  return {
    name: 'openai',
    model,
    async embed(texts) {
      const res = await withRetry(
        fetchImpl,
        `${base}/embeddings`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({ model, input: texts }),
        },
        timeoutMs,
        'openai embed',
        maxRetries,
      );
      if (!res.ok) throw new Error(`openai embed failed: ${res.status} ${await res.text()}`);
      const json = (await res.json()) as { data: { index: number; embedding: number[] }[] };
      if (!Array.isArray(json.data) || json.data.length !== texts.length) {
        throw new Error('openai embed: unexpected response shape');
      }
      const sorted = [...json.data].sort((a, b) => a.index - b.index);
      return sorted.map((d) => Float32Array.from(d.embedding));
    },
  };
}

export function cosine(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function toBlob(v: Float32Array): Buffer {
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
}

function fromBlob(b: Buffer): Float32Array {
  // A Float32Array view requires a 4-byte-aligned offset. SQLite blobs are
  // currently returned at offset 0, but pooled/sliced Buffers need not be —
  // copy in that case rather than throwing at retrieval time.
  if (b.byteOffset % 4 !== 0 || b.byteLength % 4 !== 0) {
    const copy = Buffer.from(b);
    const usable = copy.byteLength - (copy.byteLength % 4);
    return new Float32Array(copy.buffer.slice(copy.byteOffset, copy.byteOffset + usable));
  }
  return new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4);
}

/** Embed blocks that have no embedding or whose content hash changed. */
export async function embedMissingBlocks(
  store: Store,
  provider: EmbeddingProvider,
  batchSize = 32,
): Promise<number> {
  const candidates = store.db
    .prepare(
      `SELECT b.id, b.heading, b.text, b.hash FROM blocks b
       LEFT JOIN embeddings e ON e.block_id = b.id
       WHERE e.block_id IS NULL OR e.hash != b.hash OR e.provider != ?`,
    )
    .all(`${provider.name}:${provider.model}`) as {
    id: number;
    heading: string;
    text: string;
    hash: string;
  }[];
  // Heading echoes are excluded, not merely down-weighted. Identical text
  // yields an identical vector under ANY model, so two notes that happen to
  // share a section name got a cosine of exactly 1.0 — a maximum-strength
  // SIMILAR edge between unrelated notes, feeding graph expansion. They also
  // cost real embedding calls for text nobody wrote. The lexical index
  // already carries their headings, which is all they were ever for.
  const rows = candidates.filter((r) => !isHeadingEcho(r.heading, r.text));
  if (rows.length === 0) return 0;
  const ins = store.db.prepare(
    `INSERT INTO embeddings(block_id, provider, dims, vec, hash) VALUES (?,?,?,?,?)
     ON CONFLICT(block_id) DO UPDATE SET provider=excluded.provider, dims=excluded.dims,
       vec=excluded.vec, hash=excluded.hash`,
  );
  let done = 0;
  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize);
    const vecs = await provider.embed(batch.map((r) => r.text.slice(0, 8000)));
    const tx = store.db.transaction(() => {
      for (let j = 0; j < batch.length; j++) {
        const v = vecs[j];
        if (!v) continue;
        ins.run(batch[j]!.id, `${provider.name}:${provider.model}`, v.length, toBlob(v), batch[j]!.hash);
      }
    });
    tx();
    done += batch.length;
  }
  return done;
}

export interface DenseHit {
  blockId: number;
  score: number;
}

/** Brute-force cosine top-k over stored vectors (fine at personal scale). */
export function denseTopK(store: Store, qvec: Float32Array, k: number): DenseHit[] {
  const rows = store.db
    .prepare(
      `SELECT e.block_id, e.vec FROM embeddings e
       JOIN blocks b ON b.id = e.block_id WHERE b.archived = 0`,
    )
    .all() as { block_id: number; vec: Buffer }[];
  const hits: DenseHit[] = [];
  for (const r of rows) {
    const score = cosine(qvec, fromBlob(r.vec));
    hits.push({ blockId: r.block_id, score });
  }
  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, k);
}

/**
 * (Re)build SIMILAR edges: for each block, connect its top-k cosine
 * neighbors above the threshold. O(n²) full pass — run from dream/index,
 * not the query path.
 */
export function buildSimilarEdges(
  store: Store,
  {
    threshold = 0.8,
    topK = 5,
    maxBlocks = 20000,
  }: { threshold?: number; topK?: number; maxBlocks?: number } = {},
): number {
  const rows = store.db.prepare(`SELECT block_id, vec FROM embeddings`).all() as {
    block_id: number;
    vec: Buffer;
  }[];
  if (rows.length > maxBlocks) {
    throw new Error(
      `refusing all-pairs similarity over ${rows.length} blocks (limit ${maxBlocks}); ` +
        `it is O(n^2) and would take hours. Raise graph.similarMaxBlocks only if you mean it.`,
    );
  }
  // Pre-normalize once so the inner loop is a plain dot product rather than
  // three accumulations per pair.
  const vecs = rows.map((r) => {
    const v = fromBlob(r.vec);
    let n = 0;
    for (let i = 0; i < v.length; i++) n += v[i]! * v[i]!;
    n = Math.sqrt(n) || 1;
    const unit = new Float32Array(v.length);
    for (let i = 0; i < v.length; i++) unit[i] = v[i]! / n;
    return { id: r.block_id, v: unit };
  });
  const del = store.db.prepare(`DELETE FROM edges WHERE type='SIMILAR'`);
  const ins = store.db.prepare(
    `INSERT OR REPLACE INTO edges(src_type, src_id, dst_type, dst_id, type, weight)
     VALUES ('block', ?, 'block', ?, 'SIMILAR', ?)`,
  );
  let count = 0;
  const tx = store.db.transaction(() => {
    del.run();
    for (let i = 0; i < vecs.length; i++) {
      const sims: { j: number; s: number }[] = [];
      const vi = vecs[i]!.v;
      for (let j = i + 1; j < vecs.length; j++) {
        const vj = vecs[j]!.v;
        let dot = 0;
        for (let d = 0; d < vi.length; d++) dot += vi[d]! * vj[d]!;
        if (dot >= threshold) sims.push({ j, s: dot });
      }
      sims.sort((a, b) => b.s - a.s);
      for (const { j, s } of sims.slice(0, topK)) {
        const a = vecs[i]!.id;
        const b = vecs[j]!.id;
        if (a < b) {
          ins.run(a, b, s);
          count++;
        }
      }
    }
  });
  tx();
  return count;
}
