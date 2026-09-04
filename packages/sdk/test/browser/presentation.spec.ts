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

test('sign-in layer shows creator and current Work details on mobile', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
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
      window.__presentation = defaultAccessPresenter({
        featureKey: "members",
        reason: "AUTH_REQUIRED",
        action: "SIGN_IN",
        followTarget: {
          kind: "CREATOR",
          displayName: "归藏",
          avatarUrl: null,
          description: null,
          workCount: 12,
        },
        work: {
          title: "AI 创作工具",
          summary: "帮助创作者构建高质量内容。",
          coverUrl: null,
        },
        perform: async () => ({ type: "completed" }),
      });
    `,
  });

  const layer = page.locator('viceme-access-layer');
  await expect(layer.locator("[data-viceme='profile-name']")).toHaveText('归藏');
  await expect(layer.locator("[data-viceme='profile-stats']")).toHaveText('12 个作品');
  await expect(layer.locator("[data-viceme='work-title']")).toHaveText('AI 创作工具');
  await expect(layer.locator("[data-viceme='work-summary']")).toHaveText(
    '帮助创作者构建高质量内容。',
  );
  await expect(layer.getByRole('button', { name: '授权' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(layer).toHaveCount(0);
});

test('checkout action loads inside the SDK layer without an external popup', async ({ page }) => {
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
          return {
            type: "frame",
            url: "/pages/health.html?checkout=1",
            completion,
            cancel() {},
          };
        },
      });
    `,
  });

  const action = page.locator('viceme-access-layer').getByRole('button', {
    name: '打开支付',
  });
  await expect(action).toBeVisible();
  let popupCount = 0;
  page.on('popup', () => {
    popupCount += 1;
  });
  await action.click();
  const frame = page.locator('viceme-access-layer').locator('iframe');
  await expect(frame).toHaveAttribute('src', /checkout=1/u);
  expect(popupCount).toBe(0);
  await page.evaluate(() => {
    (window as typeof window & { __completeCheckout: () => void }).__completeCheckout();
  });
  await expect(page.locator('viceme-access-layer')).toHaveCount(0);
});
