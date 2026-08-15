import { resolve } from 'node:path';
import { defineConfig } from 'vite';

/**
 * CDN auto-loader build: small IIFE `dist/loader/viceme.min.js`.
 * Capability code must never be inlined here — features load at runtime via
 * the release manifest.
 */
export default defineConfig({
  build: {
    outDir: 'dist/loader',
    emptyOutDir: false,
    sourcemap: true,
    minify: 'esbuild',
    lib: {
      entry: resolve(__dirname, 'src/loader/main.ts'),
      // Required by Vite for IIFE; unused at runtime because the entry has
      // no exports (`exports: 'none'` below) — no global binding is created.
      name: 'ViceMeLoader',
      formats: ['iife'],
      fileName: () => 'viceme.min.js',
    },
    rollupOptions: {
      // The loader is a self-contained side-effect bootstrap (no exports);
      // disable treeshaking so the bootstrap call always survives the
      // package-level `sideEffects: false` hint.
      treeshake: false,
      output: {
        // No exports: the IIFE must not create a global binding.
        exports: 'none',
      },
    },
  },
});
