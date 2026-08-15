import { resolve } from 'node:path';
import { defineConfig } from 'vite';

/**
 * Fixed alias bootstrap build: tiny IIFE `dist/bootstrap.min.js`.
 * Published as /viceme-sdk/v1/viceme.min.js; byte-stable across releases
 * within the API major (see src/loader/bootstrap.ts).
 */
export default defineConfig({
  build: {
    outDir: 'dist',
    emptyOutDir: false,
    sourcemap: true,
    minify: 'esbuild',
    lib: {
      entry: resolve(__dirname, 'src/loader/bootstrap.ts'),
      name: 'ViceMeBootstrap',
      formats: ['iife'],
      fileName: () => 'bootstrap.min.js',
    },
    rollupOptions: {
      treeshake: false,
      output: {
        exports: 'none',
      },
    },
  },
});
