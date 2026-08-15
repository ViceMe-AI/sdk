// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

const NODE_SCRIPT_GLOBALS = {
  console: 'readonly',
  process: 'readonly',
  URL: 'readonly',
  URLSearchParams: 'readonly',
  fetch: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
  AbortSignal: 'readonly',
  AbortController: 'readonly',
  crypto: 'readonly',
  globalThis: 'readonly',
  Buffer: 'readonly',
};

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/coverage/**',
      '**/test-results/**',
      '**/playwright-report/**',
      '**/.next/**',
      '**/test-fixtures-dist/**',
      'examples/nextjs/**',
      'packages/sdk/src/generated/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts', '**/*.tsx'],
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      'no-console': ['error', { allow: ['warn', 'error'] }],
    },
  },
  {
    files: [
      'scripts/**/*.mjs',
      'packages/sdk/test/**/*.mjs',
      '*.config.js',
      '*.config.ts',
      '**/vite.config.*.ts',
    ],
    languageOptions: {
      globals: NODE_SCRIPT_GLOBALS,
    },
    rules: {
      'no-console': 'off',
    },
  },
  {
    files: ['**/*.test.ts', '**/*.spec.ts'],
    rules: {
      'no-console': 'off',
    },
  },
);
