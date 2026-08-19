import { expect, test } from '@playwright/test';

test('creator authorization stays clickable in Chrome mobile emulation', async ({
  browser,
  browserName,
}) => {
  test.skip(browserName !== 'chromium');
  const context = await browser.newContext({
    isMobile: true,
    viewport: { width: 390, height: 844 },
  });
  const page = await context.newPage();
  const origin = process.env.VICEME_SDK_TEST_ORIGIN ?? 'http://127.0.0.1:4173';
  await page.goto(`${origin}/pages/access-mobile.html`);

  await page.getByRole('button', { name: '打开功能' }).click();
  const dialog = page.getByRole('dialog', { name: '接受 归藏 的授权' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText('归藏')).toBeVisible();
  await expect(dialog.getByRole('button', { name: '接受' })).toBeEnabled();
  await expect(dialog.getByRole('button', { name: '拒绝' })).toBeEnabled();
  await expect(dialog).not.toContainText('登录');

  await dialog.getByRole('button', { name: '接受' }).click();
  await expect
    .poll(() => page.evaluate(() => window.__authorizeBody))
    .toMatchObject({ clientType: 'pc' });

  await context.close();
});

declare global {
  interface Window {
    __authorizeBody: { clientType?: string } | null;
  }
}
