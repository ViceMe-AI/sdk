import { expect, test } from '@playwright/test';

import { SDK_VERSION } from '../../src/version.ts';

const S3_ORIGIN = `http://127.0.0.1:${process.env.S3_PORT ?? 4174}`;

test('built ESM rejects a parsed Work session cancelled before delivery', async ({ page }) => {
  let sessionRequests = 0;
  await page.route('**/v1/public/work-sdk/sessions', async (route) => {
    sessionRequests += 1;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'access-control-allow-origin': '*' },
      body: JSON.stringify({
        workKey: 'wrk_test_demo',
        token: 'test-session-token',
        capabilities: ['checkout'],
      }),
    });
  });
  await page.goto('/pages/health.html');

  const result = await page.evaluate(async (sdkUrl) => {
    const { createViceMe } = await import(sdkUrl);
    const controller = new AbortController();
    const reason = new Error('Route disposed');
    const originalJson = Response.prototype.json;
    let parsedBodies = 0;
    Response.prototype.json = function () {
      const parsed = originalJson.call(this);
      if (this.url.endsWith('/v1/public/work-sdk/sessions')) {
        // Use the browser's real fetch/body parser, placing the host's abort
        // reaction immediately before the SDK's body-await continuation.
        void parsed.then(() => {
          parsedBodies += 1;
          controller.abort(reason);
        });
      }
      return parsed;
    };
    const client = createViceMe({
      workKey: 'wrk_test_demo',
      region: 'cn',
      signal: controller.signal,
    });
    try {
      const check = async () => {
        try {
          await client.auth.getState();
          return 'resolved';
        } catch (error) {
          return error === reason ? 'caller-reason' : 'unexpected-error';
        }
      };
      const first = await check();
      const cached = client.hasCapability('checkout');
      const second = await check();
      return { first, second, cached, parsedBodies };
    } finally {
      client.destroy();
      Response.prototype.json = originalJson;
    }
  }, `${S3_ORIGIN}/viceme-sdk/${SDK_VERSION}/index.js`);

  expect(result).toEqual({
    first: 'caller-reason',
    second: 'caller-reason',
    cached: false,
    parsedBodies: 1,
  });
  expect(sessionRequests).toBe(1);
});

test('built ESM preserves a caller abort reason during interactive presentation', async ({
  page,
}) => {
  await page.route('**/v1/public/work-sdk/sessions', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'access-control-allow-origin': '*' },
      body: JSON.stringify({
        workKey: 'wrk_test_demo',
        token: 'test-session-token',
        capabilities: ['auth'],
      }),
    });
  });
  await page.goto('/pages/health.html');

  const result = await page.evaluate(async (sdkUrl) => {
    const { createViceMe } = await import(sdkUrl);
    const controller = new AbortController();
    const reason = new Error('Route disposed');
    const client = createViceMe({
      workKey: 'wrk_test_demo',
      region: 'cn',
      signal: controller.signal,
    });
    try {
      const pending = client.auth.signIn();
      while (!document.querySelector('viceme-access-layer')) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      controller.abort(reason);
      try {
        await pending;
        return 'resolved';
      } catch (error) {
        return error === reason ? 'caller-reason' : 'unexpected-error';
      }
    } finally {
      client.destroy();
    }
  }, `${S3_ORIGIN}/viceme-sdk/${SDK_VERSION}/index.js`);

  expect(result).toBe('caller-reason');
  await expect(page.locator('viceme-access-layer')).toHaveCount(0);
});

test('built ESM preserves a caller abort reason at presentation delivery', async ({ page }) => {
  await page.goto('/pages/health.html');

  const result = await page.evaluate(async (testingUrl) => {
    const { createTestViceMe } = await import(testingUrl);
    const controller = new AbortController();
    const reason = new Error('Route disposed after presentation');
    const client = createTestViceMe({
      workKey: 'wrk_test_demo',
      region: 'cn',
      signal: controller.signal,
      transport: {
        async request() {
          return {
            status: 201,
            body: {
              workKey: 'wrk_test_demo',
              token: 'test-session-token',
              capabilities: ['auth'],
            },
          };
        },
      },
      presenter: () =>
        Promise.resolve<'dismissed'>('dismissed').then((presentationResult) => {
          queueMicrotask(() => controller.abort(reason));
          return presentationResult;
        }),
    });
    try {
      await client.auth.signIn();
      return 'resolved';
    } catch (error) {
      return error === reason ? 'caller-reason' : 'unexpected-error';
    } finally {
      client.destroy();
    }
  }, `${S3_ORIGIN}/viceme-sdk/${SDK_VERSION}/testing.js`);

  expect(result).toBe('caller-reason');
});

test('built v3 ESM restores an anonymous buyer without message credentials or a second consent click', async ({
  page,
}) => {
  const paths: string[] = [];
  let identified = false;
  await page.route('**/v1/public/work-sdk/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    paths.push(path);
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    let body: unknown;
    if (path.endsWith('/sessions')) {
      expect(request.postDataJSON()).toEqual({
        workKey: 'wrk_test_demo',
        supportedAccessProtocolVersions: [3],
      });
      body = {
        workKey: 'wrk_test_demo',
        token: 'work-token',
        expiresAt,
        capabilities: ['access'],
        accessProtocolVersion: 3,
        marketCapabilities: {
          market: 'CN',
          loginMethods: ['WECHAT'],
          supportedPriceCurrencies: ['CNY'],
          checkoutAvailability: 'AVAILABLE',
          anonymousPurchase: true,
        },
      };
    } else if (path.endsWith('/access/check')) {
      const allowed = request.headers()['x-viceme-buyer-token'] === 'buyer-token';
      body = {
        decisions: {
          paid: {
            allowed,
            reason: allowed ? 'ENTITLED' : 'BUYER_REQUIRED',
            nextAction: allowed ? null : 'RESOLVE_BUYER',
          },
        },
      };
    } else if (path.endsWith('/buyer/challenges')) {
      expect(request.postDataJSON()).not.toHaveProperty('parentOrigin');
      body = {
        challengeId: 'browser-challenge',
        bridgeUrl: 'https://viceme.cn/sdk/buyer/browser-challenge',
        expiresAt,
      };
    } else if (path.endsWith('/result')) {
      body = { status: 'READY', code: 'proof-code' };
    } else if (path.endsWith('/exchange')) {
      expect(request.postDataJSON().codeVerifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
      identified = true;
      body = { purpose: 'IDENTIFY', buyerToken: 'buyer-token', expiresAt };
    } else throw new Error(`Unexpected request ${path}`);
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'access-control-allow-origin': '*' },
      body: JSON.stringify(body),
    });
  });
  await page.route('https://viceme.cn/sdk/buyer/**', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<p>Restore purchase</p>' }),
  );
  await page.goto('/pages/health.html');
  const result = await page.evaluate(async (sdkUrl) => {
    const { createViceMe } = await import(sdkUrl);
    const client = createViceMe({ workKey: 'wrk_test_demo', region: 'cn' });
    try {
      const decision = await client.access.require('paid');
      return { decision, auth: await client.auth.getState(), storage: sessionStorage.length };
    } finally {
      client.destroy();
    }
  }, `${S3_ORIGIN}/viceme-sdk/${SDK_VERSION}/index.js`);
  expect(identified).toBe(true);
  expect(result.decision).toEqual({ allowed: true, reason: 'ENTITLED', nextAction: null });
  expect(result.auth.authenticated).toBe(false);
  expect(result.storage).toBe(0);
  expect(paths.some((path) => path.endsWith('/checkout') || path.endsWith('/follow'))).toBe(false);
  await expect(page.locator('viceme-access-layer')).toHaveCount(0);
});
