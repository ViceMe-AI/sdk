import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ViceMeClient } from '../../../src/core/client.ts';
import { mount } from '../../../src/danmaku/mount.ts';

function client(capabilities: string[] = ['danmaku']): ViceMeClient {
  return {
    version: '0.1.6',
    workKey: 'wrk_test',
    region: 'cn',
    state: 'READY',
    auth: {} as ViceMeClient['auth'],
    access: {} as ViceMeClient['access'],
    checkout: {} as ViceMeClient['checkout'],
    ready: vi.fn(async () => undefined),
    hasCapability: (name) => capabilities.includes(name),
    destroy: vi.fn(),
  };
}

function setIframePageLoading(disabled: boolean): void {
  const testWindow = window as unknown as {
    happyDOM: { settings: { disableIframePageLoading: boolean } };
  };
  testWindow.happyDOM.settings.disableIframePageLoading = disabled;
}

beforeEach(() => {
  setIframePageLoading(true);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  document.body.innerHTML = '';
  window.history.replaceState(null, '', '/');
  setIframePageLoading(false);
  vi.restoreAllMocks();
});

describe('danmaku mount', () => {
  it('mounts isolated stage, controls, and lazy modal frames with a workKey', async () => {
    window.history.replaceState(null, '', '/demo?private=value#/chapter/1');
    const handle = await mount(client(), { target: document.body, theme: 'dark' });

    const portal = document.querySelector<HTMLElement>('[data-viceme-danmaku="mounted"]');
    const frames = Array.from(portal!.shadowRoot!.querySelectorAll('iframe'));
    expect(handle.capability).toBe('danmaku');
    expect(frames).toHaveLength(3);
    expect(frames[0]?.title).toBe('ViceMe Danmaku');
    expect(frames[0]?.style.pointerEvents).toBe('none');
    expect(frames[0]?.src).toContain('https://viceme.cn/embed/danmaku?');
    expect(frames[0]?.src).toContain('workKey=wrk_test');
    expect(frames[0]?.src).toContain('mode=stage');
    expect(frames[0]?.src).toContain('anchorKey=page%3A');
    expect(frames[0]?.src).not.toContain('private');
    expect(frames[1]?.title).toBe('ViceMe Danmaku controls');
    expect(frames[1]?.style.pointerEvents).toBe('auto');
    expect(frames[2]?.getAttribute('src')).toBe('about:blank');
    expect(frames[2]?.dataset.src).toContain('mode=modal');

    handle.destroy();
    expect(document.querySelector('[data-viceme-danmaku="mounted"]')).toBeNull();
  });

  it('fails closed when the work does not enable danmaku', async () => {
    await expect(mount(client([]), { target: document.body, theme: 'auto' })).rejects.toMatchObject(
      {
        code: 'CAPABILITY_DISABLED',
        capability: 'danmaku',
      },
    );
    expect(document.querySelector('[data-viceme-danmaku="mounted"]')).toBeNull();
  });

  it('uses the global hosted origin for global works', async () => {
    const globalClient = { ...client(), region: 'global' as const };
    const handle = await mount(globalClient, { target: document.body, theme: 'auto' });
    const stage = document
      .querySelector<HTMLElement>('[data-viceme-danmaku="mounted"]')!
      .shadowRoot!.querySelector<HTMLIFrameElement>('iframe[data-mode="stage"]')!;

    expect(stage.src).toContain('https://viceme.ai/embed/danmaku?');
    handle.destroy();
  });
});
