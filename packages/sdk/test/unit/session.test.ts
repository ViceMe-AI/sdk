import { describe, expect, it } from 'vitest';
import { SessionManager } from '../../src/session/session.ts';
import { createMemoryTransport, FIXTURE_WORK } from '../../src/testing.ts';
import type { ViceMeError } from '../../src/core/errors.ts';

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
        return { status: 200, body: { work: { key: 'wrk_test' } } };
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
          body: { work: { key: 'wrk_other', capabilities: ['fixture'] } },
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
});
