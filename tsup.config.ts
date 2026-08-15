import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/cli/main.ts', 'src/mcp/server.ts'],
  format: ['esm'],
  target: 'node20',
  splitting: false,
  sourcemap: true,
  clean: true,
  // Optional peer dependencies must never be bundled. Inlining
  // @huggingface/transformers broke its native onnxruntime binding
  // ("listSupportedBackends is not a function") — it worked from source and
  // failed from dist, which is the worst shape a bug can have: invisible in
  // development, guaranteed for every user of the published package.
  external: ['@huggingface/transformers', 'better-sqlite3'],
  dts: { entry: 'src/index.ts' },
});
