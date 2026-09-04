import { afterEach, describe, expect, it, vi } from 'vitest';

import { createViceMe } from '../../src/index.ts';
import { ViceMeError } from '../../src/core/errors.ts';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('ViceMeClient', () => {
  it('does not cache a Work session cancelled after its body parsed', async () => {
    const controller = new AbortController();
    const reason = new Error('Route disposed');
    const response = new Response(
      JSON.stringify({
        workKey: 'wrk_test_demo',
        token: 'test-session-token',
        capabilities: ['checkout'],
      }),
    );
    const readJson = response.json.bind(response);
    vi.spyOn(response, 'json').mockImplementation(() => {
      const parsed = readJson();
      void parsed.then(() => controller.abort(reason));
      return parsed;
    });
    const fetchMock = vi.fn(async () => response);
    vi.stubGlobal('fetch', fetchMock);
    const client = createViceMe({
      workKey: 'wrk_test_demo',
      region: 'cn',
      signal: controller.signal,
    });

    try {
      await expect(client.auth.getState()).rejects.toBe(reason);
      expect(client.hasCapability('checkout')).toBe(false);
      await expect(client.auth.getState()).rejects.toBe(reason);
      expect(fetchMock).toHaveBeenCalledOnce();
    } finally {
      client.destroy();
    }
  });

  it('initializes locally without reaching the network', async () => {
    const fetchMock = vi.fn(() => {
      throw new Error('unexpected network request');
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = createViceMe({ workKey: 'wrk_test_demo', region: 'cn' });
    expect(client.state).toBe('CREATED');

    const first = client.ready();
    const second = client.ready();
    expect(first).toBe(second);
    await first;

    expect(client.state).toBe('READY');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('adds lazy website access without changing hosted capability support', () => {
    const client = createViceMe({ workKey: 'wrk_test_demo', region: 'global' });

    expect(typeof client.version).toBe('string');
    expect(client.workKey).toBe('wrk_test_demo');
    expect(client.region).toBe('global');
    expect(client.hasCapability('danmaku')).toBe(true);
    expect(client.hasCapability('tip')).toBe(true);
    expect(client.hasCapability('checkout')).toBe(false);
    expect(client.auth).toBeDefined();
    expect(client.access).toBeDefined();
    expect(client.checkout).toBeDefined();
    expect(client).not.toHaveProperty('session');
    expect(Object.getOwnPropertyNames(Object.getPrototypeOf(client)).sort()).toEqual([
      'apiMajor',
      'capabilities',
      'constructor',
      'destroy',
      'hasCapability',
      'markDegraded',
      'ready',
      'region',
      'sessionSnapshot',
      'state',
      'version',
      'workKey',
    ]);
  });

  it('destroys idempotently and fails closed afterwards', async () => {
    const client = createViceMe({ workKey: 'wrk_test_demo', region: 'cn' });
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
