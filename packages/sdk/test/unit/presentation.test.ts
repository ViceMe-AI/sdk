import { describe, expect, it, vi } from 'vitest';
import { defaultAccessPresenter } from '../../src/core/presentation.ts';

describe('default access presenter', () => {
  it('renders an in-page Web Component and does not act when dismissed', async () => {
    const perform = vi.fn(async () => {});
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
});
