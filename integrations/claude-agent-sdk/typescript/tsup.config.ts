import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
  },
  dts: true,
  format: ['cjs', 'esm'],
  splitting: false,
  sourcemap: true,
  clean: true,
  external: ['@ag-ui/core', '@ag-ui/client', '@anthropic-ai/claude-agent-sdk'],
});

