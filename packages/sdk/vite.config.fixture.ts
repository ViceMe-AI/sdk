import { resolve } from 'node:path';
import { defineConfig } from 'vite';

/**
 * Test-only fixture capability chunk (B0.1): validates loader, on-demand
 * loading, mount, events, and destroy in browser tests without shipping a
 * fake production capability. Output is excluded from npm exports, the
 * tarball, and CDN release.
 */
export default defineConfig({
  build: {
    outDir: 'test-fixtures-dist',
    emptyOutDir: true,
    sourcemap: true,
    minify: false,
    lib: {
      entry: resolve(__dirname, 'test/fixtures/capability/index.ts'),
      formats: ['es'],
      fileName: () => 'fixture.js',
    },
  },
});
