import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'happy-dom',
    include: ['test/unit/**/*.test.ts', 'test/compat/**/*.test.ts', 'test/scripts/**/*.test.ts'],
    reporters: 'default',
    coverage: {
      reporter: ['text', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/testing.ts'],
    },
  },
});
