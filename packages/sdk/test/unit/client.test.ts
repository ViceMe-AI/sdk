import { describe, expect, it } from 'vitest';
import { createTestViceMe, createMemoryTransport, FIXTURE_WORK } from '../../src/testing.ts';
import { createFetchTransport } from '../../src/transport/transport.ts';
import { ViceMeError } from '../../src/core/errors.ts';

function makeClient(work = FIXTURE_WORK) {
  const transport = createMemoryTransport({ work });
  const client = createTestViceMe({ workKey: work.key, region: 'cn', transport });
  return { client, transport };
}

describe('ViceMeClient', () => {
  it('ready() is idempotent and shares one promise', async () => {
    const { client, transport } = makeClient();
    const a = client.ready();
    const b = client.ready();
    expect(a).toBe(b);
    await a;
    // Only one public API call despite two ready() invocations.
    expect(transport.requests).toHaveLength(1);
  });

  it('reports version, workKey, region', () => {
    const { client } = makeClient();
    expect(typeof client.version).toBe('string');
    expect(client.workKey).toBe('wrk_test');
    expect(client.region).toBe('cn');
  });

  it('destroys idempotently and fails closed afterwards', async () => {
    const { client } = makeClient();
    await client.ready();
    client.destroy();
    client.destroy();
    expect(client.state).toBe('DESTROYED');
    await expect(client.ready()).rejects.toSatisfy((err: unknown) => {
      return err instanceof ViceMeError && err.code === 'CLIENT_DESTROYED';
    });
  });

  it('rejects ready() when session fails, then allows retry', async () => {
    const { client } = makeClient({
      ...FIXTURE_WORK,
      capabilities: ['fixture'],
      key: 'wrk_test',
    });
    // First transport fails once; retry succeeds via a fresh transport.
    const failing = createMemoryTransport({
      work: FIXTURE_WORK,
      sessionFailures: [new Error('boom')],
    });
    const c = createTestViceMe({ workKey: 'wrk_test', region: 'cn', transport: failing });
    await expect(c.ready()).rejects.toThrow('boom');
    expect(c.state).toBe('FAILED');
    // Retry: the failing transport's queue is drained, so it now succeeds.
    await c.ready();
    expect(c.state).toBe('READY');
    expect(client.state).not.toBe('DESTROYED');
  });

  it('destroy() aborts an in-flight session with CLIENT_DESTROYED', async () => {
    const transport = createMemoryTransport({ work: FIXTURE_WORK, latencyMs: 50 });
    const client = createTestViceMe({ workKey: 'wrk_test', region: 'cn', transport });
    const ready = client.ready();
    client.destroy();
    await expect(ready).rejects.toSatisfy((err: unknown) => {
      return err instanceof ViceMeError && err.code === 'CLIENT_DESTROYED';
    });
  });

  it('a pre-aborted caller signal never issues a session request', async () => {
    const transport = createMemoryTransport({ work: FIXTURE_WORK });
    const controller = new AbortController();
    controller.abort(new DOMException('cancelled before start', 'AbortError'));
    const client = createTestViceMe({
      workKey: 'wrk_test',
      region: 'cn',
      transport,
      signal: controller.signal,
    });

    await expect(client.ready()).rejects.toSatisfy((err: unknown) => {
      return err instanceof DOMException && err.name === 'AbortError';
    });
    expect(transport.requests).toHaveLength(0);
    expect(client.state).toBe('FAILED');
  });

  it('destroy during body read cancels the response and fails closed', async () => {
    // Headers arrive instantly; the body stalls until the transport's abort
    // signal fires (the real fetch cancels the stream the same way).
    const fetchImpl = (_url: string, init: RequestInit) =>
      Promise.resolve({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: () =>
          new Promise<never>((_resolve, reject) => {
            init.signal?.addEventListener('abort', () =>
              reject(new DOMException('aborted', 'AbortError')),
            );
          }),
      });
    const client = createTestViceMe({
      workKey: 'wrk_test',
      region: 'cn',
      transport: createFetchTransport({
        apiBaseUrl: 'https://api.viceme.cn',
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    });

    const ready = client.ready();
    await new Promise((resolve) => setTimeout(resolve, 20)); // headers delivered
    client.destroy();

    await expect(ready).rejects.toSatisfy((err: unknown) => {
      return err instanceof ViceMeError && err.code === 'CLIENT_DESTROYED';
    });
    // No session snapshot can be populated by the late body.
    expect(client.hasCapability('fixture')).toBe(false);
  });
});
