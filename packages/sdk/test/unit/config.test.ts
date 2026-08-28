import { describe, expect, it } from 'vitest';

import { validatePublicConfig } from '../../src/core/config.ts';
import { ViceMeError } from '../../src/core/errors.ts';

describe('validatePublicConfig', () => {
  it('accepts exactly workKey and region', () => {
    expect(validatePublicConfig({ workKey: 'wrk_public_xxx', region: 'cn' })).toEqual({
      workKey: 'wrk_public_xxx',
      region: 'cn',
    });
  });

  it('rejects non-object input', () => {
    expect(() => validatePublicConfig('nope')).toThrow(ViceMeError);
    expect(() => validatePublicConfig(null)).toThrow(ViceMeError);
  });

  it.each(['apiBaseUrl', 'signal', 'transport', 'token', 'presenter'])(
    'rejects removed or internal field %s',
    (field) => {
      expect(() =>
        validatePublicConfig({ workKey: 'wrk_test', region: 'cn', [field]: 'nope' }),
      ).toThrow(`Unknown configuration field "${field}"`);
    },
  );

  it('rejects malformed work keys', () => {
    expect(() => validatePublicConfig({ workKey: 'WRK_test', region: 'cn' })).toThrow();
    expect(() => validatePublicConfig({ workKey: 'wrk_', region: 'cn' })).toThrow();
    expect(() => validatePublicConfig({ region: 'cn' })).toThrow();
  });

  it('rejects invalid regions', () => {
    expect(() => validatePublicConfig({ workKey: 'wrk_test', region: 'eu' })).toThrow();
    expect(() => validatePublicConfig({ workKey: 'wrk_test' })).toThrow();
  });
});
