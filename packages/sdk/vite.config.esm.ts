import { resolve } from 'node:path';
import { defineConfig } from 'vite';

/**
 * ESM library build: `dist/index.js` + `dist/testing.js` (+ capability chunks
 * in later phases). Same source and version as the loader build; only `clean`
 * may delete `dist`.
 */
export default defineConfig({
  build: {
    outDir: 'dist',
    emptyOutDir: false,
    sourcemap: true,
    minify: 'esbuild',
    lib: {
      entry: {
        index: resolve(__dirname, 'src/index.ts'),
        testing: resolve(__dirname, 'src/testing.ts'),
      },
      formats: ['es'],
    },
    rollupOptions: {
      output: {
        entryFileNames: '[name].js',
        chunkFileNames: 'chunks/[name]-[hash].js',
      },
    },
  },
});
