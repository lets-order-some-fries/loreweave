import type { LoreConfig } from '../config.js';

/**
 * Optional cross-encoder reranking.
 *
 * Every external benchmark says the same thing about this engine: the right
 * answer reaches the candidate pool and does not reach the top of it — LoCoMo
 * R@20 0.705 against R@1 0.337, LongMemEval R@10 0.974 against R@1 0.589,
 * BEIR Recall@10 0.869 against nDCG@10 0.729. Retrieval scores each candidate
 * without ever looking at it beside the query; a cross-encoder reads the pair
 * together, which is why the memory systems that lead these benchmarks credit
 * reranking rather than model size.
 *
 * Deliberately quarantined from the core:
 *  - the dependency is OPTIONAL (`npm i @huggingface/transformers`) and
 *    imported lazily, so the default install stays one native dependency and
 *    a missing package degrades to a warning, never a crash;
 *  - it runs only when explicitly configured, so the shipped default remains
 *    model-free and deterministic;
 *  - it reorders an existing list and never adds to it, so it cannot change
 *    what was found — only the order it is presented in.
 */

/**
 * The optional package is not installed at build time for most users, so its
 * real types are unavailable here. Everything crosses through `unknown` on
 * purpose: this module must compile whether or not the dependency exists.
 */
interface TransformersModule {
  AutoTokenizer: { from_pretrained(model: string): Promise<unknown> };
  AutoModelForSequenceClassification: {
    from_pretrained(model: string, opts?: unknown): Promise<unknown>;
  };
}
type Tokenize = (texts: string[], opts: unknown) => unknown;
type RunModel = (inputs: unknown) => Promise<{ logits?: { data: ArrayLike<number> } }>;

export interface Reranker {
  model: string;
  /** Returns a relevance score per passage, higher is better. */
  score(query: string, passages: string[]): Promise<number[]>;
}

let cached: { model: string; ranker: Reranker } | null = null;
let warned = false;

/**
 * Resolve a reranker, or null when one is not configured or not installable.
 * Never throws: reranking is an enhancement, and losing it must not lose the
 * search that would otherwise have been returned.
 */
export async function resolveReranker(config: LoreConfig): Promise<Reranker | null> {
  const cfg = config.rerank;
  if (!cfg || cfg.provider === 'none') return null;
  if (cached && cached.model === cfg.model) return cached.ranker;

  try {
    // Not a static import: the package is optional, and naming it statically
    // would make it a hard requirement of the bundle.
    //
    // The specifier lives in a variable so the *compiler* does not resolve it
    // either. Written inline it type-checks only where the optional package
    // happens to be installed, so CI failed every job for sixteen consecutive
    // runs with TS2307 while the local gate stayed green — a local gate cannot
    // reproduce the absence of something already on the machine.
    const spec = '@huggingface/transformers';
    const mod = (await import(/* @vite-ignore */ spec)) as unknown as TransformersModule;
    // The text-classification PIPELINE is the wrong tool here: it softmaxes
    // over labels, and an ms-marco cross-encoder has exactly one output, so
    // every passage came back scored 1.000. The relevance signal is the raw
    // logit, which means driving tokenizer and model directly.
    const tokenize = (await mod.AutoTokenizer.from_pretrained(cfg.model)) as unknown as Tokenize;
    const run = (await mod.AutoModelForSequenceClassification.from_pretrained(cfg.model, {
      dtype: 'q8',
    })) as unknown as RunModel;

    const ranker: Reranker = {
      model: cfg.model,
      async score(query, passages) {
        if (passages.length === 0) return [];
        const inputs = tokenize(
          passages.map(() => query),
          { text_pair: passages, padding: true, truncation: true },
        );
        const out = await run(inputs);
        const data = out.logits?.data ?? [];
        return passages.map((_, i) => Number(data[i] ?? 0));
      },
    };
    cached = { model: cfg.model, ranker };
    return ranker;
  } catch (err) {
    if (!warned) {
      warned = true;
      console.error(
        `[loreweave] rerank.provider is set but the optional dependency is unavailable ` +
          `(${(err as Error).message}). Install it with: npm i @huggingface/transformers. ` +
          `Continuing without reranking.`,
      );
    }
    return null;
  }
}

/** Reset memoized state — tests only. */
export function _resetRerankerCache(): void {
  cached = null;
  warned = false;
}
