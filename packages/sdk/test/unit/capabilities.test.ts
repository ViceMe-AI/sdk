import { describe, expect, it, vi } from 'vitest';
import { createTestViceMe } from '../../src/testing.ts';
import type {
  Transport,
  TransportRequest,
  TransportResponse,
} from '../../src/transport/transport.ts';

function capabilityTransport(alreadyOwned = true): Transport & { requests: TransportRequest[] } {
  const requests: TransportRequest[] = [];
  return {
    requests,
    async request(request: TransportRequest): Promise<TransportResponse> {
      requests.push(request);
      if (request.path === '/public/v1/work-sessions') {
        return {
          status: 201,
          body: {
            work: {
              key: 'wrk_test',
              capabilities: ['auth', 'follow', 'access', 'checkout'],
            },
            token: 'anonymous-work-token',
            expiresAt: Date.now() + 60_000,
          },
        };
      }
      if (request.path === '/public/v1/follow' && request.method === 'PUT') {
        return {
          status: 200,
          body: { following: true, followedAt: '2026-08-15T10:00:00.000Z' },
        };
      }
      if (request.path === '/public/v1/access/check') {
        return {
          status: 200,
          body: {
            decisions: {
              dingdong: {
                allowed: true,
                reason: 'FOLLOWING',
                nextAction: null,
              },
              emperor: {
                allowed: false,
                reason: 'PURCHASE_REQUIRED',
                nextAction: 'CHECKOUT',
              },
            },
          },
        };
      }
      if (request.path === '/public/v1/checkout/sessions') {
        return {
          status: 200,
          body: {
            checkoutUrl: 'https://shop.example.com/zh-CN/checkout?skill=dagou-tap',
            alreadyOwned,
          },
        };
      }
      throw new Error(`unexpected request: ${request.method} ${request.path}`);
    },
  };
}

describe('creator access capabilities', () => {
  it('uses the in-memory work token for follow and access calls', async () => {
    const transport = capabilityTransport();
    const client = createTestViceMe({ workKey: 'wrk_test', region: 'cn', transport });

    await expect(client.follow.follow()).resolves.toEqual({
      following: true,
      followedAt: '2026-08-15T10:00:00.000Z',
    });
    await expect(client.access.checkMany(['dingdong', 'emperor'])).resolves.toEqual({
      dingdong: { allowed: true, reason: 'FOLLOWING', nextAction: null },
      emperor: {
        allowed: false,
        reason: 'PURCHASE_REQUIRED',
        nextAction: 'CHECKOUT',
      },
    });

    expect(
      transport.requests
        .slice(1)
        .every((request) => request.authorization === 'anonymous-work-token'),
    ).toBe(true);
  });

  it('resolves checkout only from the server-bound work product', async () => {
    const transport = capabilityTransport();
    const client = createTestViceMe({ workKey: 'wrk_test', region: 'cn', transport });

    await expect(client.checkout.open({ locale: 'zh-CN' })).resolves.toEqual({
      checkoutUrl: 'https://shop.example.com/zh-CN/checkout?skill=dagou-tap',
      alreadyOwned: true,
    });
    expect(transport.requests.at(-1)?.body).toEqual({ locale: 'zh-CN' });
  });

  it('reports a blocked checkout popup', async () => {
    const transport = capabilityTransport(false);
    const client = createTestViceMe({ workKey: 'wrk_test', region: 'cn', transport });
    const open = vi.spyOn(window, 'open').mockReturnValue(null);

    await expect(client.checkout.open()).rejects.toMatchObject({
      code: 'CHECKOUT_UNAVAILABLE',
      retryable: false,
    });
    open.mockRestore();
  });
});
