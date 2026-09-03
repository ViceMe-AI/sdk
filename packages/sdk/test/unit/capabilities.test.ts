// @vitest-environment happy-dom

import { describe, expect, it, vi } from 'vitest';
import { createTestViceMe } from '../../src/testing.ts';
import type { AccessFrameAction, AccessPresenter } from '../../src/core/presentation.ts';
import type {
  Transport,
  TransportRequest,
  TransportResponse,
} from '../../src/transport/transport.ts';

function capabilityTransport(
  alreadyOwned = true,
  unlocksAfterCheckout = false,
  checkoutUrl = 'https://viceme.cn/sdk/checkout/session-id',
  checkoutTtlMs = 60_000,
): Transport & { requests: TransportRequest[] } {
  const requests: TransportRequest[] = [];
  let following = false;
  let checkoutCreated = false;
  return {
    requests,
    async request(request: TransportRequest): Promise<TransportResponse> {
      requests.push(request);
      if (request.path === '/v1/public/work-sdk/sessions') {
        return {
          status: 201,
          body: {
            workKey: 'wrk_test_demo',
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
                  : unlocksAfterCheckout && checkoutCreated
                    ? { allowed: true, reason: 'ENTITLED', nextAction: null }
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
        checkoutCreated = true;
        return {
          status: 200,
          body: {
            checkoutUrl,
            alreadyOwned,
            expiresAt: alreadyOwned ? null : new Date(Date.now() + checkoutTtlMs).toISOString(),
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
      workKey: 'wrk_test_demo',
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
    const client = createTestViceMe({ workKey: 'wrk_test_demo', region: 'cn', transport });
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
              workKey: 'wrk_test_demo',
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
    const client = createTestViceMe({
      workKey: 'wrk_test_demo',
      region: 'cn',
      transport,
      presenter,
    });
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
      workKey: 'wrk_test_demo',
      region: 'cn',
      transport: capabilityTransport(true),
      presenter,
    });
    await expect(client.checkout.open({ featureKey: 'paid' })).resolves.toEqual({
      checkoutUrl: 'https://viceme.cn/sdk/checkout/session-id',
      alreadyOwned: true,
      expiresAt: null,
    });
  });

  it('keeps unpaid hosted checkout inside the access layer', async () => {
    const open = vi.spyOn(window, 'open');
    const presenter: AccessPresenter = async (interaction) => {
      const action = await interaction.perform();
      expect(action.type).toBe('frame');
      if (action.type !== 'frame') throw new Error('expected checkout frame');
      expect(action.url).toBe('https://viceme.cn/sdk/checkout/session-id');
      action.cancel();
      await action.completion;
      return 'acted';
    };
    const client = createTestViceMe({
      workKey: 'wrk_test_demo',
      region: 'cn',
      transport: capabilityTransport(false),
      presenter,
    });

    await expect(client.checkout.open({ featureKey: 'paid' })).resolves.toMatchObject({
      alreadyOwned: false,
    });
    expect(open).not.toHaveBeenCalled();
  });

  it('refreshes the original page access after embedded payment completes', async () => {
    vi.useFakeTimers();
    const presenter: AccessPresenter = async (interaction) => {
      const action = await interaction.perform();
      if (action.type !== 'frame') throw new Error('expected checkout frame');
      await vi.advanceTimersByTimeAsync(1_500);
      await action.completion;
      return 'acted';
    };
    const client = createTestViceMe({
      workKey: 'wrk_test_demo',
      region: 'cn',
      transport: capabilityTransport(false, true),
      presenter,
    });

    await expect(client.checkout.open({ featureKey: 'paid' })).resolves.toMatchObject({
      alreadyOwned: false,
    });
    vi.useRealTimers();
  });

  it('rejects a checkout URL outside the configured platform origin', async () => {
    const client = createTestViceMe({
      workKey: 'wrk_test_demo',
      region: 'cn',
      transport: capabilityTransport(false, false, 'https://evil.example/sdk/checkout/session-id'),
    });

    await expect(client.checkout.open({ featureKey: 'paid' })).rejects.toMatchObject({
      code: 'INTERNAL_ERROR',
    });
  });

  it('stops polling when the checkout session expires', async () => {
    vi.useFakeTimers();
    try {
      const presenter: AccessPresenter = async (interaction) => {
        const action = await interaction.perform();
        if (action.type !== 'frame') throw new Error('expected checkout frame');
        const completion = expect(action.completion).rejects.toMatchObject({
          code: 'SESSION_EXPIRED',
        });
        await vi.advanceTimersByTimeAsync(1_000);
        await completion;
        return 'acted';
      };
      const tested = createTestViceMe({
        workKey: 'wrk_test_demo',
        region: 'cn',
        transport: capabilityTransport(false, false, undefined, 1_000),
        presenter,
      });

      await tested.checkout.open({ featureKey: 'paid' });
      tested.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('pauses checkout polling while the host document is hidden', async () => {
    vi.useFakeTimers();
    let visibility: DocumentVisibilityState = 'hidden';
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
    const transport = capabilityTransport(false, true);
    try {
      const presenter: AccessPresenter = async (interaction) => {
        const action = await interaction.perform();
        if (action.type !== 'frame') throw new Error('expected checkout frame');
        await vi.advanceTimersByTimeAsync(5_000);
        expect(
          transport.requests.filter((request) => request.path.endsWith('/access/check')),
        ).toHaveLength(0);
        visibility = 'visible';
        document.dispatchEvent(new Event('visibilitychange'));
        await vi.advanceTimersByTimeAsync(1_500);
        await action.completion;
        return 'acted';
      };
      const client = createTestViceMe({
        workKey: 'wrk_test_demo',
        region: 'cn',
        transport,
        presenter,
      });

      await client.checkout.open({ featureKey: 'paid' });
      client.destroy();
    } finally {
      vi.restoreAllMocks();
      vi.useRealTimers();
    }
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
            workKey: 'wrk_test_demo',
            channel: url.searchParams.get('channel'),
          },
        }),
      );
      expect(frame.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'viceme:auth:init',
          workKey: 'wrk_test_demo',
          workSessionToken: 'anonymous-work-token',
        }),
        'https://viceme.cn',
      );
      window.dispatchEvent(
        new MessageEvent('message', {
          origin: 'https://viceme.cn',
          data: {
            type: 'viceme:auth:complete',
            workKey: 'wrk_test_demo',
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
      workKey: 'wrk_test_demo',
      region: 'cn',
      transport: capabilityTransport(),
      presenter,
    });
    await expect(client.auth.signIn()).resolves.toMatchObject({
      authenticated: true,
      user: { nickname: 'Visitor' },
    });
  });

  it('does not restore user authorization from a login completed after sign-out', async () => {
    let loginFrame!: AccessFrameAction;
    const presenter: AccessPresenter = async (interaction) => {
      const action = await interaction.perform();
      if (action.type !== 'frame') throw new Error('expected sign-in frame');
      loginFrame = action;
      await action.completion;
      return 'acted';
    };
    const transport = capabilityTransport();
    const client = createTestViceMe({
      workKey: 'wrk_test_demo',
      region: 'cn',
      transport,
      presenter,
    });
    const login = client.auth.signIn();
    // Attach before delivering the late completion so rejection stays handled.
    const result = login.then(
      (state) => state,
      (error: unknown) => error,
    );
    try {
      await vi.waitFor(() => expect(loginFrame).toBeDefined());
      await client.auth.signOut();
      // The transport deliberately reissues the same token string: ownership
      // belongs to the session instance, not equality of credential bytes.
      window.dispatchEvent(
        new MessageEvent('message', {
          origin: 'https://viceme.cn',
          data: {
            type: 'viceme:auth:complete',
            workKey: 'wrk_test_demo',
            channel: new URL(loginFrame.url).searchParams.get('channel'),
            userToken: 'stale-user-token',
            user: { id: 'old-user', displayName: 'Old visitor', avatarUrl: null },
          },
        }),
      );

      expect(await result).toMatchObject({ code: 'SESSION_EXPIRED', retryable: true });
      await expect(client.auth.getState()).resolves.toEqual({ authenticated: false, user: null });
      await expect(client.access.check('followed')).resolves.toMatchObject({
        allowed: false,
        reason: 'AUTH_REQUIRED',
      });
      expect(transport.requests.at(-1)?.userAuthorization).toBeUndefined();
    } finally {
      loginFrame?.cancel();
      client.destroy();
    }
  });

  it('destroy closes an active sign-in surface and rejects the caller as destroyed', async () => {
    const iframeSrc = vi
      .spyOn(HTMLIFrameElement.prototype, 'src', 'set')
      .mockImplementation(function (this: HTMLIFrameElement, value: string) {
        this.dataset.testSrc = value;
      });
    const client = createTestViceMe({
      workKey: 'wrk_test_demo',
      region: 'cn',
      transport: capabilityTransport(),
    });
    try {
      const pending = client.auth.signIn();
      const rejection = expect(pending).rejects.toMatchObject({
        code: 'CLIENT_DESTROYED',
        retryable: false,
      });

      await vi.waitFor(() => {
        expect(document.querySelector('viceme-access-layer')).not.toBeNull();
      });
      const layer = document.querySelector('viceme-access-layer')!;
      (layer.shadowRoot?.querySelector("[data-viceme='action']") as HTMLButtonElement).click();
      await vi.waitFor(() => {
        expect(layer.shadowRoot?.querySelector('iframe')?.getAttribute('data-test-src')).toContain(
          '/sdk/login',
        );
      });

      client.destroy();

      await rejection;
      await vi.waitFor(() => {
        expect(document.querySelector('viceme-access-layer')).toBeNull();
      });
    } finally {
      iframeSrc.mockRestore();
      client.destroy();
    }
  });

  it('maps an immediate destroy/presentation race to CLIENT_DESTROYED', async () => {
    const client = createTestViceMe({
      workKey: 'wrk_test_demo',
      region: 'cn',
      transport: capabilityTransport(),
    });

    const pending = client.auth.signIn();
    client.destroy();

    await expect(pending).rejects.toMatchObject({
      code: 'CLIENT_DESTROYED',
      retryable: false,
    });
    expect(document.querySelector('viceme-access-layer')).toBeNull();
  });
});
