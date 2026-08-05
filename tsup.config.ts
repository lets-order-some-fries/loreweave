import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/cli/main.ts', 'src/mcp/server.ts'],
  format: ['esm'],
  target: 'node20',
  splitting: false,
  sourcemap: true,
  clean: true,
  dts: { entry: 'src/index.ts' },
});
