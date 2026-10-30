import { defineConfig } from 'tsdown';

// Replaces the retired tsup: bundles the public entries to CJS + ESM with
// declarations, keeping the file names the package exports map and the
// post-build scripts (fix-declarations, write-entrypoints) expect.
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
