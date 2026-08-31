import { expect, test } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

let presentationBundle = '';

test.beforeAll(async () => {
  const result = await build({
    configFile: false,
    logLevel: 'silent',
    build: {
      write: false,
      target: 'es2022',
      lib: {
        entry: fileURLToPath(new URL('../../src/core/presentation.ts', import.meta.url)),
        formats: ['es'],
      },
      rollupOptions: { output: { inlineDynamicImports: true } },
    },
  });
  const output = (Array.isArray(result) ? result : [result]).find((item) => 'output' in item);
  const chunk = output?.output.find((item) => item.type === 'chunk');
  if (!chunk || chunk.type !== 'chunk') throw new Error('presentation browser bundle missing');
  presentationBundle = chunk.code;
});

test('checkout action is visible and opens its external popup from a real click', async ({
  page,
}) => {
  await page.route('**/test/presentation.js', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'text/javascript; charset=utf-8',
      headers: { 'access-control-allow-origin': '*' },
      body: presentationBundle,
    }),
  );
  await page.goto('/pages/health.html');
  await page.addScriptTag({
    type: 'module',
    content: `
      import { defaultAccessPresenter } from "/test/presentation.js";
      let complete;
      const completion = new Promise((resolve) => { complete = resolve; });
      window.__completeCheckout = complete;
      window.__presentation = defaultAccessPresenter({
        featureKey: "members",
        reason: "PURCHASE_REQUIRED",
        action: "CHECKOUT",
        perform: async () => {
          window.open("/pages/health.html?checkout=1", "_blank");
          return { type: "external", completion, cancel() {} };
        },
      });
    `,
  });

  const action = page.locator('viceme-access-layer').getByRole('button', {
    name: '打开支付',
  });
  await expect(action).toBeVisible();
  const popupPromise = page.waitForEvent('popup');
  await action.click();
  const popup = await popupPromise;
  await expect.poll(() => popup.url()).toContain('checkout=1');
  await popup.close();
  await page.evaluate(() => {
    (window as typeof window & { __completeCheckout: () => void }).__completeCheckout();
  });
  await expect(page.locator('viceme-access-layer')).toHaveCount(0);
});
