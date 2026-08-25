import { expect, test } from '@playwright/test';

test('sign-in stays clickable in a content-sized mobile access layer', async ({
  browser,
  browserName,
}) => {
  test.skip(browserName !== 'chromium');
  const context = await browser.newContext({
    isMobile: true,
    reducedMotion: 'reduce',
    viewport: { width: 390, height: 844 },
  });
  const page = await context.newPage();
  const origin = process.env.VICEME_SDK_TEST_ORIGIN ?? 'http://127.0.0.1:4173';
  await page.goto(`${origin}/pages/access-mobile.html`);

  await page.getByRole('button', { name: '打开功能' }).click();
  const dialog = page.getByRole('dialog', { name: '授权 归藏' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText('归藏')).toBeVisible();
  await expect(dialog.getByText('AI 创业者')).toBeVisible();
  await expect(dialog.getByText('2 个作品')).toBeVisible();
  await expect(dialog.locator("[data-viceme='profile-cover']")).toHaveCount(2);
  await expect(dialog.getByText('关注创作者')).toHaveCount(0);
  await expect(dialog.getByText('登录授权后将自动关注该创作者')).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: '关闭' })).toBeVisible();
  await expect(dialog.getByRole('button', { name: '授权' })).toBeEnabled();
  await expect(dialog.getByRole('button', { name: '拒绝' })).toHaveCount(0);
  const avatarBox = await dialog.locator("[data-viceme='avatar-fallback']").boundingBox();
  const nameBox = await dialog.getByText('归藏').boundingBox();
  const acceptBox = await dialog.getByRole('button', { name: '授权' }).boundingBox();
  const dialogBox = await dialog.boundingBox();
  expect(avatarBox).not.toBeNull();
  expect(nameBox).not.toBeNull();
  expect(acceptBox).not.toBeNull();
  expect(dialogBox).not.toBeNull();
  expect(nameBox!.y).toBeGreaterThan(avatarBox!.y + avatarBox!.height);
  expect(dialogBox!.height).toBeLessThan(620);

  await dialog.getByRole('button', { name: '授权' }).click();
  await expect
    .poll(() => page.evaluate(() => window.__authorizeBody))
    .toMatchObject({ clientType: 'pc' });
  const authorizationFrame = page.locator('viceme-access-layer').locator('iframe').contentFrame();
  await expect(dialog.getByRole('button', { name: '关闭' })).toBeVisible();
  await expect
    .poll(async () => (await dialog.boundingBox())?.height)
    .toBeCloseTo(dialogBox!.height, 0);
  await authorizationFrame.getByRole('button', { name: '继续授权' }).click();
  await expect(authorizationFrame.getByText('已点击')).toBeVisible();

  await context.close();
});

declare global {
  interface Window {
    __authorizeBody: { clientType?: string } | null;
  }
}
