// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { parseApiMajor } from '../../../../scripts/lib/version-source.mjs';

describe('version-source', () => {
  it('reads only the exact exported API_MAJOR declaration', () => {
    const source = [
      'export const PREVIOUS_API_MAJOR = 1;',
      '// export const API_MAJOR = 99;',
      'export const API_MAJOR: number = 2 as const;',
    ].join('\n');

    expect(parseApiMajor(source)).toBe(2);
  });

  it('fails closed when API_MAJOR is missing or ambiguous', () => {
    expect(() => parseApiMajor('export const PREVIOUS_API_MAJOR = 1;')).toThrow(
      'exactly one exported decimal API_MAJOR; found 0',
    );
    expect(() => parseApiMajor('export const API_MAJOR = 1;\nexport const API_MAJOR = 2;')).toThrow(
      'exactly one exported decimal API_MAJOR; found 2',
    );
  });
});
