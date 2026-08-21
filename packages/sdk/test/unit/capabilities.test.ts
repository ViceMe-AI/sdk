// @vitest-environment happy-dom

import { describe, expect, it, vi } from 'vitest';
import { createTestViceMe } from '../../src/testing.ts';
import type { AccessInteraction } from '../../src/core/presentation.ts';
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
      if (request.path === '/v1/public/v1/work-sessions') {
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
      if (request.path === '/v1/public/v1/follow' && request.method === 'PUT') {
        following = true;
        return {
          status: 200,
          body: {
            following: true,
            followedAt: '2026-08-15T10:00:00.000Z',
            target: {
              kind: 'CREATOR',
              displayName: '归藏',
              avatarUrl: 'https://cdn.example.com/creator.jpg',
              description: 'AI 创业者',
            },
          },
        };
      }
      if (request.path === '/v1/public/v1/follow' && request.method === 'GET') {
        return {
          status: 200,
          body: {
            following,
            followedAt: null,
            target: {
              kind: 'CREATOR',
              displayName: '归藏',
              avatarUrl: 'https://cdn.example.com/creator.jpg',
              description: 'AI 创业者',
            },
          },
        };
      }
      if (request.path === '/v1/public/v1/access/check') {
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
      if (request.path === '/v1/public/v1/checkout/sessions') {
        return {
          status: 200,
          body: {
            checkoutUrl: 'https://shop.example.com/zh-CN/checkout?skill=dagou-tap',
            alreadyOwned,
            completionOrigin: 'https://callback.test',
          },
        };
      }
      if (request.path === '/v1/public/v1/auth/wechat/authorize') {
        return {
          status: 200,
          body: {
            authorizationUrl: 'https://open.weixin.qq.com/connect/qrconnect',
            completionOrigin: 'https://callback.test',
          },
        };
      }
      if (request.path === '/v1/public/v1/auth/exchange') {
        return {
          status: 200,
          body: {
            token: 'authenticated-work-token',
            expiresAt: Date.now() + 60_000,
            user: {
              subject: 'authenticated-user-subject',
              nickname: 'Visitor',
              avatarUrl: null,
            },
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
    const presenter = vi.fn(async (interaction: { perform(): Promise<{ type: string }> }) => {
      await interaction.perform();
      return 'acted' as const;
    });
    const client = createTestViceMe({
      workKey: 'wrk_test',
      region: 'cn',
      transport,
      presenter,
    });

    await expect(client.checkout.open({ featureKey: 'emperor', locale: 'zh-CN' })).resolves.toEqual(
      {
        checkoutUrl: 'https://shop.example.com/zh-CN/checkout?skill=dagou-tap',
        alreadyOwned: true,
      },
    );
    expect(transport.requests.at(-1)?.body).toEqual(
      expect.objectContaining({ featureKey: 'emperor', locale: 'zh-CN' }),
    );
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
      transport.requests.some((request) => request.path === '/v1/public/v1/checkout/sessions'),
    ).toBe(false);
  });

  it('follows only after the user activates the follow action in the presenter', async () => {
    const transport = capabilityTransport();
    const presenter = vi.fn(async (interaction: { perform(): Promise<{ type: string }> }) => {
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
    expect(presenter).toHaveBeenCalledWith(
      expect.objectContaining({
        followTarget: expect.objectContaining({
          kind: 'CREATOR',
          displayName: '归藏',
        }),
      }),
    );
    expect(transport.requests.filter((request) => request.method === 'PUT')).toHaveLength(1);
  });

  it('asks for follow consent in the signed-in layer after login', async () => {
    const transport = capabilityTransport();
    let authenticated = false;
    const originalRequest = transport.request.bind(transport);
    transport.request = async (request) => {
      if (request.path === '/v1/public/v1/access/check') {
        return {
          status: 200,
          body: {
            decisions: {
              dingdong: authenticated
                ? {
                    allowed: transport.requests.some(
                      (candidate) =>
                        candidate.path === '/v1/public/v1/follow' && candidate.method === 'PUT',
                    ),
                    reason: transport.requests.some(
                      (candidate) =>
                        candidate.path === '/v1/public/v1/follow' && candidate.method === 'PUT',
                    )
                      ? 'FOLLOWING'
                      : 'FOLLOW_REQUIRED',
                    nextAction: transport.requests.some(
                      (candidate) =>
                        candidate.path === '/v1/public/v1/follow' && candidate.method === 'PUT',
                    )
                      ? null
                      : 'FOLLOW',
                  }
                : { allowed: false, reason: 'AUTH_REQUIRED', nextAction: 'SIGN_IN' },
            },
          },
        };
      }
      const response = await originalRequest(request);
      if (request.path === '/v1/public/v1/auth/exchange') authenticated = true;
      return response;
    };
    const presenter = vi.fn(async (interaction: AccessInteraction) => {
      const result = await interaction.perform();
      if (interaction.action === 'SIGN_IN') {
        if (result.type !== 'frame') throw new Error('expected auth frame');
        const authorize = transport.requests.find(
          (request) => request.path === '/v1/public/v1/auth/wechat/authorize',
        );
        window.dispatchEvent(
          new MessageEvent('message', {
            origin: 'https://callback.test',
            data: {
              type: 'viceme:auth:complete',
              workKey: 'wrk_test',
              channel: (authorize?.body as { channel?: string }).channel,
              code: 'a'.repeat(32),
              codeVerifier: 'b'.repeat(43),
            },
          }),
        );
        await result.completion;
      } else {
        expect(interaction).toMatchObject({
          action: 'FOLLOW',
          user: { nickname: 'Visitor' },
          followTarget: { displayName: '归藏' },
        });
      }
      return 'acted' as const;
    });
    const client = createTestViceMe({ workKey: 'wrk_test', region: 'cn', transport, presenter });

    await expect(client.access.require('dingdong')).resolves.toMatchObject({
      allowed: true,
      reason: 'FOLLOWING',
    });
    expect(presenter).toHaveBeenCalledTimes(2);
    expect(transport.requests.filter((request) => request.method === 'PUT')).toHaveLength(1);
  });

  it('returns checkout as an embedded frame instead of navigating the page', async () => {
    const transport = capabilityTransport(false);
    const presenter = vi.fn(
      async (interaction: {
        perform(): Promise<{ type: string; url?: string; cancel?: () => void }>;
      }) => {
        const result = await interaction.perform();
        expect(result).toMatchObject({
          type: 'frame',
          url: 'https://shop.example.com/zh-CN/checkout?skill=dagou-tap',
        });
        result.cancel?.();
        return 'dismissed' as const;
      },
    );
    const client = createTestViceMe({
      workKey: 'wrk_test',
      region: 'cn',
      transport,
      presenter,
    });
    const before = window.location.href;

    await client.access.require('emperor');

    expect(window.location.href).toBe(before);
    expect(
      transport.requests.some((request) => request.path === '/v1/public/v1/auth/resume-codes'),
    ).toBe(false);
  });

  it('completes embedded login from the callback origin returned by the API', async () => {
    const transport = capabilityTransport();
    const presenter = vi.fn(
      async (interaction: {
        perform(): Promise<{
          type: string;
          completion?: Promise<void>;
        }>;
      }) => {
        const result = await interaction.perform();
        const authorize = transport.requests.find(
          (request) => request.path === '/v1/public/v1/auth/wechat/authorize',
        );
        const channel = (authorize?.body as { channel?: string }).channel;
        window.dispatchEvent(
          new MessageEvent('message', {
            origin: 'https://callback.test',
            data: {
              type: 'viceme:auth:complete',
              workKey: 'wrk_test',
              channel,
              code: 'a'.repeat(32),
              codeVerifier: 'b'.repeat(43),
            },
          }),
        );
        await result.completion;
        return 'acted' as const;
      },
    );
    const client = createTestViceMe({
      workKey: 'wrk_test',
      region: 'cn',
      transport,
      presenter,
    });

    await expect(client.auth.signIn()).resolves.toMatchObject({
      authenticated: true,
      user: { nickname: 'Visitor' },
    });
  });

  it('keeps the QR flow clickable when Chrome reports mobile emulation', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(navigator, 'userAgentData');
    Object.defineProperty(navigator, 'userAgentData', {
      configurable: true,
      value: { mobile: true },
    });
    const transport = capabilityTransport();
    const presenter = vi.fn(async (interaction: AccessInteraction) => {
      const result = await interaction.perform();
      if (result.type !== 'frame') throw new Error('expected auth frame');
      result.cancel();
      return 'dismissed' as const;
    });
    const client = createTestViceMe({
      workKey: 'wrk_test',
      region: 'cn',
      transport,
      presenter,
    });

    try {
      await expect(client.auth.signIn()).rejects.toMatchObject({ code: 'AUTH_CANCELLED' });
      const authorize = transport.requests.find(
        (request) => request.path === '/v1/public/v1/auth/wechat/authorize',
      );
      expect(authorize?.body).toMatchObject({ clientType: 'pc' });
    } finally {
      if (descriptor) Object.defineProperty(navigator, 'userAgentData', descriptor);
      else Reflect.deleteProperty(navigator, 'userAgentData');
    }
  });

  it('temporarily keeps the QR authorization flow inside WeChat', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(navigator, 'userAgent');
    Object.defineProperty(navigator, 'userAgent', {
      configurable: true,
      value: 'Mozilla/5.0 MicroMessenger/8.0.50',
    });
    const transport = capabilityTransport();
    const presenter = vi.fn(async (interaction: AccessInteraction) => {
      const result = await interaction.perform();
      if (result.type !== 'frame') throw new Error('expected auth frame');
      result.cancel();
      return 'dismissed' as const;
    });
    const client = createTestViceMe({ workKey: 'wrk_test', region: 'cn', transport, presenter });

    try {
      await expect(client.auth.signIn()).rejects.toMatchObject({ code: 'AUTH_CANCELLED' });
      const authorize = transport.requests.find(
        (request) => request.path === '/v1/public/v1/auth/wechat/authorize',
      );
      expect(authorize?.body).toMatchObject({ clientType: 'pc' });
    } finally {
      if (descriptor) Object.defineProperty(navigator, 'userAgent', descriptor);
    }
  });

  it('does not require PKCE Web Crypto from the embedding origin', async () => {
    const originalCrypto = globalThis.crypto;
    vi.stubGlobal('crypto', {
      getRandomValues: originalCrypto.getRandomValues.bind(originalCrypto),
    });
    const transport = capabilityTransport();
    const presenter = vi.fn(async (interaction: AccessInteraction) => {
      const result = await interaction.perform();
      if (result.type !== 'frame') throw new Error('expected auth frame');
      result.cancel();
      return 'dismissed' as const;
    });
    const client = createTestViceMe({
      workKey: 'wrk_test',
      region: 'cn',
      transport,
      presenter,
    });

    try {
      await expect(client.auth.signIn()).rejects.toMatchObject({ code: 'AUTH_CANCELLED' });
      const authorize = transport.requests.find(
        (request) => request.path === '/v1/public/v1/auth/wechat/authorize',
      );
      expect(authorize?.body).toMatchObject({ locale: 'zh-CN' });
      expect(authorize?.body).not.toHaveProperty('codeChallenge');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('ignores a completion message from the SDK request origin when the callback differs', async () => {
    const transport = capabilityTransport();
    const presenter = vi.fn(async (interaction: AccessInteraction) => {
      const result = await interaction.perform();
      if (result.type !== 'frame') throw new Error('expected auth frame');
      const authorize = transport.requests.find(
        (request) => request.path === '/v1/public/v1/auth/wechat/authorize',
      );
      const channel = (authorize?.body as { channel?: string }).channel;
      window.dispatchEvent(
        new MessageEvent('message', {
          origin: 'https://api.test',
          data: {
            type: 'viceme:auth:complete',
            workKey: 'wrk_test',
            channel,
            code: 'a'.repeat(32),
          },
        }),
      );
      await Promise.resolve();
      expect(
        transport.requests.some((request) => request.path === '/v1/public/v1/auth/exchange'),
      ).toBe(false);
      result.cancel?.();
      return 'dismissed' as const;
    });
    const client = createTestViceMe({
      workKey: 'wrk_test',
      region: 'cn',
      transport,
      presenter,
    });

    await expect(client.auth.signIn()).rejects.toMatchObject({ code: 'AUTH_CANCELLED' });
  });
});
