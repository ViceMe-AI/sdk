// @vitest-environment happy-dom

import { describe, expect, it, vi } from 'vitest';
import { createTestViceMe } from '../../src/testing.ts';
import type { AccessPresenter } from '../../src/core/presentation.ts';
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
      if (request.path === '/v1/public/work-sdk/sessions') {
        return {
          status: 201,
          body: {
            workKey: 'wrk_test',
            capabilities: ['access', 'follow', 'checkout'],
            token: 'anonymous-work-token',
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
          },
        };
      }
      if (request.path === '/v1/public/work-sdk/follow') {
        if (request.method === 'PUT') following = true;
        return {
          status: 200,
          body: {
            following,
            followedAt: following ? '2026-08-15T10:00:00.000Z' : null,
            creator: {
              id: '11111111-1111-4111-8111-111111111111',
              displayName: '归藏',
              avatarUrl: 'https://cdn.example.com/creator.jpg',
              description: 'AI 创作者',
              publishedWorkCount: 2,
            },
          },
        };
      }
      if (request.path === '/v1/public/work-sdk/access/check') {
        const keys = (request.body as { featureKeys: string[] }).featureKeys;
        return {
          status: 200,
          body: {
            decisions: Object.fromEntries(
              keys.map((key) => [
                key,
                key === 'followed'
                  ? !request.userAuthorization
                    ? {
                        allowed: false,
                        reason: 'AUTH_REQUIRED',
                        nextAction: 'SIGN_IN',
                      }
                    : {
                        allowed: following,
                        reason: following ? 'FOLLOWING' : 'FOLLOW_REQUIRED',
                        nextAction: following ? null : 'FOLLOW',
                      }
                  : { allowed: false, reason: 'PURCHASE_REQUIRED', nextAction: 'CHECKOUT' },
              ]),
            ),
          },
        };
      }
      if (request.path === '/v1/public/work-sdk/access/features') {
        return {
          status: 200,
          body: {
            features: [
              { featureKey: 'preview', title: '公开预览', policyType: 'PUBLIC', price: null },
              {
                featureKey: 'paid',
                title: '付费功能',
                policyType: 'WORK_ENTITLEMENT',
                price: { amountCents: 1_000, currency: 'CNY' },
              },
            ],
          },
        };
      }
      if (request.path === '/v1/public/work-sdk/checkout') {
        return {
          status: 200,
          body: {
            checkoutUrl: 'https://viceme.cn/hosted-checkout/session-id',
            alreadyOwned,
          },
        };
      }
      throw new Error(`unexpected request: ${request.method} ${request.path}`);
    },
  };
}

describe('website access capabilities', () => {
  it('reads server-authoritative policy and price presentation', async () => {
    const client = createTestViceMe({
      workKey: 'wrk_test',
      region: 'cn',
      transport: capabilityTransport(),
    });
    await expect(client.access.getFeatures()).resolves.toEqual([
      { featureKey: 'preview', title: '公开预览', policy: { type: 'PUBLIC' }, price: null },
      {
        featureKey: 'paid',
        title: '付费功能',
        policy: { type: 'WORK_ENTITLEMENT' },
        price: { amountCents: 1_000, currency: 'CNY' },
      },
    ]);
  });

  it('keeps the anonymous Work token separate from user authorization', async () => {
    const transport = capabilityTransport();
    const client = createTestViceMe({ workKey: 'wrk_test', region: 'cn', transport });
    await client.access.check('followed');
    expect(transport.requests.at(-1)).toMatchObject({ authorization: 'anonymous-work-token' });
    expect(transport.requests.at(-1)?.userAuthorization).toBeUndefined();
  });

  it('asks for explicit follow consent before following', async () => {
    const actions: string[] = [];
    const presenter: AccessPresenter = async (interaction) => {
      actions.push(interaction.action);
      const action = await interaction.perform();
      if (interaction.action === 'SIGN_IN') {
        if (action.type !== 'frame') throw new Error('expected sign-in frame');
        const url = new URL(action.url);
        window.dispatchEvent(
          new MessageEvent('message', {
            origin: 'https://viceme.cn',
            data: {
              type: 'viceme:auth:complete',
              workKey: 'wrk_test',
              channel: url.searchParams.get('channel'),
              userToken: 'work-bound-user-token',
              user: {
                id: '22222222-2222-4222-8222-222222222222',
                displayName: 'Visitor',
                avatarUrl: null,
              },
            },
          }),
        );
        await action.completion;
      }
      return 'acted';
    };
    const transport = capabilityTransport();
    const client = createTestViceMe({ workKey: 'wrk_test', region: 'cn', transport, presenter });
    await expect(client.access.require('followed')).resolves.toMatchObject({
      allowed: true,
      reason: 'FOLLOWING',
    });
    expect(actions).toEqual(['SIGN_IN', 'FOLLOW']);
  });

  it('uses only the server-bound hosted checkout URL', async () => {
    const presenter: AccessPresenter = async (interaction) => {
      await interaction.perform();
      return 'acted';
    };
    const client = createTestViceMe({
      workKey: 'wrk_test',
      region: 'cn',
      transport: capabilityTransport(true),
      presenter,
    });
    await expect(client.checkout.open({ featureKey: 'paid' })).resolves.toEqual({
      checkoutUrl: 'https://viceme.cn/hosted-checkout/session-id',
      alreadyOwned: true,
    });
  });

  it('opens unpaid hosted checkout in a separate window instead of an iframe', async () => {
    const checkoutWindow = { closed: false, close: vi.fn() };
    const open = vi.spyOn(window, 'open').mockReturnValue(checkoutWindow as unknown as Window);
    const presenter: AccessPresenter = async (interaction) => {
      const action = await interaction.perform();
      expect(action.type).toBe('external');
      if (action.type !== 'external') throw new Error('expected external checkout');
      action.cancel();
      await action.completion;
      return 'acted';
    };
    const client = createTestViceMe({
      workKey: 'wrk_test',
      region: 'cn',
      transport: capabilityTransport(false),
      presenter,
    });

    await expect(client.checkout.open({ featureKey: 'paid' })).resolves.toMatchObject({
      alreadyOwned: false,
    });
    expect(open).toHaveBeenCalledWith(
      'https://viceme.cn/hosted-checkout/session-id',
      '_blank',
      'popup,width=520,height=760',
    );
    expect(checkoutWindow.close).toHaveBeenCalledOnce();
  });

  it('accepts the platform-origin login completion for this Work and channel', async () => {
    const presenter: AccessPresenter = async (interaction) => {
      const action = await interaction.perform();
      if (action.type !== 'frame') throw new Error('expected frame');
      const url = new URL(action.url);
      expect(url.hash).toBe('');
      const frame = { postMessage: vi.fn() };
      window.dispatchEvent(
        new MessageEvent('message', {
          origin: 'https://viceme.cn',
          source: frame as unknown as WindowProxy,
          data: {
            type: 'viceme:auth:ready',
            workKey: 'wrk_test',
            channel: url.searchParams.get('channel'),
          },
        }),
      );
      expect(frame.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'viceme:auth:init',
          workKey: 'wrk_test',
          workSessionToken: 'anonymous-work-token',
        }),
        'https://viceme.cn',
      );
      window.dispatchEvent(
        new MessageEvent('message', {
          origin: 'https://viceme.cn',
          data: {
            type: 'viceme:auth:complete',
            workKey: 'wrk_test',
            channel: url.searchParams.get('channel'),
            userToken: 'work-bound-user-token',
            user: {
              id: '22222222-2222-4222-8222-222222222222',
              displayName: 'Visitor',
              avatarUrl: null,
            },
          },
        }),
      );
      await action.completion;
      return 'acted';
    };
    const client = createTestViceMe({
      workKey: 'wrk_test',
      region: 'cn',
      transport: capabilityTransport(),
      presenter,
    });
    await expect(client.auth.signIn()).resolves.toMatchObject({
      authenticated: true,
      user: { nickname: 'Visitor' },
    });
  });
});
