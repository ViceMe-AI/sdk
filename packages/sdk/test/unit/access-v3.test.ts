// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { createTestViceMe } from '../../src/testing.ts';
import { SessionManager } from '../../src/session/session.ts';
import { createAccessBridge } from '../../src/core/access-bridge.ts';
import type { AccessPresenter } from '../../src/core/presentation.ts';
import type { Transport, TransportRequest } from '../../src/transport/transport.ts';

const workKey = 'wrk_test_demo';
const capabilities = {
  market: 'CN',
  loginMethods: ['WECHAT'],
  supportedPriceCurrencies: ['CNY', 'USD'],
  checkoutAvailability: 'AVAILABLE',
  anonymousPurchase: true,
};
const expiresAt = () => new Date(Date.now() + 60_000).toISOString();
const user = { id: 'user-1', displayName: 'Visitor', avatarUrl: null };

function fixture(
  overrides: {
    session?: Record<string, unknown>;
    feature?: Record<string, unknown>;
    decision?: Record<string, unknown>;
    bridgeUrl?: string;
    result?: Record<string, unknown>;
    exchange?: Record<string, unknown>;
    exchangeRequest?: () => Promise<Record<string, unknown>>;
  } = {},
) {
  const requests: TransportRequest[] = [];
  let purchased = false;
  let followed = false;
  let purpose = 'IDENTIFY';
  const transport: Transport = {
    async request(request) {
      requests.push(request);
      const input = request.body as Record<string, unknown>;
      let body: unknown;
      if (request.path.endsWith('/sessions')) {
        body = {
          workKey,
          capabilities: ['access', 'follow', 'checkout'],
          token: 'work-token',
          expiresAt: expiresAt(),
          accessProtocolVersion: 3,
          marketCapabilities: capabilities,
          ...overrides.session,
        };
      } else if (request.path.endsWith('/buyer/challenges')) {
        purpose = input.purpose as string;
        body = {
          challengeId: 'challenge-1',
          bridgeUrl: overrides.bridgeUrl ?? 'https://viceme.cn/sdk/buyer/challenge-1',
          expiresAt: expiresAt(),
        };
      } else if (request.path.endsWith('/result')) {
        body = overrides.result ?? { status: 'READY', code: 'one-time-code' };
      } else if (request.path.endsWith('/exchange')) {
        body = overrides.exchangeRequest
          ? await overrides.exchangeRequest()
          : (overrides.exchange ??
            (purpose === 'SIGN_IN' || purpose === 'CLAIM'
              ? { userToken: 'user-token', user, expiresAt: expiresAt() }
              : { buyerToken: 'buyer-token', expiresAt: expiresAt() }));
        body = { purpose, ...(body as Record<string, unknown>) };
      } else if (request.path.endsWith('/access/check')) {
        const decision =
          overrides.decision ??
          (purchased
            ? { allowed: true, reason: 'ENTITLED', nextAction: null }
            : followed
              ? { allowed: true, reason: 'FOLLOWING', nextAction: null }
              : request.buyerAuthorization
                ? { allowed: false, reason: 'PURCHASE_REQUIRED', nextAction: 'CHECKOUT' }
                : { allowed: false, reason: 'BUYER_REQUIRED', nextAction: 'RESOLVE_BUYER' });
        body = {
          decisions: Object.fromEntries(
            (input.featureKeys as string[]).map((key) => [key, decision]),
          ),
        };
      } else if (request.path.endsWith('/access/features')) {
        body = {
          features: [
            overrides.feature
              ? { pricingIntent: null, ...overrides.feature }
              : {
                  featureKey: 'paid',
                  title: 'Paid',
                  policyType: 'WORK_ENTITLEMENT',
                  pricingIntent: null,
                  status: 'ACTIVE',
                  price: { currency: 'USD', amountMinor: 1200 },
                },
          ],
        };
      } else if (request.path.endsWith('/checkout')) {
        purchased = true;
        body = {
          checkoutUrl: 'https://viceme.cn/sdk/checkout/order',
          alreadyOwned: true,
          expiresAt: null,
        };
      } else if (request.path.endsWith('/follow')) {
        if (request.method === 'PUT') followed = true;
        body = {
          following: followed,
          followedAt: followed ? new Date().toISOString() : null,
          creator: {
            displayName: 'Creator',
            avatarUrl: null,
            description: null,
            publishedWorkCount: 1,
          },
        };
      } else throw new Error(`Unexpected path: ${request.path}`);
      return { status: 200, body };
    },
  };
  const actions: string[] = [];
  const presenter: AccessPresenter = async (interaction) => {
    actions.push(interaction.action);
    const action = await interaction.perform();
    if (action.type !== 'completed') await action.completion;
    return 'acted';
  };
  return { requests, transport, presenter, actions };
}

afterEach(() => {
  vi.useRealTimers();
  sessionStorage.clear();
  vi.restoreAllMocks();
});

describe('Website Access v3', () => {
  it('resumes a bounded same-page handshake with the same verifier and no persisted identity', async () => {
    const f = fixture();
    const assign = vi.spyOn(window.location, 'assign').mockImplementation(() => {});
    const firstController = new AbortController();
    const session = new SessionManager({ workKey, transport: f.transport });
    const first = createAccessBridge({
      workKey,
      widgetOrigin: 'https://viceme.cn',
      session,
      signal: firstController.signal,
      now: Date.now,
    });
    const frame = await first.start('RESTORE', 'paid');
    frame.continueInSamePage!();
    expect(assign).toHaveBeenCalledWith('https://viceme.cn/sdk/buyer/challenge-1');
    const saved = JSON.parse(sessionStorage.getItem(sessionStorage.key(0)!)!);
    expect(saved).toMatchObject({ purpose: 'RESTORE', featureKey: 'paid' });
    expect(saved).not.toHaveProperty('buyerToken');
    expect(saved).not.toHaveProperty('userToken');
    const secondController = new AbortController();
    const freshSession = new SessionManager({ workKey, transport: f.transport });
    const second = createAccessBridge({
      workKey,
      widgetOrigin: 'https://viceme.cn',
      session: freshSession,
      signal: secondController.signal,
      now: Date.now,
    });
    const resumed = await second.start('IDENTIFY', 'paid');
    await resumed.completion;
    expect(f.requests.filter((r) => r.path.endsWith('/buyer/challenges'))).toHaveLength(1);
    const challenge = f.requests.find((r) => r.path.endsWith('/buyer/challenges'))!.body as Record<
      string,
      unknown
    >;
    expect(challenge.codeChallenge).toBe(
      createHash('sha256').update(saved.verifier).digest('base64url'),
    );
    expect(f.requests.find((r) => r.path.endsWith('/exchange'))?.body).toMatchObject({
      codeVerifier: saved.verifier,
    });
    expect(freshSession.snapshot?.buyerToken).toBe('buyer-token');
    expect(sessionStorage.length).toBe(0);
    firstController.abort();
    secondController.abort();
    session.destroy();
    freshSession.destroy();
  });

  it('does not deliver an authorization read from before logout', async () => {
    const f = fixture();
    const original = f.transport.request;
    let release!: (value: { status: number; body: unknown }) => void;
    let reads = 0;
    f.transport.request = async (request) => {
      if (request.path.endsWith('/access/check') && reads++ === 0) {
        return new Promise((resolve) => {
          release = resolve;
        });
      }
      return original(request);
    };
    const session = new SessionManager({ workKey, transport: f.transport });
    await session.establish();
    const pending = session.request({
      method: 'POST',
      path: '/v1/public/work-sdk/access/check',
      body: { featureKeys: ['paid'] },
    });
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    await session.signOut();
    release({
      status: 200,
      body: { decisions: { paid: { allowed: true, reason: 'ENTITLED', nextAction: null } } },
    });
    await expect(pending).resolves.toMatchObject({
      body: { decisions: { paid: { allowed: false } } },
    });
    expect(reads).toBe(2);
    session.destroy();
  });

  it('rejects a server selecting the wrong market without a CN fallback', async () => {
    const f = fixture();
    const client = createTestViceMe({ workKey, region: 'global', transport: f.transport });
    await expect(client.access.check('paid')).rejects.toMatchObject({ code: 'INTERNAL_ERROR' });
    expect(f.requests).toHaveLength(1);
    client.destroy();
  });

  it('supports GLOBAL login through the official GLOBAL bridge', async () => {
    const f = fixture({
      bridgeUrl: 'https://viceme.ai/sdk/buyer/global-challenge',
      session: {
        marketCapabilities: {
          ...capabilities,
          market: 'GLOBAL',
          loginMethods: ['EMAIL'],
          checkoutAvailability: 'PENDING_CHANNEL',
        },
      },
    });
    const client = createTestViceMe({
      workKey,
      region: 'global',
      transport: f.transport,
      presenter: f.presenter,
    });
    await expect(client.auth.signIn()).resolves.toMatchObject({ authenticated: true });
    expect(f.requests.some((r) => r.path.endsWith('/checkout'))).toBe(false);
    client.destroy();
  });

  it('does not use null or changed host Origin as a buyer authorization condition', async () => {
    const origin = vi.spyOn(window.location, 'origin', 'get').mockReturnValue('null');
    const f = fixture();
    const client = createTestViceMe({
      workKey,
      region: 'cn',
      transport: f.transport,
      presenter: f.presenter,
    });
    await client.access.restorePurchase('paid');
    origin.mockReturnValue('https://another-host.example');
    await client.access.check('paid');
    expect(f.requests.at(-1)?.buyerAuthorization).toBe('buyer-token');
    expect(f.requests.find((r) => r.path.endsWith('/buyer/challenges'))?.body).not.toHaveProperty(
      'parentOrigin',
    );
    client.destroy();
  });

  it('does not silently sign in from the anonymous identity bridge', async () => {
    const f = fixture({ exchange: { userToken: 'unexpected-user', user } });
    const client = createTestViceMe({
      workKey,
      region: 'cn',
      transport: f.transport,
      presenter: f.presenter,
    });
    await expect(client.access.restorePurchase('paid')).rejects.toMatchObject({
      code: 'INTERNAL_ERROR',
    });
    expect((await client.auth.getState()).authenticated).toBe(false);
    client.destroy();
  });
  it('negotiates only on the first access operation and check has no business side effects', async () => {
    const f = fixture();
    const client = createTestViceMe({ workKey, region: 'cn', transport: f.transport });
    await client.ready();
    expect(f.requests).toHaveLength(0);
    await client.access.check('paid');
    expect(f.requests.map((request) => request.path)).toEqual([
      '/v1/public/work-sdk/sessions',
      '/v1/public/work-sdk/access/check',
    ]);
    expect(f.requests[0]?.body).toEqual({ workKey, supportedAccessProtocolVersions: [3] });
    client.destroy();
  });

  it('identifies an anonymous buyer before checkout and rechecks server ownership', async () => {
    const f = fixture();
    const client = createTestViceMe({
      workKey,
      region: 'cn',
      transport: f.transport,
      presenter: f.presenter,
    });
    await expect(client.access.require('paid')).resolves.toMatchObject({
      allowed: true,
      reason: 'ENTITLED',
    });
    expect(f.actions).toEqual(['RESOLVE_BUYER']);
    const challenge = f.requests.find((request) => request.path.endsWith('/buyer/challenges'))!;
    expect(challenge.body).toMatchObject({
      workSessionToken: 'work-token',
      purpose: 'IDENTIFY',
      featureKey: 'paid',
    });
    expect(challenge.body).not.toHaveProperty('parentOrigin');
    expect((challenge.body as Record<string, unknown>).codeChallenge).toMatch(
      /^[A-Za-z0-9_-]{43}$/,
    );
    const exchange = f.requests.find((request) => request.path.endsWith('/exchange'))!;
    expect(exchange.body).toMatchObject({ workSessionToken: 'work-token', code: 'one-time-code' });
    expect(
      f.requests.find((request) => request.path.endsWith('/checkout'))?.buyerAuthorization,
    ).toBe('buyer-token');
    expect(f.requests.some((request) => request.path.endsWith('/follow'))).toBe(false);
    expect(sessionStorage.length).toBe(0);
    expect((await client.auth.getState()).authenticated).toBe(false);
    client.destroy();
  });

  it('opens login directly and receives user authorization only from the verifier exchange', async () => {
    const f = fixture();
    const cn = createTestViceMe({
      workKey,
      region: 'cn',
      transport: f.transport,
      presenter: f.presenter,
    });
    await expect(cn.auth.signIn()).resolves.toMatchObject({
      authenticated: true,
      user: { subject: 'user-1' },
    });
    expect(f.actions).toEqual(['SIGN_IN']);
    expect(
      f.requests.find((request) => request.path.endsWith('/buyer/challenges'))?.body,
    ).toMatchObject({ purpose: 'SIGN_IN' });
    expect(f.requests.some((request) => request.path.endsWith('/follow'))).toBe(false);
    cn.destroy();
  });

  it('does not present a second follow confirmation in the original require action', async () => {
    const f = fixture();
    const original = f.transport.request;
    f.transport.request = async (request) => {
      const response = await original(request);
      if (
        request.path.endsWith('/access/check') &&
        !f.requests.some((r) => r.path.endsWith('/follow') && r.method === 'PUT')
      ) {
        return {
          status: 200,
          body: {
            decisions: {
              followed: { allowed: false, reason: 'FOLLOW_REQUIRED', nextAction: 'FOLLOW' },
            },
          },
        };
      }
      return response;
    };
    const client = createTestViceMe({
      workKey,
      region: 'cn',
      transport: f.transport,
      presenter: f.presenter,
    });
    await expect(client.access.require('followed')).resolves.toMatchObject({ allowed: true });
    expect(f.actions).toEqual([]);
    expect(f.requests.filter((r) => r.path.endsWith('/follow') && r.method === 'PUT')).toHaveLength(
      1,
    );
    client.destroy();
  });

  it('recovers purchases without logging in and offers explicit account claim', async () => {
    const f = fixture();
    const client = createTestViceMe({
      workKey,
      region: 'cn',
      transport: f.transport,
      presenter: f.presenter,
    });
    await client.access.restorePurchase('paid');
    expect((await client.auth.getState()).authenticated).toBe(false);
    await client.access.claimPurchase('paid');
    expect((await client.auth.getState()).authenticated).toBe(true);
    expect(
      f.requests
        .filter((r) => r.path.endsWith('/buyer/challenges'))
        .map((r) => (r.body as Record<string, unknown>).purpose),
    ).toEqual(['RESTORE', 'CLAIM']);
    expect(f.requests.at(-1)?.buyerAuthorization).toBeUndefined();
    client.destroy();
  });

  it('does not create orders for GLOBAL pending channels', async () => {
    const f = fixture({
      session: { marketCapabilities: { ...capabilities, market: 'GLOBAL' } },
      decision: { allowed: false, reason: 'FEATURE_NOT_READY', nextAction: null },
    });
    const client = createTestViceMe({
      workKey,
      region: 'global',
      transport: f.transport,
      presenter: f.presenter,
    });
    await expect(client.access.require('paid')).resolves.toMatchObject({
      allowed: false,
      nextAction: null,
    });
    await expect(client.checkout.open({ featureKey: 'paid' })).rejects.toMatchObject({
      code: 'CHECKOUT_UNAVAILABLE',
    });
    expect(
      f.requests.some((r) => r.path.endsWith('/checkout') || r.path.endsWith('/buyer/challenges')),
    ).toBe(false);
    client.destroy();
  });

  it.each(['CNY', 'USD'])('parses %s minor-unit prices', async (currency) => {
    const f = fixture({
      feature: {
        featureKey: 'paid',
        title: 'Paid',
        policyType: 'WORK_ENTITLEMENT',
        status: 'ACTIVE',
        price: { currency, amountMinor: 1234 },
      },
    });
    const client = createTestViceMe({ workKey, region: 'cn', transport: f.transport });
    expect((await client.access.getFeatures())[0]?.price).toEqual({ currency, amountMinor: 1234 });
    client.destroy();
  });

  it('accepts pending-channel features without a fake product price', async () => {
    const f = fixture({
      session: { marketCapabilities: { ...capabilities, market: 'GLOBAL' } },
      feature: {
        featureKey: 'paid',
        title: 'Paid',
        policyType: 'WORK_ENTITLEMENT',
        status: 'PENDING_CHANNEL',
        price: null,
        pricingIntent: { currency: 'USD', amountMinor: 1200 },
      },
    });
    const client = createTestViceMe({ workKey, region: 'global', transport: f.transport });
    expect((await client.access.getFeatures())[0]).toMatchObject({
      status: 'PENDING_CHANNEL',
      price: null,
      pricingIntent: { currency: 'USD' },
    });
    client.destroy();
  });

  it.each([0, -1, 1.1, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid amountMinor %s',
    async (amountMinor) => {
      const f = fixture({
        feature: {
          featureKey: 'paid',
          title: 'Paid',
          policyType: 'WORK_ENTITLEMENT',
          status: 'ACTIVE',
          price: { currency: 'USD', amountMinor },
        },
      });
      const client = createTestViceMe({ workKey, region: 'cn', transport: f.transport });
      await expect(client.access.getFeatures()).rejects.toMatchObject({ code: 'INTERNAL_ERROR' });
      client.destroy();
    },
  );

  it('rejects an unexpected negotiated protocol and does not invent capabilities', async () => {
    const f = fixture({ session: { accessProtocolVersion: 4 } });
    const client = createTestViceMe({ workKey, region: 'cn', transport: f.transport });
    await expect(client.access.check('paid')).rejects.toMatchObject({ code: 'INTERNAL_ERROR' });
    expect(f.requests).toHaveLength(1);
    client.destroy();
  });

  it('rejects new actions on an unversioned legacy session', async () => {
    const f = fixture({
      session: { accessProtocolVersion: undefined, marketCapabilities: undefined },
    });
    const client = createTestViceMe({ workKey, region: 'cn', transport: f.transport });
    await expect(client.access.check('paid')).rejects.toMatchObject({ code: 'INTERNAL_ERROR' });
    client.destroy();
  });

  it('stops repeated actions that make no progress', async () => {
    const f = fixture({
      decision: { allowed: false, reason: 'BUYER_REQUIRED', nextAction: 'RESOLVE_BUYER' },
    });
    const client = createTestViceMe({
      workKey,
      region: 'cn',
      transport: f.transport,
      presenter: f.presenter,
    });
    await expect(client.access.require('paid')).resolves.toMatchObject({ allowed: false });
    expect(f.actions).toEqual(['RESOLVE_BUYER']);
    client.destroy();
  });

  it.each([
    'https://attacker.example/bridge',
    'http://viceme.cn/bridge',
    'https://name:secret@viceme.cn/bridge',
  ])('rejects non-official bridge URL %s', async (bridgeUrl) => {
    const f = fixture({ bridgeUrl });
    const client = createTestViceMe({
      workKey,
      region: 'cn',
      transport: f.transport,
      presenter: f.presenter,
    });
    await expect(client.access.require('paid')).rejects.toMatchObject({ code: 'INTERNAL_ERROR' });
    expect(f.requests.some((r) => r.path.endsWith('/exchange'))).toBe(false);
    client.destroy();
  });

  it('does not exchange an identity for a frame dismissed before acceptance', async () => {
    const f = fixture();
    const presenter: AccessPresenter = async (interaction) => {
      const action = await interaction.perform();
      if (action.type !== 'completed') action.cancel();
      return 'dismissed';
    };
    const client = createTestViceMe({ workKey, region: 'cn', transport: f.transport, presenter });
    await expect(client.access.require('paid')).resolves.toMatchObject({ allowed: false });
    expect(f.requests.some((r) => r.path.endsWith('/result') || r.path.endsWith('/exchange'))).toBe(
      false,
    );
    client.destroy();
  });

  it('preserves the caller abort reason and prevents a late exchange from restoring a buyer', async () => {
    let resolve!: (value: Record<string, unknown>) => void;
    const f = fixture({
      exchangeRequest: () =>
        new Promise((r) => {
          resolve = r;
        }),
    });
    const controller = new AbortController();
    const session = new SessionManager({
      workKey,
      transport: f.transport,
      signal: controller.signal,
    });
    const bridge = createAccessBridge({
      workKey,
      widgetOrigin: 'https://viceme.cn',
      session,
      signal: controller.signal,
      now: Date.now,
    });
    const frame = await bridge.start('IDENTIFY', 'paid');
    const pending = frame.completion;
    await vi.waitFor(() => expect(resolve).toBeTypeOf('function'));
    const reason = new Error('Route disposed');
    controller.abort(reason);
    resolve({ buyerToken: 'late-token', expiresAt: expiresAt() });
    await expect(pending).rejects.toBe(reason);
    expect(session.snapshot?.buyerToken).toBeUndefined();
    session.destroy();
  });

  it('rejects an expired challenge without exchanging or purchasing', async () => {
    const f = fixture({ result: { status: 'EXPIRED' } });
    const client = createTestViceMe({
      workKey,
      region: 'cn',
      transport: f.transport,
      presenter: f.presenter,
    });
    await expect(client.access.require('paid')).rejects.toMatchObject({ code: 'SESSION_EXPIRED' });
    expect(
      f.requests.some((r) => r.path.endsWith('/exchange') || r.path.endsWith('/checkout')),
    ).toBe(false);
    client.destroy();
  });

  it('drops expired buyer credentials and rejects a bridge invalidated by logout', async () => {
    const f = fixture();
    let now = Date.now();
    const session = new SessionManager({ workKey, transport: f.transport, now: () => now });
    await session.establish();
    const oldGeneration = session.identityGeneration;
    session.identifyBuyer({ buyerToken: 'buyer', expiresAt: now + 10 }, oldGeneration);
    now += 11;
    await session.request({
      method: 'POST',
      path: '/v1/public/work-sdk/access/check',
      body: { featureKeys: ['paid'] },
    });
    expect(f.requests.at(-1)?.buyerAuthorization).toBeUndefined();
    await session.signOut();
    expect(() =>
      session.identifyBuyer({ buyerToken: 'late', expiresAt: now + 1000 }, oldGeneration),
    ).toThrow();
    session.destroy();
  });
});
