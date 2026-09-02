import { describe, expect, it } from 'vitest';
import { SessionManager } from '../../src/session/session.ts';
import { createMemoryTransport, FIXTURE_WORK } from '../../src/testing.ts';
import { ViceMeError } from '../../src/core/errors.ts';

describe('SessionManager', () => {
  it('establishes once and caches the snapshot', async () => {
    const transport = createMemoryTransport({ work: FIXTURE_WORK });
    const session = new SessionManager({ workKey: 'wrk_test_demo', transport });

    await session.establish();
    await session.establish();
    expect(session.snapshot?.work.capabilities).toEqual(['fixture']);
    expect(transport.requests).toHaveLength(1);
  });

  it('rejects malformed work descriptors', async () => {
    const transport = createMemoryTransport({ work: FIXTURE_WORK });
    // Tamper with the served body by routing through a custom transport.
    const bad = {
      async request() {
        return { status: 200, body: { workKey: 'wrk_test_demo' } };
      },
    };
    const session = new SessionManager({ workKey: 'wrk_test_demo', transport: bad });
    await expect(session.establish()).rejects.toSatisfy(
      (e: unknown) => (e as ViceMeError).code === 'INTERNAL_ERROR',
    );
    void transport;
  });

  it('rejects when response work key differs from requested', async () => {
    const mismatched = {
      async request() {
        return {
          status: 200,
          body: { workKey: 'wrk_test_other', capabilities: ['fixture'] },
        };
      },
    };
    const session = new SessionManager({ workKey: 'wrk_test_demo', transport: mismatched });
    await expect(session.establish()).rejects.toSatisfy(
      (e: unknown) => (e as ViceMeError).code === 'WORK_NOT_FOUND',
    );
  });

  it('invalidate drops the token so the next establish re-authenticates', async () => {
    const transport = createMemoryTransport({ work: FIXTURE_WORK });
    const session = new SessionManager({ workKey: 'wrk_test_demo', transport });
    await session.establish();
    session.invalidate();
    await session.establish();
    expect(transport.requests).toHaveLength(2);
  });

  it('reuses a snapshot that has not expired', async () => {
    let clock = 1_000_000;
    const transport = createMemoryTransport({
      work: { ...FIXTURE_WORK, expiresAt: clock + 10_000 },
    });
    const session = new SessionManager({ workKey: 'wrk_test_demo', transport, now: () => clock });

    await session.establish();
    clock += 5_000;
    await session.establish();
    expect(transport.requests).toHaveLength(1);
  });

  it('refreshes an expired snapshot instead of returning it forever', async () => {
    let clock = 1_000_000;
    const transport = createMemoryTransport({
      work: { ...FIXTURE_WORK, expiresAt: clock + 5_000 },
    });
    const session = new SessionManager({ workKey: 'wrk_test_demo', transport, now: () => clock });

    await session.establish();
    clock += 6_000;
    await session.establish();
    expect(transport.requests).toHaveLength(2);
  });

  it('single-flights a concurrent refresh after expiry', async () => {
    let clock = 1_000_000;
    const transport = createMemoryTransport({
      work: { ...FIXTURE_WORK, expiresAt: clock + 1_000 },
      latencyMs: 30,
    });
    const session = new SessionManager({ workKey: 'wrk_test_demo', transport, now: () => clock });

    await session.establish();
    clock += 2_000;
    const [first, second] = await Promise.all([session.establish(), session.establish()]);
    expect(first).toBe(second);
    // One initial request + exactly one refresh.
    expect(transport.requests).toHaveLength(2);
  });

  it('refreshes the work session once when the server rejects a stale token', async () => {
    let sessionCount = 0;
    const authorizations: Array<string | undefined> = [];
    const transport = {
      async request(request: { path: string; authorization?: string }) {
        if (request.path === '/v1/public/work-sdk/sessions') {
          sessionCount += 1;
          return {
            status: 201,
            body: {
              workKey: 'wrk_test_demo',
              capabilities: ['auth'],
              token: sessionCount === 1 ? 'stale-token' : 'fresh-token',
              expiresAt: new Date(Date.now() + 60_000).toISOString(),
            },
          };
        }
        authorizations.push(request.authorization);
        if (request.authorization === 'stale-token') {
          throw new ViceMeError({
            code: 'SESSION_EXPIRED',
            message: 'The work session is stale.',
          });
        }
        return { status: 201, body: { ok: true } };
      },
    };
    const session = new SessionManager({ workKey: 'wrk_test_demo', transport });

    await expect(
      session.request({ method: 'POST', path: '/v1/public/work-sdk/access/check' }),
    ).resolves.toMatchObject({ status: 201 });
    expect(sessionCount).toBe(2);
    expect(authorizations).toEqual(['stale-token', 'fresh-token']);
  });

  it('never restores a session snapshot from a transport that settles after destroy', async () => {
    let resolveRequest!: (response: {
      status: number;
      body: { workKey: string; capabilities: string[]; token: string };
    }) => void;
    const transport = {
      request() {
        return new Promise<{
          status: number;
          body: { workKey: string; capabilities: string[]; token: string };
        }>((resolve) => {
          resolveRequest = resolve;
        });
      },
    };
    const session = new SessionManager({ workKey: 'wrk_test_demo', transport });
    const pending = session.establish();
    const rejection = expect(pending).rejects.toMatchObject({ code: 'CLIENT_DESTROYED' });

    session.destroy();
    resolveRequest({
      status: 201,
      body: {
        workKey: 'wrk_test_demo',
        capabilities: ['access'],
        token: 'must-not-survive-destroy',
      },
    });

    await rejection;
    expect(session.snapshot).toBeUndefined();
    await expect(session.establish()).rejects.toMatchObject({ code: 'CLIENT_DESTROYED' });
  });

  it('supersedes an invalidated in-flight establishment without stale writeback', async () => {
    const resolvers: Array<
      (response: {
        status: number;
        body: { workKey: string; capabilities: string[]; token: string };
      }) => void
    > = [];
    const transport = {
      request() {
        return new Promise<{
          status: number;
          body: { workKey: string; capabilities: string[]; token: string };
        }>((resolve) => resolvers.push(resolve));
      },
    };
    const session = new SessionManager({ workKey: 'wrk_test_demo', transport });
    const stale = session.establish();
    const staleRejection = expect(stale).rejects.toMatchObject({ code: 'SESSION_EXPIRED' });

    session.invalidate();
    const fresh = session.establish();
    expect(resolvers).toHaveLength(2);
    resolvers[0]!({
      status: 201,
      body: {
        workKey: 'wrk_test_demo',
        capabilities: ['access'],
        token: 'stale-token',
      },
    });
    await staleRejection;
    expect(session.snapshot).toBeUndefined();

    resolvers[1]!({
      status: 201,
      body: {
        workKey: 'wrk_test_demo',
        capabilities: ['access'],
        token: 'fresh-token',
      },
    });
    await expect(fresh).resolves.toMatchObject({ token: 'fresh-token' });
    expect(session.snapshot?.token).toBe('fresh-token');
  });

  it('maps a late capability response to CLIENT_DESTROYED even when transport ignores abort', async () => {
    let resolveCapability!: (response: { status: number; body: { ok: boolean } }) => void;
    const transport = {
      request(request: { path: string }) {
        if (request.path === '/v1/public/work-sdk/sessions') {
          return Promise.resolve({
            status: 201,
            body: {
              workKey: 'wrk_test_demo',
              capabilities: ['access'],
              token: 'work-token',
            },
          });
        }
        return new Promise<{ status: number; body: { ok: boolean } }>((resolve) => {
          resolveCapability = resolve;
        });
      },
    };
    const session = new SessionManager({ workKey: 'wrk_test_demo', transport });
    await session.establish();
    const pending = session.request({ method: 'GET', path: '/v1/public/work-sdk/access/features' });
    const rejection = expect(pending).rejects.toMatchObject({ code: 'CLIENT_DESTROYED' });
    await Promise.resolve();

    session.destroy();
    resolveCapability({ status: 200, body: { ok: true } });

    await rejection;
    expect(session.snapshot).toBeUndefined();
  });

  it('does not replay a successful capability request after a concurrent session refresh', async () => {
    let sessionCount = 0;
    let resolveCapability!: (response: { status: number; body: { ok: boolean } }) => void;
    const authorizations: Array<string | undefined> = [];
    const transport = {
      request(request: { path: string; authorization?: string }) {
        if (request.path === '/v1/public/work-sdk/sessions') {
          sessionCount += 1;
          return Promise.resolve({
            status: 201,
            body: {
              workKey: 'wrk_test_demo',
              capabilities: ['access'],
              token: sessionCount === 1 ? 'original-token' : 'refreshed-token',
            },
          });
        }
        authorizations.push(request.authorization);
        return new Promise<{ status: number; body: { ok: boolean } }>((resolve) => {
          resolveCapability = resolve;
        });
      },
    };
    const session = new SessionManager({ workKey: 'wrk_test_demo', transport });
    await session.establish();
    const pending = session.request({ method: 'PUT', path: '/v1/public/work-sdk/follow' });
    await Promise.resolve();

    session.invalidate();
    await session.establish();
    resolveCapability({ status: 200, body: { ok: true } });

    await expect(pending).resolves.toMatchObject({ status: 200 });
    expect(authorizations).toEqual(['original-token']);
    expect(session.snapshot?.token).toBe('refreshed-token');
  });
});
