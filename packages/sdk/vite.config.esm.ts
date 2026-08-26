import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import { buildEndpointDefinitions } from './vite.config.endpoints.ts';

/**
 * ESM library build: public, testing, and danmaku entries plus shared chunks.
 * Same source and version as the loader build; only `clean` may delete `dist`.
 */
export default defineConfig({
  define: buildEndpointDefinitions(),
  build: {
    outDir: 'dist',
    emptyOutDir: false,
    sourcemap: true,
    minify: 'esbuild',
    lib: {
      entry: {
        index: resolve(__dirname, 'src/index.ts'),
        testing: resolve(__dirname, 'src/testing.ts'),
        danmaku: resolve(__dirname, 'src/danmaku/index.ts'),
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
