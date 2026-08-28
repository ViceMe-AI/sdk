import { afterEach, describe, expect, it, vi } from 'vitest';

import { createViceMe } from '../../src/index.ts';
import { ViceMeError } from '../../src/core/errors.ts';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ViceMeClient', () => {
  it('initializes locally without reaching the network', async () => {
    const fetchMock = vi.fn(() => {
      throw new Error('unexpected network request');
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = createViceMe({ workKey: 'wrk_test', region: 'cn' });
    expect(client.state).toBe('CREATED');

    const first = client.ready();
    const second = client.ready();
    expect(first).toBe(second);
    await first;

    expect(client.state).toBe('READY');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('exposes only lifecycle, version, work identity, region, and hosted capabilities', () => {
    const client = createViceMe({ workKey: 'wrk_test', region: 'global' });

    expect(typeof client.version).toBe('string');
    expect(client.workKey).toBe('wrk_test');
    expect(client.region).toBe('global');
    expect(client.hasCapability('danmaku')).toBe(true);
    expect(client.hasCapability('tip')).toBe(true);
    expect(client.hasCapability('checkout')).toBe(false);
    for (const removed of ['auth', 'access', 'checkout', 'follow', 'session']) {
      expect(client).not.toHaveProperty(removed);
    }
    expect(Object.getOwnPropertyNames(Object.getPrototypeOf(client)).sort()).toEqual([
      'constructor',
      'destroy',
      'hasCapability',
      'ready',
      'region',
      'state',
      'version',
      'workKey',
    ]);
  });

  it('destroys idempotently and fails closed afterwards', async () => {
    const client = createViceMe({ workKey: 'wrk_test', region: 'cn' });
    await client.ready();

    client.destroy();
    client.destroy();

    expect(client.state).toBe('DESTROYED');
    expect(client.hasCapability('danmaku')).toBe(false);
    await expect(client.ready()).rejects.toSatisfy(
      (error: unknown) => error instanceof ViceMeError && error.code === 'CLIENT_DESTROYED',
    );
  });
});
