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
    expect(layer?.shadowRoot?.querySelector("[part='panel']")?.getAttribute('role')).toBe('dialog');
    expect(layer?.shadowRoot?.querySelector("[part='action']")?.textContent).toBe('关注创作者');

    (layer?.shadowRoot?.querySelector("[part='dismiss']") as HTMLButtonElement).click();

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

    (layer?.shadowRoot?.querySelector("[part='action']") as HTMLButtonElement).click();
    await vi.waitFor(() => {
      expect(layer?.shadowRoot?.querySelector('iframe')?.getAttribute('src')).toBe(
        'about:blank#checkout',
      );
    });
    complete();

    await expect(presented).resolves.toBe('acted');
  });
});
