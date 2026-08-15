import { describe, expect, it } from 'vitest';
import {
  ViceMeError,
  configInvalid,
  clientDestroyed,
  isViceMeError,
} from '../../src/core/errors.ts';

describe('ViceMeError', () => {
  it('has stable code and derived retryable default', () => {
    const err = new ViceMeError({ code: 'RATE_LIMITED', message: 'slow down' });
    expect(err.code).toBe('RATE_LIMITED');
    expect(err.retryable).toBe(true);
    expect(err.name).toBe('ViceMeError');
  });

  it('honors explicit retryable override', () => {
    const err = new ViceMeError({
      code: 'INTERNAL_ERROR',
      message: 'boom',
      retryable: false,
    });
    expect(err.retryable).toBe(false);
  });

  it('toJSON exposes only safe diagnostic fields', () => {
    const err = new ViceMeError({
      code: 'NETWORK_TIMEOUT',
      message: 'secret stack: ...',
      requestId: 'req-1',
      capability: 'danmaku',
    });
    const json = err.toJSON();
    expect(json).toEqual({
      code: 'NETWORK_TIMEOUT',
      retryable: true,
      requestId: 'req-1',
      capability: 'danmaku',
    });
    expect(JSON.stringify(json)).not.toContain('secret stack');
  });

  it('toJSON omits undefined optional fields', () => {
    expect(configInvalid('bad').toJSON()).toEqual({ code: 'CONFIG_INVALID', retryable: false });
  });

  it('isViceMeError narrows', () => {
    expect(isViceMeError(configInvalid('x'))).toBe(true);
    expect(isViceMeError(new Error('x'))).toBe(false);
    expect(isViceMeError(null)).toBe(false);
  });

  it('clientDestroyed is non-retryable', () => {
    const err = clientDestroyed();
    expect(err.code).toBe('CLIENT_DESTROYED');
    expect(err.retryable).toBe(false);
  });
});
