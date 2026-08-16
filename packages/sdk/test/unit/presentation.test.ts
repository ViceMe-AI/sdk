// @vitest-environment happy-dom

import { describe, expect, it, vi } from 'vitest';
import { defaultAccessPresenter } from '../../src/core/presentation.ts';

describe('default access presenter', () => {
  it('renders an in-page Web Component and does not act when dismissed', async () => {
    const perform = vi.fn(async () => ({ type: 'completed' as const }));
    const presented = defaultAccessPresenter({
      featureKey: 'dingdong',
      reason: 'FOLLOW_REQUIRED',
      action: 'FOLLOW',
      perform,
    });
    const layer = document.querySelector('viceme-access-layer');
    expect(layer?.shadowRoot?.querySelector("[data-viceme='panel']")?.getAttribute('role')).toBe(
      'dialog',
    );
    expect(layer?.shadowRoot?.querySelector("[data-viceme='action']")?.textContent).toBe(
      '关注创作者',
    );
    expect(layer?.shadowRoot?.innerHTML).not.toMatch(/\bpart=|var\(|Canvas|inherit/);

    (layer?.shadowRoot?.querySelector("[data-viceme='dismiss']") as HTMLButtonElement).click();

    await expect(presented).resolves.toBe('dismissed');
    expect(perform).not.toHaveBeenCalled();
    expect(document.querySelector('viceme-access-layer')).toBeNull();
  });

  it('keeps login and checkout inside the access layer frame', async () => {
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

    (layer?.shadowRoot?.querySelector("[data-viceme='action']") as HTMLButtonElement).click();
    await vi.waitFor(() => {
      expect(layer?.shadowRoot?.querySelector('iframe')?.getAttribute('src')).toBe(
        'about:blank#checkout',
      );
    });
    complete();

    await expect(presented).resolves.toBe('acted');
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

    action.click();

    expect(action.disabled).toBe(true);
    expect(action.getAttribute('aria-busy')).toBe('true');
    expect(action.textContent).toBe('正在打开…');
    finish();
    await expect(presented).resolves.toBe('acted');
  });
});
