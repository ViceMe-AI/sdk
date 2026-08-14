import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SDK_VERSION, API_MAJOR } from '../../src/version.ts';

const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(resolve(here, '..', '..', 'package.json'), 'utf8')) as {
  version: string;
};

describe('version', () => {
  it('SDK_VERSION matches package.json', () => {
    expect(SDK_VERSION).toBe(pkg.version);
  });

  it('API_MAJOR is 1 (loader namespace v1)', () => {
    expect(API_MAJOR).toBe(1);
  });
});
