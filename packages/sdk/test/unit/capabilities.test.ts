import { describe, expect, it, vi } from 'vitest';
import { createTestViceMe } from '../../src/testing.ts';
import type {
  Transport,
  TransportRequest,
  TransportResponse,
} from '../../src/transport/transport.ts';

function capabilityTransport(alreadyOwned = true): Transport & { requests: TransportRequest[] } {
  const requests: TransportRequest[] = [];
  let following = false;
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
        following = true;
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
                allowed: following,
                reason: following ? 'FOLLOWING' : 'FOLLOW_REQUIRED',
                nextAction: following ? null : 'FOLLOW',
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
  it('uses the in-memory work token for access calls', async () => {
    const transport = capabilityTransport();
    const client = createTestViceMe({ workKey: 'wrk_test', region: 'cn', transport });

    await expect(client.access.checkMany(['dingdong', 'emperor'])).resolves.toEqual({
      dingdong: { allowed: false, reason: 'FOLLOW_REQUIRED', nextAction: 'FOLLOW' },
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

  it('does not perform a required action when the interaction layer is dismissed', async () => {
    const transport = capabilityTransport(false);
    const presenter = vi.fn(async () => 'dismissed' as const);
    const client = createTestViceMe({
      workKey: 'wrk_test',
      region: 'cn',
      transport,
      presenter,
    });

    await expect(client.access.require('emperor')).resolves.toEqual({
      allowed: false,
      reason: 'PURCHASE_REQUIRED',
      nextAction: 'CHECKOUT',
    });
    expect(presenter).toHaveBeenCalledOnce();
    expect(
      transport.requests.some((request) => request.path === '/public/v1/checkout/sessions'),
    ).toBe(false);
  });

  it('follows only after the user activates the follow action in the presenter', async () => {
    const transport = capabilityTransport();
    const presenter = vi.fn(async (interaction: { perform(): Promise<void> }) => {
      expect(transport.requests.some((request) => request.method === 'PUT')).toBe(false);
      await interaction.perform();
      return 'acted' as const;
    });
    const client = createTestViceMe({
      workKey: 'wrk_test',
      region: 'cn',
      transport,
      presenter,
    });

    await expect(client.access.require('dingdong')).resolves.toEqual({
      allowed: true,
      reason: 'FOLLOWING',
      nextAction: null,
    });
    expect(presenter).toHaveBeenCalledOnce();
    expect(transport.requests.filter((request) => request.method === 'PUT')).toHaveLength(1);
  });
});
