import { describe, expect, it } from 'vitest';
import { createTestViceMe, createMemoryTransport, FIXTURE_WORK } from '../../src/testing.ts';

describe('createMemoryTransport', () => {
  it('serves the work-session fixture', async () => {
    const transport = createMemoryTransport({ work: FIXTURE_WORK });
    const res = await transport.request({
      method: 'POST',
      path: '/v1/public/v1/work-sessions',
      body: { workKey: 'wrk_test' },
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      work: { key: 'wrk_test', capabilities: ['fixture'] },
      token: 'test-session-token',
    });
    expect(transport.requests).toHaveLength(1);
  });

  it('records every request for assertions', async () => {
    const transport = createMemoryTransport({ work: FIXTURE_WORK });
    await transport.request({ method: 'POST', path: '/v1/public/v1/work-sessions' });
    await transport.request({ method: 'POST', path: '/v1/public/v1/work-sessions' });
    expect(transport.requests).toHaveLength(2);
  });

  it('honors queued session failures then recovers', async () => {
    const transport = createMemoryTransport({
      work: FIXTURE_WORK,
      sessionFailures: [{ status: 429, code: 'RATE_LIMITED', message: 'slow' }],
    });
    const first = await transport.request({
      method: 'POST',
      path: '/v1/public/v1/work-sessions',
    });
    expect(first.status).toBe(429);
    const res = await transport.request({ method: 'POST', path: '/v1/public/v1/work-sessions' });
    expect(res.status).toBe(201);
  });

  it('returns 404 for unknown fixture paths', async () => {
    const transport = createMemoryTransport({ work: FIXTURE_WORK });
    const res = await transport.request({ method: 'GET', path: '/v1/public/v1/nope' });
    expect(res.status).toBe(404);
  });
});

describe('createTestViceMe', () => {
  it('initializes, exposes capabilities, and destroys', async () => {
    const transport = createMemoryTransport({ work: FIXTURE_WORK });
    const client = createTestViceMe({
      workKey: 'wrk_test',
      region: 'cn',
      transport,
    });
    expect(client.state).toBe('CREATED');
    expect(client.hasCapability('fixture')).toBe(false);

    await client.ready();
    expect(client.state).toBe('READY');
    expect(client.hasCapability('fixture')).toBe(true);
    expect((client as { capabilities?: readonly string[] }).capabilities).toEqual(['fixture']);

    client.destroy();
    expect(client.state).toBe('DESTROYED');
    expect(client.hasCapability('fixture')).toBe(false);
  });

  it('validates workKey and region like production', () => {
    const transport = createMemoryTransport({ work: FIXTURE_WORK });
    expect(() => createTestViceMe({ workKey: 'bad', region: 'cn', transport })).toThrow();
    expect(() =>
      createTestViceMe({ workKey: 'wrk_test', region: 'eu' as never, transport }),
    ).toThrow();
    expect(() =>
      createTestViceMe({ workKey: 'wrk_test', region: 'cn', transport: {} as never }),
    ).toThrow();
  });
});
