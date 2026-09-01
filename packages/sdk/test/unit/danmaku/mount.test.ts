import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createViceMe } from '../../../src/index.ts';
import type { ViceMeClient } from '../../../src/core/client.ts';
import { mountDanmaku } from '../../../src/danmaku/index.ts';
import { FRAME_READY_TIMEOUT_MS, mount } from '../../../src/danmaku/mount.ts';

function client(region: 'cn' | 'global' = 'cn'): ViceMeClient {
  return createViceMe({ workKey: 'wrk_test_demo', region });
}

function setIframePageLoading(disabled: boolean): void {
  const testWindow = window as unknown as {
    happyDOM: { settings: { disableIframePageLoading: boolean } };
  };
  testWindow.happyDOM.settings.disableIframePageLoading = disabled;
}

async function mountedFrames(): Promise<HTMLIFrameElement[]> {
  await vi.waitFor(() => {
    expect(document.querySelector('[data-viceme-danmaku="mounted"]')).not.toBeNull();
  });
  return Array.from(
    document
      .querySelector<HTMLElement>('[data-viceme-danmaku="mounted"]')!
      .shadowRoot!.querySelectorAll<HTMLIFrameElement>('iframe'),
  );
}

function frameMessage(
  frame: HTMLIFrameElement,
  data: Record<string, unknown>,
  origin = 'https://viceme.cn',
): void {
  window.dispatchEvent(
    new MessageEvent('message', {
      origin,
      source: frame.contentWindow,
      data: { source: 'viceme-danmaku', ...data },
    }),
  );
}

async function completeMount<T>(pending: Promise<T>): Promise<{
  frames: HTMLIFrameElement[];
  handle: T;
}> {
  const frames = await mountedFrames();
  frameMessage(frames[0]!, { action: 'frame-ready', mode: 'stage' });
  frameMessage(frames[1]!, { action: 'frame-ready', mode: 'controls' });
  return { frames, handle: await pending };
}

beforeEach(() => {
  setIframePageLoading(true);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
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
});

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = '';
  document.documentElement.removeAttribute('lang');
  window.history.replaceState(null, '', '/');
  setIframePageLoading(false);
  vi.restoreAllMocks();
});

describe('danmaku mount', () => {
  it('reuses an ESM handle for the same client and target, then permits remounting', async () => {
    const sdkClient = client();
    const firstPending = mountDanmaku(sdkClient, { target: document.body, theme: 'auto' });
    const secondPending = mountDanmaku(sdkClient, { target: document.body, theme: 'dark' });
    const { handle: first } = await completeMount(firstPending);
    const second = await secondPending;

    expect(second).toBe(first);
    expect(document.querySelectorAll('[data-viceme-danmaku="mounted"]')).toHaveLength(1);

    first.destroy();
    const { handle: remounted } = await completeMount(
      mountDanmaku(sdkClient, {
        target: document.body,
        theme: 'light',
      }),
    );
    expect(remounted).not.toBe(first);
    expect(document.querySelectorAll('[data-viceme-danmaku="mounted"]')).toHaveLength(1);

    remounted.destroy();
    sdkClient.destroy();
  });

  it('does not retain a failed ESM mount registration', async () => {
    let enabled = false;
    const sdkClient = {
      version: '0.3.0',
      workKey: 'wrk_test_demo',
      region: 'cn',
      state: 'READY',
      ready: vi.fn(async () => undefined),
      hasCapability: () => enabled,
      destroy: vi.fn(),
    } as unknown as ViceMeClient;

    await expect(
      mountDanmaku(sdkClient, { target: document.body, theme: 'auto' }),
    ).rejects.toMatchObject({ code: 'CAPABILITY_DISABLED' });

    enabled = true;
    const { handle: mounted } = await completeMount(
      mountDanmaku(sdkClient, {
        target: document.body,
        theme: 'auto',
      }),
    );
    expect(document.querySelectorAll('[data-viceme-danmaku="mounted"]')).toHaveLength(1);
    mounted.destroy();
  });

  it('mounts isolated stage, controls, and lazy modal frames with a public work key', async () => {
    window.history.replaceState(null, '', '/demo?private=value#/chapter/1');
    const { frames, handle } = await completeMount(
      mount(client(), { target: document.body, theme: 'dark' }),
    );
    expect(handle.capability).toBe('danmaku');
    expect(frames).toHaveLength(3);
    expect(frames[0]?.title).toBe('ViceMe Danmaku');
    expect(frames[0]?.style.pointerEvents).toBe('none');
    expect(frames[0]?.src).toContain('https://viceme.cn/embed/danmaku?');
    expect(frames[0]?.src).toContain('workKey=wrk_test_demo');
    expect(frames[0]?.src).toContain('mode=stage');
    expect(frames[0]?.src).toContain('anchorKey=page%3A');
    expect(frames[0]?.src).not.toContain('private');
    expect(frames[0]?.referrerPolicy).toBe('no-referrer');
    expect(frames[1]?.title).toBe('ViceMe Danmaku controls');
    expect(frames[1]?.style.pointerEvents).toBe('auto');
    expect(frames[1]?.style.maxWidth).toBe('480px');
    expect(frames[1]?.style.height).toBe('56px');
    expect(frames[2]?.getAttribute('src')).toBe('about:blank');
    expect(frames[2]?.dataset.src).toContain('mode=modal');

    handle.destroy();
    expect(document.querySelector('[data-viceme-danmaku="mounted"]')).toBeNull();
  });

  it('waits for trusted stage and controls readiness before enabling controls', async () => {
    const pending = mount(client(), { target: document.body, theme: 'auto' });
    const frames = await mountedFrames();
    const controls = frames[1]!;
    let resolved = false;
    void pending.then(() => {
      resolved = true;
    });

    expect(controls.style.pointerEvents).toBe('none');
    frameMessage(frames[0]!, { action: 'frame-ready', mode: 'stage' }, 'https://attacker.example');
    frameMessage(controls, { action: 'frame-ready', mode: 'stage' });
    await Promise.resolve();
    expect(resolved).toBe(false);

    frameMessage(frames[0]!, { action: 'frame-ready', mode: 'stage' });
    await Promise.resolve();
    expect(controls.style.pointerEvents).toBe('none');
    expect(resolved).toBe(false);

    frameMessage(controls, { action: 'frame-ready', mode: 'controls' });
    const handle = await pending;
    expect(controls.style.pointerEvents).toBe('auto');
    handle.destroy();
  });

  it('rejects readiness timeout and removes the entire partial mount', async () => {
    vi.useFakeTimers();
    const removeEventListener = vi.spyOn(window, 'removeEventListener');
    const pending = mount(client(), { target: document.body, theme: 'auto' });
    const rejection = expect(pending).rejects.toMatchObject({
      capability: 'danmaku',
      code: 'INTERNAL_ERROR',
      retryable: true,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(document.querySelector('[data-viceme-danmaku="mounted"]')).not.toBeNull();

    await vi.advanceTimersByTimeAsync(FRAME_READY_TIMEOUT_MS);
    await rejection;
    expect(document.querySelector('[data-viceme-danmaku="mounted"]')).toBeNull();
    expect(removeEventListener).toHaveBeenCalledWith('message', expect.any(Function));
  });

  it('waits for hosted frames before posting anchor updates', async () => {
    const postMessage = vi.fn();
    const frameWindows = new WeakMap<HTMLIFrameElement, Window>();
    vi.spyOn(HTMLIFrameElement.prototype, 'contentWindow', 'get').mockImplementation(function (
      this: HTMLIFrameElement,
    ) {
      let value = frameWindows.get(this);
      if (!value) {
        value = { postMessage } as unknown as Window;
        frameWindows.set(this, value);
      }
      return value;
    });
    const { frames, handle } = await completeMount(
      mount(client(), { target: document.body, theme: 'auto' }),
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
    const { frames, handle } = await completeMount(
      mount(client(), { target: document.body, theme: 'auto' }),
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
        data: {
          source: 'viceme-danmaku',
          action: 'resize-controls',
          width: 480,
          height: 999,
        },
      }),
    );
    expect(controls.style.height).toBe('56px');

    frameMessage(controls, {
      action: 'resize-controls',
      width: 352,
      height: 328,
    });
    expect(controls.style.width).toBe('352px');
    expect(controls.style.height).toBe('328px');

    window.dispatchEvent(
      new MessageEvent('message', {
        origin: 'https://viceme.cn',
        source: controls.contentWindow,
        data: { source: 'viceme-danmaku', action: 'open-modal' },
      }),
    );
    expect(modal.src).toContain('mode=modal');
    expect(modal.style.display).toBe('block');
    expect(modal.style.pointerEvents).toBe('none');

    frameMessage(controls, { action: 'close-modal' });
    expect(modal.style.display).toBe('none');
    expect(modal.getAttribute('src')).toBe('about:blank');

    frameMessage(controls, { action: 'open-modal' });
    expect(modal.src).toContain('frameToken=2');

    frameMessage(modal, {
      action: 'frame-ready',
      frameToken: new URL(modal.src).searchParams.get('frameToken'),
      mode: 'modal',
    });
    expect(modal.style.pointerEvents).toBe('auto');

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
    const { handle } = await completeMount(
      mount(client(), { target: document.body, theme: 'auto' }),
    );

    handle.destroy();
    handle.destroy();

    expect(clearInterval).toHaveBeenCalledOnce();
    for (const event of ['message', 'scroll', 'resize', 'popstate', 'hashchange']) {
      expect(removeEventListener).toHaveBeenCalledWith(event, expect.any(Function));
    }
    expect(document.querySelector('[data-viceme-danmaku="mounted"]')).toBeNull();
  });

  it('fails closed when a non-danmaku client is supplied', async () => {
    const unsupported = {
      version: '0.3.0',
      workKey: 'wrk_test_demo',
      region: 'cn',
      state: 'READY',
      ready: vi.fn(async () => undefined),
      hasCapability: () => false,
      destroy: vi.fn(),
    } as unknown as ViceMeClient;

    await expect(
      mount(unsupported, { target: document.body, theme: 'auto' }),
    ).rejects.toMatchObject({
      code: 'CAPABILITY_DISABLED',
      capability: 'danmaku',
    });
    expect(document.querySelector('[data-viceme-danmaku="mounted"]')).toBeNull();
  });

  it('uses the global hosted origin for global works', async () => {
    const pending = mount(client('global'), { target: document.body, theme: 'auto' });
    const frames = await mountedFrames();
    frameMessage(frames[0]!, { action: 'frame-ready', mode: 'stage' }, 'https://viceme.ai');
    frameMessage(frames[1]!, { action: 'frame-ready', mode: 'controls' }, 'https://viceme.ai');
    const handle = await pending;
    const stage = document
      .querySelector<HTMLElement>('[data-viceme-danmaku="mounted"]')!
      .shadowRoot!.querySelector<HTMLIFrameElement>('iframe[data-mode="stage"]')!;

    expect(stage.src).toContain('https://viceme.ai/embed/danmaku?');
    handle.destroy();
  });

  it('prefers the host document language over the browser language', async () => {
    document.documentElement.lang = 'zh-CN';
    const { handle } = await completeMount(
      mount(client(), { target: document.body, theme: 'auto' }),
    );
    const stage = document
      .querySelector<HTMLElement>('[data-viceme-danmaku="mounted"]')!
      .shadowRoot!.querySelector<HTMLIFrameElement>('iframe[data-mode="stage"]')!;

    expect(new URL(stage.src).searchParams.get('locale')).toBe('zh-CN');
    handle.destroy();
  });
});
