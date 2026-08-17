// @vitest-environment happy-dom

import { describe, expect, it, vi } from 'vitest';
import { defaultAccessPresenter } from '../../src/core/presentation.ts';
import { ViceMeError } from '../../src/core/errors.ts';

describe('default access presenter', () => {
  it('renders the follow target at the top with cancel and follow actions', async () => {
    const perform = vi.fn(async () => ({ type: 'completed' as const }));
    const presented = defaultAccessPresenter({
      featureKey: 'dingdong',
      reason: 'FOLLOW_REQUIRED',
      action: 'FOLLOW',
      followTarget: {
        kind: 'CREATOR',
        displayName: '归藏',
        avatarUrl: 'https://cdn.example.com/creator.jpg',
        description: '专注于 AI 创作工具与智能体工作流。',
      },
      perform,
    });
    const layer = document.querySelector('viceme-access-layer');
    expect(layer?.shadowRoot?.querySelector("[data-viceme='panel']")?.getAttribute('role')).toBe(
      'dialog',
    );
    expect(layer?.shadowRoot?.querySelector("[data-viceme='action']")?.textContent).toBe('关注');
    expect(layer?.shadowRoot?.querySelector("[data-viceme='profile-name']")?.textContent).toBe(
      '归藏',
    );
    expect(layer?.shadowRoot?.querySelector("[data-viceme='dismiss']")).toBeNull();
    expect(layer?.shadowRoot?.querySelector("[data-viceme='close']")).toBeNull();
    expect(layer?.shadowRoot?.querySelector("[data-viceme='title']")?.textContent).toBe('');
    expect(layer?.shadowRoot?.querySelector("[data-viceme='description']")?.textContent).toBe('');
    expect(
      layer?.shadowRoot?.querySelector("[data-viceme='profile-description']")?.textContent,
    ).toBe('专注于 AI 创作工具与智能体工作流。');
    expect(layer?.shadowRoot?.querySelector('[data-viceme-cancel]')?.textContent).toBe('取消');
    expect(
      layer?.shadowRoot?.querySelector("[data-viceme='action']")?.parentElement?.dataset.single,
    ).toBe('false');
    expect(layer?.shadowRoot?.innerHTML).not.toMatch(/\bpart=|var\(|Canvas|inherit/);

    (layer?.shadowRoot?.querySelector('[data-viceme-cancel]') as HTMLButtonElement).click();

    await expect(presented).resolves.toBe('dismissed');
    expect(perform).not.toHaveBeenCalled();
    expect(document.querySelector('viceme-access-layer')).toBeNull();
  });

  it('shows the default follow copy for an ordinary user', async () => {
    const presented = defaultAccessPresenter({
      featureKey: 'dingdong',
      reason: 'FOLLOW_REQUIRED',
      action: 'FOLLOW',
      followTarget: {
        kind: 'USER',
        displayName: '普通用户',
        avatarUrl: null,
        description: null,
      },
      perform: vi.fn(async () => ({ type: 'completed' as const })),
    });
    const layer = document.querySelector('viceme-access-layer');

    expect(
      layer?.shadowRoot?.querySelector("[data-viceme='profile-description']")?.textContent,
    ).toBe('关注后即可继续使用此功能。');

    (layer?.shadowRoot?.querySelector('[data-viceme-cancel]') as HTMLButtonElement).click();
    await expect(presented).resolves.toBe('dismissed');
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
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { type: 'viceme:frame:resize', height: 360 },
        origin: 'null',
        source: frame.contentWindow,
      }),
    );
    expect(frame.style.height).toBe('360px');
    expect(layer?.shadowRoot?.querySelector("[data-viceme='close']")).toBeNull();
    complete();

    await expect(presented).resolves.toBe('acted');
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

    expect(action.parentElement?.dataset.single).toBe('true');
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
        '登录会话已过期，请重试。',
      );
    });
    (shadow.querySelector("[data-viceme='backdrop']") as HTMLButtonElement).click();
    await expect(presented).resolves.toBe('dismissed');
  });

  it('offers phone verification login without leaving the access layer', async () => {
    const sendCode = vi.fn(async () => ({ expiresInSeconds: 300, retryAfterSeconds: 60 }));
    const signIn = vi.fn(async () => undefined);
    const presented = defaultAccessPresenter({
      featureKey: 'auth',
      reason: 'AUTH_REQUIRED',
      action: 'SIGN_IN',
      phoneAuth: { sendCode, signIn },
      perform: vi.fn(async () => ({ type: 'completed' as const })),
    });
    const shadow = document.querySelector('viceme-access-layer')!.shadowRoot!;

    (shadow.querySelector('[data-viceme-phone-action]') as HTMLButtonElement).click();
    const phone = shadow.querySelector('[data-viceme-phone]') as HTMLInputElement;
    const code = shadow.querySelector('[data-viceme-code]') as HTMLInputElement;
    phone.value = '13800138000';
    code.value = '123456';
    (shadow.querySelector("[data-viceme='send-code']") as HTMLButtonElement).click();
    await vi.waitFor(() => expect(sendCode).toHaveBeenCalledWith('13800138000'));
    (shadow.querySelector("[data-viceme='phone-form']") as HTMLFormElement).dispatchEvent(
      new Event('submit', { cancelable: true }),
    );

    await expect(presented).resolves.toBe('acted');
    expect(signIn).toHaveBeenCalledWith('13800138000', '123456');
  });
});
