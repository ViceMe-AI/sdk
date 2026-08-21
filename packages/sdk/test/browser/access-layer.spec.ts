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

test('follow creator uses the centered ViceMe profile layout without ratings', async ({
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
  await page.goto(`${origin}/pages/access-mobile.html?follow=1`);

  await page.getByRole('button', { name: '打开功能' }).click();
  const dialog = page.getByRole('dialog', { name: '关注 归藏' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('heading', { name: '关注创作者' })).toBeVisible();
  await expect(dialog.getByText('归藏 · Web 创作者')).toBeVisible();
  await expect(dialog.getByText('关注 归藏，获取作品更新与专属权益')).toBeVisible();
  await expect(dialog).not.toContainText('好评');
  await expect(dialog.getByRole('button', { name: '关闭' })).toBeEnabled();

  const action = dialog.getByRole('button', { name: '关注并继续' });
  const actionBox = await action.boundingBox();
  const dialogBox = await dialog.boundingBox();
  expect(actionBox).not.toBeNull();
  expect(dialogBox).not.toBeNull();
  expect(actionBox!.width).toBeGreaterThan(dialogBox!.width * 0.8);

  await action.click();
  await expect(dialog).not.toBeVisible();
  await context.close();
});

test('desktop checkout frame is narrow and exposes a keyboard-accessible close action', async ({
  browser,
  browserName,
}) => {
  test.skip(browserName !== 'chromium');
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const origin = process.env.VICEME_SDK_TEST_ORIGIN ?? 'http://127.0.0.1:4173';
  await page.goto(`${origin}/pages/access-mobile.html?checkout=1`);

  await page.getByRole('button', { name: '打开功能' }).click();
  const dialog = page.getByRole('dialog', { name: 'ViceMe 授权' });
  const close = dialog.getByRole('button', { name: '关闭' });
  await expect(dialog.locator('iframe')).toBeVisible();
  await expect(close).toBeVisible();
  const dialogBox = await dialog.boundingBox();
  expect(dialogBox).not.toBeNull();
  expect(dialogBox!.width).toBeLessThanOrEqual(580);

  await close.focus();
  await expect(close).toBeFocused();
  await close.click();
  await expect(dialog).not.toBeVisible();
  await context.close();
});

declare global {
  interface Window {
    __authorizeBody: { clientType?: string } | null;
  }
}
