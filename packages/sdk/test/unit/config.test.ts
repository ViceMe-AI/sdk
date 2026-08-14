import { describe, expect, it } from 'vitest';
import {
  resolveApiBaseUrl,
  validatePublicConfig,
  PUBLIC_API_BASE_URLS,
} from '../../src/core/config.ts';
import { ViceMeError } from '../../src/core/errors.ts';

describe('validatePublicConfig', () => {
  it('accepts the public shape', () => {
    const cfg = validatePublicConfig({ workKey: 'wrk_public_xxx', region: 'cn' });
    expect(cfg).toEqual({ workKey: 'wrk_public_xxx', region: 'cn', signal: undefined });
  });

  it('rejects non-object input', () => {
    expect(() => validatePublicConfig('nope')).toThrow(ViceMeError);
    expect(() => validatePublicConfig(null)).toThrow(ViceMeError);
  });

  it('rejects unknown fields (no apiBaseUrl smuggling)', () => {
    expect(() =>
      validatePublicConfig({ workKey: 'wrk_test', region: 'cn', apiBaseUrl: 'http://evil' }),
    ).toThrow(/Unknown configuration field "apiBaseUrl"/);
  });

  it('rejects malformed work keys', () => {
    expect(() => validatePublicConfig({ workKey: 'WRK_test', region: 'cn' })).toThrow();
    expect(() => validatePublicConfig({ workKey: 'wrk_', region: 'cn' })).toThrow();
    expect(() => validatePublicConfig({ region: 'cn' })).toThrow();
  });

  it('rejects invalid regions', () => {
    expect(() => validatePublicConfig({ workKey: 'wrk_test', region: 'eu' })).toThrow();
    expect(() => validatePublicConfig({ workKey: 'wrk_test' })).toThrow();
  });

  it('rejects non-AbortSignal signal', () => {
    expect(() =>
      validatePublicConfig({ workKey: 'wrk_test', region: 'cn', signal: 'x' }),
    ).toThrow();
  });
});

describe('resolveApiBaseUrl', () => {
  it('returns one documented host per region', () => {
    expect(resolveApiBaseUrl('cn')).toBe(PUBLIC_API_BASE_URLS.cn);
    expect(resolveApiBaseUrl('global')).toBe(PUBLIC_API_BASE_URLS.global);
  });
});
