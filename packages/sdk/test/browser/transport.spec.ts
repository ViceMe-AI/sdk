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
