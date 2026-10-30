import { defineConfig } from 'tsdown';

// Plain JavaScript on purpose: a TypeScript config would make tsdown pull a
// TypeScript runner (unrun) on runtimes without native type stripping.
export default defineConfig({
  entry: ['src/index.ts', 'src/legacy.ts', 'src/modern.ts', 'src/slim.ts', 'src/utils.ts'],
  format: ['cjs', 'esm'],
  outExtensions: ({ format }) => ({ js: format === 'cjs' ? '.cjs' : '.mjs' }),
  dts: true,
  sourcemap: true,
  platform: 'node',
  target: 'node20',
  clean: true,
});
