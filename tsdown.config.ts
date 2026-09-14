import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['lib/types/index.js', 'lib/types/tool.js', 'lib/types/preview.js'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  // tsc emits declarations and temporary JS under lib/types first. Clean only
  // prior top-level bundles/chunks so stale hashed chunks cannot enter a pack.
  clean: ['lib/*.js'],
})
