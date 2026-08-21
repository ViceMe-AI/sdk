// @vitest-environment happy-dom

import { describe, expect, it, vi } from 'vitest';
import { defaultAccessPresenter } from '../../src/core/presentation.ts';
import { ViceMeError } from '../../src/core/errors.ts';

describe('default access presenter', () => {
  it('shows complete creator information in the login consent layer', async () => {
    const perform = vi.fn(async () => ({ type: 'completed' as const }));
    const presented = defaultAccessPresenter({
      featureKey: 'auth',
      reason: 'AUTH_REQUIRED',
      action: 'SIGN_IN',
      followTarget: {
        kind: 'CREATOR',
        displayName: '归藏',
        avatarUrl: 'https://cdn.example.com/creator.jpg',
        description: '专注于 AI 创作工具与智能体工作流。',
      },
      perform,
    });
    const layer = document.querySelector('viceme-access-layer');
    expect(layer).not.toBeNull();
    const shadow = layer!.shadowRoot!;

    expect(shadow.querySelector("[data-viceme='title']")).toBeNull();
    expect(shadow.querySelector("[data-viceme='profile']")?.getAttribute('data-visible')).toBe(
      'true',
    );
    expect(shadow.querySelector("[data-viceme='profile-name']")?.textContent).toBe('归藏');
    expect(shadow.querySelector("[data-viceme='profile-description']")?.textContent).toBe(
      '专注于 AI 创作工具与智能体工作流。',
    );
    expect(shadow.querySelector("[data-viceme='action']")?.textContent).toBe('登录');
    expect(shadow.querySelector('[data-viceme-cancel]')?.textContent).toBe('拒绝');
    expect(shadow.querySelector("[data-viceme='description']")?.textContent).toBe('');
    expect(shadow.textContent).toContain('登录');
    const styles = shadow.querySelector('style')?.textContent ?? '';
    expect(styles).toContain("[data-action='SIGN_IN'] [data-viceme='description']");
    expect(styles).toContain('box-sizing: border-box;');
    expect(styles).toContain('height: min(72dvh, 34rem);');

    (shadow.querySelector('[data-viceme-cancel]') as HTMLButtonElement).click();
    await expect(presented).resolves.toBe('dismissed');
    expect(perform).not.toHaveBeenCalled();
  });

  it('opens checkout directly inside the access layer frame', async () => {
    let complete!: () => void;
    const completion = new Promise<void>((resolve) => {
      complete = resolve;
    });
    const presented = defaultAccessPresenter({
      featureKey: 'emperor',
      reason: 'PURCHASE_REQUIRED',
      action: 'CHECKOUT',
      perform: vi.fn(async () => ({
        type: 'frame' as const,
        url: 'about:blank#checkout',
        completion,
        cancel: vi.fn(),
      })),
    });
    const layer = document.querySelector('viceme-access-layer');

    await vi.waitFor(() => {
      expect(layer?.shadowRoot?.querySelector('iframe')?.getAttribute('src')).toBe(
        'about:blank#checkout',
      );
    });
    const frame = layer?.shadowRoot?.querySelector('iframe') as HTMLIFrameElement;
    expect(layer?.shadowRoot?.querySelector('style')?.textContent).toContain(
      'height: min(82dvh, 44rem);',
    );
    expect(layer?.shadowRoot?.querySelector('style')?.textContent).toContain(
      'width: min(30rem, 100%);',
    );
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { type: 'viceme:frame:resize', height: 360 },
        origin: 'null',
        source: frame.contentWindow,
      }),
    );
    expect(frame.style.height).toBe('360px');
    expect(layer?.shadowRoot?.querySelector("[data-viceme='close']")).not.toBeNull();
    complete();

    await expect(presented).resolves.toBe('acted');
  });

  it('shows the login relay directly without a click-blocking loading layer', async () => {
    const presented = defaultAccessPresenter({
      featureKey: 'auth',
      reason: 'AUTH_REQUIRED',
      action: 'SIGN_IN',
      perform: vi.fn(async () => ({
        type: 'frame' as const,
        url: 'about:blank#wechat-login',
        completion: new Promise<void>(() => undefined),
        cancel: vi.fn(),
      })),
    });
    const layer = document.querySelector('viceme-access-layer')!;
    const shadow = layer.shadowRoot!;
    (shadow.querySelector("[data-viceme='action']") as HTMLButtonElement).click();
    await vi.waitFor(() => {
      expect(shadow.querySelector('iframe')?.getAttribute('src')).toBe('about:blank#wechat-login');
    });
    const frame = shadow.querySelector('iframe')!;
    expect(frame.hasAttribute('data-ready')).toBe(false);
    expect(shadow.querySelector("[data-viceme='frame-loading']")).toBeNull();

    (shadow.querySelector("[data-viceme='backdrop']") as HTMLButtonElement).click();
    await expect(presented).resolves.toBe('dismissed');
  });

  it('cancels an active checkout frame from the backdrop', async () => {
    const cancel = vi.fn();
    const presented = defaultAccessPresenter({
      featureKey: 'emperor',
      reason: 'PURCHASE_REQUIRED',
      action: 'CHECKOUT',
      perform: vi.fn(async () => ({
        type: 'frame' as const,
        url: 'about:blank#checkout-cancel',
        completion: new Promise<void>(() => undefined),
        cancel,
      })),
    });
    const layer = document.querySelector('viceme-access-layer');

    await vi.waitFor(() => {
      expect(layer?.shadowRoot?.querySelector('iframe')?.getAttribute('src')).toBe(
        'about:blank#checkout-cancel',
      );
    });
    (layer?.shadowRoot?.querySelector("[data-viceme='backdrop']") as HTMLButtonElement).click();

    await expect(presented).resolves.toBe('dismissed');
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('shows immediate progress after the first interactive click', async () => {
    let finish!: () => void;
    const perform = vi.fn(
      () =>
        new Promise<{ type: 'completed' }>((resolve) => {
          finish = () => resolve({ type: 'completed' });
        }),
    );
    const presented = defaultAccessPresenter({
      featureKey: 'auth',
      reason: 'AUTH_REQUIRED',
      action: 'SIGN_IN',
      perform,
    });
    const action = document
      .querySelector('viceme-access-layer')
      ?.shadowRoot?.querySelector("[data-viceme='action']") as HTMLButtonElement;

    expect(action.parentElement?.dataset.single).toBe('false');
    action.click();

    expect(action.disabled).toBe(true);
    expect(action.getAttribute('aria-busy')).toBe('true');
    expect(action.textContent).toBe('正在打开…');
    finish();
    await expect(presented).resolves.toBe('acted');
  });

  it('explains when the login session has expired', async () => {
    const presented = defaultAccessPresenter({
      featureKey: 'auth',
      reason: 'AUTH_REQUIRED',
      action: 'SIGN_IN',
      perform: vi.fn(async () => {
        throw new ViceMeError({
          code: 'SESSION_EXPIRED',
          message: 'The work session has expired.',
        });
      }),
    });
    const layer = document.querySelector('viceme-access-layer')!;
    const shadow = layer.shadowRoot!;

    (shadow.querySelector("[data-viceme='action']") as HTMLButtonElement).click();
    await vi.waitFor(() => {
      expect(shadow.querySelector("[data-viceme='error']")?.textContent).toBe(
        '授权会话已过期，请重试。',
      );
    });
    (shadow.querySelector("[data-viceme='backdrop']") as HTMLButtonElement).click();
    await expect(presented).resolves.toBe('dismissed');
  });

  it('reports invalid WeChat login configuration', async () => {
    const presented = defaultAccessPresenter({
      featureKey: 'auth',
      reason: 'AUTH_REQUIRED',
      action: 'SIGN_IN',
      perform: vi.fn(async () => {
        throw new ViceMeError({
          code: 'CONFIG_INVALID',
          message: 'Invalid WeChat sign-in configuration.',
        });
      }),
    });
    const layer = document.querySelector('viceme-access-layer')!;
    const shadow = layer.shadowRoot!;

    (shadow.querySelector("[data-viceme='action']") as HTMLButtonElement).click();
    await vi.waitFor(() => {
      expect(shadow.querySelector("[data-viceme='error']")?.textContent).toBe(
        '微信授权配置无效，请稍后重试。',
      );
    });
    (shadow.querySelector("[data-viceme='backdrop']") as HTMLButtonElement).click();
    await expect(presented).resolves.toBe('dismissed');
  });
});
