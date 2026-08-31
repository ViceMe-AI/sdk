import { describe, expect, it } from 'vitest';
import { SessionManager } from '../../src/session/session.ts';
import { createMemoryTransport, FIXTURE_WORK } from '../../src/testing.ts';
import { ViceMeError } from '../../src/core/errors.ts';

describe('SessionManager', () => {
  it('establishes once and caches the snapshot', async () => {
    const transport = createMemoryTransport({ work: FIXTURE_WORK });
    const session = new SessionManager({ workKey: 'wrk_test', transport });

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
        return { status: 200, body: { workKey: 'wrk_test' } };
      },
    };
    const session = new SessionManager({ workKey: 'wrk_test', transport: bad });
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
          body: { workKey: 'wrk_other', capabilities: ['fixture'] },
        };
      },
    };
    const session = new SessionManager({ workKey: 'wrk_test', transport: mismatched });
    await expect(session.establish()).rejects.toSatisfy(
      (e: unknown) => (e as ViceMeError).code === 'WORK_NOT_FOUND',
    );
  });

  it('invalidate drops the token so the next establish re-authenticates', async () => {
    const transport = createMemoryTransport({ work: FIXTURE_WORK });
    const session = new SessionManager({ workKey: 'wrk_test', transport });
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
    const session = new SessionManager({ workKey: 'wrk_test', transport, now: () => clock });

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
    const session = new SessionManager({ workKey: 'wrk_test', transport, now: () => clock });

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
    const session = new SessionManager({ workKey: 'wrk_test', transport, now: () => clock });

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
              workKey: 'wrk_test',
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
    const session = new SessionManager({ workKey: 'wrk_test', transport });

    await expect(
      session.request({ method: 'POST', path: '/v1/public/work-sdk/access/check' }),
    ).resolves.toMatchObject({ status: 201 });
    expect(sessionCount).toBe(2);
    expect(authorizations).toEqual(['stale-token', 'fresh-token']);
  });
});
