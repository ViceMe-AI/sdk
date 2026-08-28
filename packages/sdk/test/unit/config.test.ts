import { describe, expect, it } from 'vitest';

import { validatePublicConfig } from '../../src/core/config.ts';
import { ViceMeError } from '../../src/core/errors.ts';

describe('validatePublicConfig', () => {
  it.each(['wrk_test_demo', 'wrk_live_demo', 'wrk_public_demo'])(
    'accepts public Work key %s',
    (workKey) => {
      expect(validatePublicConfig({ workKey, region: 'cn' })).toEqual({ workKey, region: 'cn' });
    },
  );

  it('rejects non-object input', () => {
    expect(() => validatePublicConfig('nope')).toThrow(ViceMeError);
    expect(() => validatePublicConfig(null)).toThrow(ViceMeError);
  });

  it.each(['apiBaseUrl', 'signal', 'transport', 'token', 'presenter'])(
    'rejects removed or internal field %s',
    (field) => {
      expect(() =>
        validatePublicConfig({ workKey: 'wrk_test_demo', region: 'cn', [field]: 'nope' }),
      ).toThrow(`Unknown configuration field "${field}"`);
    },
  );

  it('rejects malformed work keys', () => {
    expect(() => validatePublicConfig({ workKey: 'WRK_test', region: 'cn' })).toThrow();
    expect(() => validatePublicConfig({ workKey: 'wrk_', region: 'cn' })).toThrow();
    expect(() => validatePublicConfig({ region: 'cn' })).toThrow();
  });

  it('rejects invalid regions', () => {
    expect(() => validatePublicConfig({ workKey: 'wrk_test_demo', region: 'eu' })).toThrow();
    expect(() => validatePublicConfig({ workKey: 'wrk_test_demo' })).toThrow();
  });
});
