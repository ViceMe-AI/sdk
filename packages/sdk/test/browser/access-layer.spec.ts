import { expect, test } from '@playwright/test';

test('sign-in stays clickable in the taller mobile access layer', async ({
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
  const dialog = page.getByRole('dialog', { name: 'ViceMe 授权' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: '登录' })).toBeEnabled();
  await expect(dialog.getByRole('button', { name: '拒绝' })).toBeEnabled();
  const acceptBox = await dialog.getByRole('button', { name: '登录' }).boundingBox();
  const rejectBox = await dialog.getByRole('button', { name: '拒绝' }).boundingBox();
  const dialogBox = await dialog.boundingBox();
  expect(acceptBox).not.toBeNull();
  expect(rejectBox).not.toBeNull();
  expect(dialogBox).not.toBeNull();
  expect(Math.abs(acceptBox!.y - rejectBox!.y)).toBeLessThan(1);
  expect(Math.abs(acceptBox!.height - rejectBox!.height)).toBeLessThan(1);
  expect(dialogBox!.height).toBeGreaterThan(480);

  await dialog.getByRole('button', { name: '登录' }).click();
  await expect
    .poll(() => page.evaluate(() => window.__authorizeBody))
    .toMatchObject({ clientType: 'pc' });
  const authorizationFrame = page.locator('viceme-access-layer').locator('iframe').contentFrame();
  await authorizationFrame.getByRole('button', { name: '继续授权' }).click();
  await expect(authorizationFrame.getByText('已点击')).toBeVisible();

  await context.close();
});

declare global {
  interface Window {
    __authorizeBody: { clientType?: string } | null;
  }
}
