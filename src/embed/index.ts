import { isHeadingEcho } from '../vault/parse.js';
import type { Store } from '../store/db.js';
import type { LoreConfig } from '../config.js';

export interface EmbeddingProvider {
  name: string;
  model: string;
  embed(texts: string[]): Promise<Float32Array[]>;
}

/** null when provider is 'none' — every call-site must handle that cleanly. */
export function resolveProvider(config: LoreConfig, fetchImpl: typeof fetch = fetch): EmbeddingProvider | null {
  const e = config.embedding;
  if (e.provider === 'none') return null;
  if (e.provider === 'ollama') return ollamaProvider(e.url, e.model, fetchImpl);
  if (e.provider === 'openai') {
    const key = process.env[e.apiKeyEnv];
    if (!key) {
      throw new Error(
        `embedding provider 'openai' configured but env var ${e.apiKeyEnv} is not set`,
      );
    }
    return openaiProvider(e.url, e.model, key, fetchImpl);
  }
  return null;
}

function ollamaProvider(url: string, model: string, fetchImpl: typeof fetch): EmbeddingProvider {
  return {
    name: 'ollama',
    model,
    async embed(texts) {
      const res = await fetchImpl(`${url.replace(/\/$/, '')}/api/embed`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model, input: texts }),
      });
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
): EmbeddingProvider {
  const base = baseUrl.includes('11434') ? 'https://api.openai.com/v1' : baseUrl.replace(/\/$/, '');
  return {
    name: 'openai',
    model,
    async embed(texts) {
      const res = await fetchImpl(`${base}/embeddings`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ model, input: texts }),
      });
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
