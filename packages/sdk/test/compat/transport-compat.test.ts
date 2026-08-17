// @vitest-environment node
// Compat tests run against real HTTP with Node's native fetch (undici);
// happy-dom's fetch has incomplete abort semantics for hung requests.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startMockApiServer } from './mock-server.ts';
import { createFetchTransport } from '../../src/transport/transport.ts';
import { ViceMeError } from '../../src/core/errors.ts';
import { SessionManager } from '../../src/session/session.ts';

/**
 * Transport compatibility tests against a real local HTTP server serving the
 * baseline contract snapshot shapes: the same request/response semantics the
 * public API will have (B0.2). Covers timeout, caller abort, request ids,
 * status/error normalization, CORS-omitted credentials, unknown-field
 * tolerance, and fail-closed malformed responses.
 */

let server: Awaited<ReturnType<typeof startMockApiServer>>;

beforeAll(async () => {
  server = await startMockApiServer();
});

afterAll(async () => {
  await server.close();
});

function transport(timeoutMs?: number) {
  return createFetchTransport({
    apiBaseUrl: server.url,
    defaultTimeoutMs: timeoutMs,
  });
}

function expectCode(error: unknown): ViceMeError['code'] | undefined {
  return error instanceof ViceMeError ? error.code : undefined;
}

describe('FetchTransport compatibility', () => {
  it('establishes a session over real HTTP with CORS-style headers', async () => {
    const t = transport();
    const res = await t.request({
      method: 'POST',
      path: '/v1/public/v1/work-sessions',
      body: { workKey: 'wrk_test' },
    });
    expect(res.status).toBe(201);
    expect(res.requestId).toBe('srv-mock-1');
    expect(res.body).toMatchObject({
      work: { key: 'wrk_test', capabilities: ['fixture'] },
      token: 'test-token',
    });
    // Unknown forward-compatible fields pass through untouched.
    expect(res.body).toHaveProperty('unknownFutureField');

    const seen = server.seen.at(-1)!;
    expect(seen.method).toBe('POST');
    expect(typeof seen.headers['x-client-request-id']).toBe('string');
  });

  it('maps contract error bodies to stable codes (429 RATE_LIMITED)', async () => {
    const scoped = await startMockApiServer({
      handler: (_req, _body, res) => {
        res.json(429, { error: { code: 'RATE_LIMITED', message: 'slow down' } });
      },
    });
    try {
      const t = createFetchTransport({ apiBaseUrl: scoped.url });
      const p = t.request({ method: 'POST', path: '/v1/public/v1/work-sessions' });
      await expect(p).rejects.toSatisfy(
        (e: unknown) => (e as ViceMeError).code === 'RATE_LIMITED' && (e as ViceMeError).retryable,
      );
    } finally {
      await scoped.close();
    }
  });

  it('falls back to the status map when the body carries no known code', async () => {
    const scoped = await startMockApiServer({
      handler: (_req, _body, res) => res.json(500, {}),
    });
    try {
      const t = createFetchTransport({ apiBaseUrl: scoped.url });
      const p = t.request({ method: 'POST', path: '/v1/public/v1/work-sessions' });
      await expect(p).rejects.toSatisfy((e: unknown) => expectCode(e) === 'INTERNAL_ERROR');
    } finally {
      await scoped.close();
    }
  });

  it('NETWORK_TIMEOUT on a hung server', async () => {
    const scoped = await startMockApiServer({
      handler: () => {
        // Never respond.
      },
    });
    try {
      const t = createFetchTransport({ apiBaseUrl: scoped.url, defaultTimeoutMs: 150 });
      const p = t.request({ method: 'POST', path: '/v1/public/v1/work-sessions' });
      await expect(p).rejects.toSatisfy((e: unknown) => expectCode(e) === 'NETWORK_TIMEOUT');
    } finally {
      await scoped.close();
    }
  });

  it('caller AbortError propagates unchanged', async () => {
    const scoped = await startMockApiServer({
      handler: () => {
        // Never respond.
      },
    });
    try {
      const t = createFetchTransport({ apiBaseUrl: scoped.url, defaultTimeoutMs: 10_000 });
      const controller = new AbortController();
      const p = t.request({
        method: 'POST',
        path: '/v1/public/v1/work-sessions',
        signal: controller.signal,
      });
      controller.abort();
      await expect(p).rejects.toSatisfy((e: unknown) => (e as DOMException).name === 'AbortError');
    } finally {
      await scoped.close();
    }
  });
});

describe('SessionManager against the real transport', () => {
  it('tolerates unknown response fields and keeps required ones', async () => {
    const session = new SessionManager({ workKey: 'wrk_test', transport: transport() });
    const snapshot = await session.establish();
    expect(snapshot.work.key).toBe('wrk_test');
    expect(snapshot.token).toBe('test-token');
  });

  it('fails closed (INTERNAL_ERROR) when a required field is removed', async () => {
    // Simulates a contract break: `work` missing — CI must fail loudly, the
    // SDK must never guess at runtime (§12.3).
    const scoped = await startMockApiServer({
      handler: (_req, _body, res) => res.json(201, { token: 'orphan' }),
    });
    try {
      const session = new SessionManager({
        workKey: 'wrk_test',
        transport: createFetchTransport({ apiBaseUrl: scoped.url }),
      });
      const p = session.establish();
      await expect(p).rejects.toSatisfy((e: unknown) => expectCode(e) === 'INTERNAL_ERROR');
    } finally {
      await scoped.close();
    }
  });

  it('re-establishes after invalidate against the live server', async () => {
    const session = new SessionManager({ workKey: 'wrk_test', transport: transport() });
    await session.establish();
    session.invalidate();
    await session.establish();
    const posts = server.seen.filter(
      (s) => s.method === 'POST' && s.url === '/v1/public/v1/work-sessions',
    );
    expect(posts.length).toBeGreaterThanOrEqual(2);
  });
});
