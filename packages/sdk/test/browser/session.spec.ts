import { expect, test } from '@playwright/test';
import type { ViceMeClient } from '../../src/core/client.ts';
import { SDK_VERSION } from '../../src/version.ts';

const API_ORIGIN = (process.env.VICEME_BUILD_CN_API_BASE_URL ?? 'https://api.viceme.cn').replace(
  /\/+$/,
  '',
);
const WIDGET_ORIGIN = (process.env.VICEME_BUILD_CN_WIDGET_ORIGIN ?? 'https://viceme.cn').replace(
  /\/+$/,
  '',
);
const S3_ORIGIN = `http://127.0.0.1:${process.env.S3_PORT ?? 4174}`;

type SessionTestWindow = typeof window & { __client: ViceMeClient };

test('release ESM rejects a stale login after sign-out and permits a fresh login', async ({
  page,
}) => {
  let sessionRequests = 0;
  await page.route(`${API_ORIGIN}/v1/public/work-sdk/sessions`, async (route) => {
    const headers = {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'POST, OPTIONS',
      'access-control-allow-headers': 'content-type, x-client-request-id',
    };
    if (route.request().method() === 'OPTIONS') {
      await route.fulfill({ status: 204, headers });
      return;
    }
    sessionRequests += 1;
    await route.fulfill({
      status: 201,
      contentType: 'application/json',
      headers,
      body: JSON.stringify({
        workKey: 'wrk_test_demo',
        capabilities: ['access'],
        // Reissued credential bytes still represent a different local session.
        token: 'browser-work-token',
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      }),
    });
  });
  await page.route(`${WIDGET_ORIGIN}/sdk/login**`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: `<!doctype html><button id="complete" disabled>Complete login</button><script>
        const params = new URL(location.href).searchParams;
        const channel = params.get('channel');
        const parentOrigin = params.get('parentOrigin');
        const complete = document.querySelector('#complete');
        addEventListener('message', (event) => {
          if (event.origin !== parentOrigin || event.source !== parent) return;
          if (event.data.type === 'viceme:auth:init' && event.data.channel === channel) {
            complete.disabled = false;
          }
        });
        complete.addEventListener('click', () => parent.postMessage({
          type: 'viceme:auth:complete', channel, workKey: 'wrk_test_demo',
          userToken: 'browser-user-token',
          user: { id: 'browser-user', displayName: 'Browser visitor', avatarUrl: null },
        }, parentOrigin));
        parent.postMessage({
          type: 'viceme:auth:ready', channel, workKey: 'wrk_test_demo',
        }, parentOrigin);
      </script>`,
    }),
  );
  await page.goto('/pages/health.html');
  await page.addScriptTag({
    type: 'module',
    content: `
      import { createViceMe } from '${S3_ORIGIN}/viceme-sdk/${SDK_VERSION}/index.js';
      window.__client = createViceMe({ workKey: 'wrk_test_demo', region: 'cn' });
      window.__client.auth.signIn().then(
        (state) => { document.body.dataset.authenticated = String(state.authenticated); },
        (error) => { document.body.dataset.error = error.code; },
      );
    `,
  });
  const layer = page.locator('viceme-access-layer');
  const authorize = layer.getByRole('button', { name: '授权', exact: true });
  await authorize.click();
  const complete = layer.locator('iframe').contentFrame().getByRole('button', {
    name: 'Complete login',
  });
  await expect(complete).toBeEnabled();
  await page.evaluate(() => (window as SessionTestWindow).__client.auth.signOut());
  expect(sessionRequests).toBe(2);
  await complete.click();

  await expect(layer.getByRole('alert')).toHaveText('授权会话已过期，请重试。');
  expect(await page.evaluate(() => (window as SessionTestWindow).__client.auth.getState())).toEqual(
    { authenticated: false, user: null },
  );

  // Retry must create a fresh action, bind its own session, and clean the layer.
  await authorize.click();
  await expect(complete).toBeEnabled();
  await complete.click();
  await expect(page.locator('body')).toHaveAttribute('data-authenticated', 'true');
  await expect(layer).toHaveCount(0);
  expect(
    await page.evaluate(() => (window as SessionTestWindow).__client.auth.getState()),
  ).toMatchObject({ authenticated: true, user: { subject: 'browser-user' } });
  await page.evaluate(() => (window as SessionTestWindow).__client.destroy());
});
