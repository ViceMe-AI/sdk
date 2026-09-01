import { expect, test } from '@playwright/test';

import { SDK_VERSION } from '../../src/version.ts';

const WIDGET_ORIGIN = (process.env.VICEME_BUILD_CN_WIDGET_ORIGIN ?? 'https://viceme.cn').replace(
  /\/+$/,
  '',
);
const S3_ORIGIN = `http://127.0.0.1:${process.env.S3_PORT ?? 4174}`;
const INSECURE_ORIGIN = 'http://192.0.2.1';

test('exact-version ESM runs the trusted Headless Tip handoff without a window global', async ({
  page,
  context,
}) => {
  const requests: string[] = [];
  let configCookie: string | undefined;
  page.on('request', (request) => requests.push(request.url()));
  await context.addCookies([
    {
      name: 'session',
      value: 'must-not-be-sent',
      domain: new URL(WIDGET_ORIGIN).hostname,
      path: '/',
      secure: true,
      sameSite: 'None',
    },
  ]);
  await page.route(`${WIDGET_ORIGIN}/v1/work-sdk/wrk_test_demo/tip-config`, async (route) => {
    configCookie = route.request().headers().cookie;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'access-control-allow-origin': '*' },
      body: JSON.stringify({
        work: { id: '00000000-0000-4000-8000-000000000001', title: 'Browser work' },
        workKey: 'wrk_test_demo',
        environment: 'SANDBOX',
        currency: 'CNY',
        amount: { minCents: 100, maxCents: 20_000, stepCents: 1 },
        providers: ['WECHAT_PAY'],
      }),
    });
  });
  await page.route(`${WIDGET_ORIGIN}/widget/tip/wrk_test_demo**`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'text/html; charset=utf-8',
      body: `<!doctype html><button id="complete" disabled>Complete</button><script>
        const params = new URL(location.href).searchParams;
        const channel = params.get('channel');
        const complete = document.querySelector('#complete');
        let init;
        complete.addEventListener('click', () => {
          if (!init) return;
          parent.postMessage({
            type: 'viceme:tip-headless-result',
            channel,
            workKey: 'wrk_test_demo',
            status: 'PAID',
            work: { id: '00000000-0000-4000-8000-000000000001', title: 'Browser work' },
            amountCents: init.amountCents,
            currency: 'CNY',
          }, '*');
        });
        addEventListener('message', (event) => {
          const message = event.data;
          if (
            message?.type !== 'viceme:tip-headless-init' ||
            message.channel !== channel ||
            message.workKey !== 'wrk_test_demo'
          ) return;
          init = message;
          complete.disabled = false;
        });
        parent.postMessage({
          type: 'viceme:tip-headless-ready',
          channel,
          workKey: 'wrk_test_demo',
        }, '*');
      </script>`,
    });
  });

  await page.route(`${INSECURE_ORIGIN}/**`, async (route) => {
    const requestUrl = new URL(route.request().url());
    if (requestUrl.pathname === '/host') {
      await route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html>' });
      return;
    }
    const response = await route.fetch({
      url: `${S3_ORIGIN}${requestUrl.pathname}${requestUrl.search}`,
    });
    await route.fulfill({ response });
  });
  await page.goto(`${INSECURE_ORIGIN}/host`);
  expect(
    await page.evaluate(() => ({ secure: isSecureContext, randomUUID: typeof crypto.randomUUID })),
  ).toEqual({ secure: false, randomUUID: 'undefined' });
  await page.setViewportSize({ width: 320, height: 568 });
  await page.setContent(`
    <button id="open" type="button" disabled>Open Tip</button>
    <button id="cancel-open" type="button" disabled>Open cancellable Tip</button>
    <button id="cancel-destroy" type="button" disabled>Destroy cancellable Tip</button>
    <script type="module">
      import { createViceMe } from '${INSECURE_ORIGIN}/viceme-sdk/${SDK_VERSION}/index.js';
      import { createTip } from '${INSECURE_ORIGIN}/viceme-sdk/${SDK_VERSION}/tip.js';
      const client = createViceMe({ workKey: 'wrk_test_demo', region: 'cn' });
      const tip = createTip(client);
      const config = await tip.getConfig();
      document.body.dataset.config = JSON.stringify(config);
      const button = document.querySelector('#open');
      button.disabled = false;
      button.addEventListener('click', async () => {
        const result = await tip.open({
          amountCents: 520,
          provider: 'WECHAT_PAY',
          locale: 'zh-CN',
          appearance: 'light',
        });
        document.body.dataset.result = JSON.stringify(result);
        tip.destroy();
        client.destroy();
      });

      const cancelClient = createViceMe({ workKey: 'wrk_test_demo', region: 'cn' });
      const cancelTip = createTip(cancelClient);
      const cancelOpen = document.querySelector('#cancel-open');
      const cancelDestroy = document.querySelector('#cancel-destroy');
      let cancelPending;
      cancelOpen.disabled = false;
      cancelOpen.addEventListener('click', () => {
        cancelPending = cancelTip.open({ amountCents: 520, appearance: 'light' });
        cancelDestroy.disabled = false;
      });
      cancelDestroy.addEventListener('click', async () => {
        cancelTip.destroy();
        document.body.dataset.cancelResult = JSON.stringify(await cancelPending);
        cancelClient.destroy();
      });
    </script>
  `);

  await expect(page.locator('#open')).toBeEnabled();
  await expect(page.locator('#cancel-open')).toBeEnabled();
  expect(await page.locator('body').getAttribute('data-config')).toContain('Browser work');
  expect(configCookie).toBeUndefined();
  expect(await page.evaluate(() => 'ViceMe' in window)).toBe(false);

  await page.locator('#cancel-open').click();
  await expect(page.locator('[data-viceme-tip-headless="open"]')).toHaveCount(1);
  await page.locator('#cancel-destroy').evaluate((button: HTMLButtonElement) => button.click());
  await expect
    .poll(() => page.locator('body').getAttribute('data-cancel-result'))
    .toBe(JSON.stringify({ status: 'UNKNOWN' }));
  await expect(page.locator('[data-viceme-tip-headless="open"]')).toHaveCount(0);

  await page.locator('#open').click();

  const portal = page.locator('[data-viceme-tip-headless="open"]');
  await expect(portal).toHaveCount(1);
  const bounds = await portal.boundingBox();
  expect(bounds).toEqual({ x: 0, y: 0, width: 320, height: 568 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  const widget = page.frameLocator('iframe[title="ViceMe Tip"]');
  await expect(widget.locator('#complete')).toBeEnabled();
  await widget.locator('#complete').click();

  await expect
    .poll(() => page.locator('body').getAttribute('data-result'))
    .toBe(
      JSON.stringify({
        status: 'PAID',
        work: { id: '00000000-0000-4000-8000-000000000001', title: 'Browser work' },
        amountCents: 520,
        currency: 'CNY',
      }),
    );
  expect(requests.some((url) => /order|payment-action|transaction/i.test(url))).toBe(false);
});
