import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/legacy.ts', 'src/modern.ts', 'src/slim.ts', 'src/utils.ts'],
  format: ['cjs', 'esm'],
  outExtension({ format }) { return { js: format === 'esm' ? '.mjs' : '.cjs' }; },
  target: 'node20',
  platform: 'node',
  dts: true,
  sourcemap: true,
  clean: true,
  esbuildOptions(options) {
    // The CommonJS loader uses __dirname, so its import.meta branch is dead.
    options.logOverride = { 'empty-import-meta': 'silent' };
  },
});
