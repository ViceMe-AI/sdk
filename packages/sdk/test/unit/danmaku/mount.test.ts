import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createViceMe } from '../../../src/index.ts';
import type { ViceMeClient } from '../../../src/core/client.ts';
import { mount } from '../../../src/danmaku/mount.ts';

function client(region: 'cn' | 'global' = 'cn'): ViceMeClient {
  return createViceMe({ workKey: 'wrk_test', region });
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
  document.documentElement.removeAttribute('lang');
  window.history.replaceState(null, '', '/');
  setIframePageLoading(false);
  vi.restoreAllMocks();
});

describe('danmaku mount', () => {
  it('mounts isolated stage, controls, and lazy modal frames with a public work key', async () => {
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
    expect(frames[0]?.referrerPolicy).toBe('no-referrer');
    expect(frames[1]?.title).toBe('ViceMe Danmaku controls');
    expect(frames[1]?.style.pointerEvents).toBe('auto');
    expect(frames[2]?.getAttribute('src')).toBe('about:blank');
    expect(frames[2]?.dataset.src).toContain('mode=modal');

    handle.destroy();
    expect(document.querySelector('[data-viceme-danmaku="mounted"]')).toBeNull();
  });

  it('waits for hosted frames before posting anchor updates', async () => {
    const postMessage = vi.fn();
    vi.spyOn(HTMLIFrameElement.prototype, 'contentWindow', 'get').mockReturnValue({
      postMessage,
    } as unknown as Window);
    const handle = await mount(client(), { target: document.body, theme: 'auto' });
    const frames = Array.from(
      document
        .querySelector<HTMLElement>('[data-viceme-danmaku="mounted"]')!
        .shadowRoot!.querySelectorAll<HTMLIFrameElement>('iframe'),
    );

    frames[2]?.dispatchEvent(new Event('load'));
    expect(postMessage).not.toHaveBeenCalled();

    frames[0]?.dispatchEvent(new Event('load'));
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'anchor-change' }),
      'https://viceme.cn',
    );

    handle.destroy();
  });

  it('opens, resizes, and closes the hosted modal only for validated frame messages', async () => {
    const frameWindows = new WeakMap<HTMLIFrameElement, Window>();
    vi.spyOn(HTMLIFrameElement.prototype, 'contentWindow', 'get').mockImplementation(function (
      this: HTMLIFrameElement,
    ) {
      let value = frameWindows.get(this);
      if (!value) {
        value = { postMessage: vi.fn() } as unknown as Window;
        frameWindows.set(this, value);
      }
      return value;
    });
    const handle = await mount(client(), { target: document.body, theme: 'auto' });
    const frames = Array.from(
      document
        .querySelector<HTMLElement>('[data-viceme-danmaku="mounted"]')!
        .shadowRoot!.querySelectorAll<HTMLIFrameElement>('iframe'),
    );
    const controls = frames[1]!;
    const modal = frames[2]!;

    window.dispatchEvent(
      new MessageEvent('message', {
        origin: 'https://attacker.example',
        source: controls.contentWindow,
        data: { source: 'viceme-danmaku', action: 'open-modal' },
      }),
    );
    expect(modal.style.display).toBe('none');

    window.dispatchEvent(
      new MessageEvent('message', {
        origin: 'https://viceme.cn',
        source: controls.contentWindow,
        data: { source: 'viceme-danmaku', action: 'resize-controls', height: 999 },
      }),
    );
    expect(controls.style.height).toContain('360px');

    window.dispatchEvent(
      new MessageEvent('message', {
        origin: 'https://viceme.cn',
        source: controls.contentWindow,
        data: { source: 'viceme-danmaku', action: 'open-modal' },
      }),
    );
    expect(modal.src).toContain('mode=modal');
    expect(modal.style.display).toBe('block');

    window.dispatchEvent(
      new MessageEvent('message', {
        origin: 'https://viceme.cn',
        source: modal.contentWindow,
        data: { source: 'viceme-danmaku', action: 'close-modal' },
      }),
    );
    expect(modal.style.display).toBe('none');

    handle.destroy();
  });

  it('removes every host listener, timer, and portal idempotently', async () => {
    const removeEventListener = vi.spyOn(window, 'removeEventListener');
    const clearInterval = vi.spyOn(window, 'clearInterval');
    const handle = await mount(client(), { target: document.body, theme: 'auto' });

    handle.destroy();
    handle.destroy();

    expect(clearInterval).toHaveBeenCalledOnce();
    for (const event of ['message', 'scroll', 'resize', 'popstate', 'hashchange']) {
      expect(removeEventListener).toHaveBeenCalledWith(event, expect.any(Function));
    }
    expect(document.querySelector('[data-viceme-danmaku="mounted"]')).toBeNull();
  });

  it('fails closed when a non-danmaku client is supplied', async () => {
    const unsupported: ViceMeClient = {
      workKey: 'wrk_test',
      region: 'cn',
      state: 'READY',
      ready: vi.fn(async () => undefined),
      hasCapability: () => false,
      destroy: vi.fn(),
    };

    await expect(
      mount(unsupported, { target: document.body, theme: 'auto' }),
    ).rejects.toMatchObject({
      code: 'CAPABILITY_DISABLED',
      capability: 'danmaku',
    });
    expect(document.querySelector('[data-viceme-danmaku="mounted"]')).toBeNull();
  });

  it('uses the global hosted origin for global works', async () => {
    const handle = await mount(client('global'), { target: document.body, theme: 'auto' });
    const stage = document
      .querySelector<HTMLElement>('[data-viceme-danmaku="mounted"]')!
      .shadowRoot!.querySelector<HTMLIFrameElement>('iframe[data-mode="stage"]')!;

    expect(stage.src).toContain('https://viceme.ai/embed/danmaku?');
    handle.destroy();
  });

  it('prefers the host document language over the browser language', async () => {
    document.documentElement.lang = 'zh-CN';
    const handle = await mount(client(), { target: document.body, theme: 'auto' });
    const stage = document
      .querySelector<HTMLElement>('[data-viceme-danmaku="mounted"]')!
      .shadowRoot!.querySelector<HTMLIFrameElement>('iframe[data-mode="stage"]')!;

    expect(new URL(stage.src).searchParams.get('locale')).toBe('zh-CN');
    handle.destroy();
  });
});
