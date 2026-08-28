import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import { buildEndpointDefinitions } from './vite.config.endpoints.ts';

/**
 * ESM library build: core, hosted capability entries, and shared chunks.
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
        danmaku: resolve(__dirname, 'src/danmaku/index.ts'),
        tip: resolve(__dirname, 'src/tip/index.ts'),
        'tip/testing': resolve(__dirname, 'src/tip/testing.ts'),
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
