import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ViceMeClient } from '../../../src/core/client.ts';
import { createViceMe } from '../../../src/index.ts';
import { mountTip } from '../../../src/tip/index.ts';
import { FRAME_READY_TIMEOUT_MS, mount } from '../../../src/tip/mount.ts';

const WORK_ID = '00000000-0000-4000-8000-000000000001';
const ORDER_NO = 'VT20260827010203abcdef123456';

function client(region: 'cn' | 'global' = 'cn'): ViceMeClient {
  return createViceMe({ workKey: 'wrk_test', region });
}

function setIframePageLoading(disabled: boolean): void {
  const testWindow = window as unknown as {
    happyDOM: { settings: { disableIframePageLoading: boolean } };
  };
  testWindow.happyDOM.settings.disableIframePageLoading = disabled;
}

function mountedFrame(): HTMLIFrameElement {
  const portal = document.querySelector<HTMLElement>('[data-viceme-tip="mounted"]');
  if (!portal) throw new TypeError('Tip portal missing');
  const frame = portal.shadowRoot?.querySelector<HTMLIFrameElement>('iframe');
  if (!frame) throw new TypeError('Tip frame missing');
  return frame;
}

function frameMessage(
  frame: HTMLIFrameElement,
  data: Record<string, unknown>,
  origin = 'https://viceme.cn',
  source: MessageEventSource | null = frame.contentWindow,
): void {
  window.dispatchEvent(new MessageEvent('message', { origin, source, data }));
}

async function completeMount<T>(
  pending: Promise<T>,
  height = 420,
): Promise<{
  frame: HTMLIFrameElement;
  handle: T;
}> {
  await vi.waitFor(() =>
    expect(document.querySelector('[data-viceme-tip="mounted"]')).not.toBeNull(),
  );
  const frame = mountedFrame();
  frameMessage(frame, { type: 'viceme:widget-resize', workId: WORK_ID, height });
  return { frame, handle: await pending };
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
  document.body.replaceChildren();
  setIframePageLoading(false);
  vi.restoreAllMocks();
});

describe('tip mount', () => {
  it('reuses an ESM handle for the same client and target, then permits remounting', async () => {
    const sdkClient = client();
    const firstPending = mountTip(sdkClient, { target: document.body, theme: 'auto' });
    const secondPending = mountTip(sdkClient, { target: document.body, theme: 'dark' });
    const { handle: first } = await completeMount(firstPending);

    expect(await secondPending).toBe(first);
    expect(document.querySelectorAll('[data-viceme-tip="mounted"]')).toHaveLength(1);

    first.destroy();
    const { handle: remounted } = await completeMount(
      mountTip(sdkClient, { target: document.body, theme: 'light' }),
    );
    expect(remounted).not.toBe(first);
    remounted.destroy();
    sdkClient.destroy();
  });

  it('mounts the registered-origin widget with payment-safe iframe attributes', async () => {
    const { frame, handle } = await completeMount(
      mount(client(), { target: document.body, theme: 'dark' }),
      512,
    );

    expect(handle.capability).toBe('tip');
    expect(frame.src).toBe('https://viceme.cn/widget/tip/wrk_test?appearance=dark');
    expect(frame.referrerPolicy).toBe('strict-origin');
    expect(frame.getAttribute('sandbox')).toBe(
      'allow-forms allow-popups allow-popups-to-escape-sandbox allow-same-origin allow-scripts',
    );
    expect(frame.getAttribute('allow')).toBe('payment');
    expect(frame.style.height).toBe('512px');
    expect(frame.style.pointerEvents).toBe('auto');

    handle.destroy();
  });

  it('waits for a trusted, bounded resize and binds later messages to its work', async () => {
    const pending = mount(client(), { target: document.body, theme: 'light' });
    await vi.waitFor(() =>
      expect(document.querySelector('[data-viceme-tip="mounted"]')).not.toBeNull(),
    );
    const frame = mountedFrame();
    let resolved = false;
    void pending.then(() => {
      resolved = true;
    });

    frameMessage(
      frame,
      { type: 'viceme:widget-resize', workId: WORK_ID, height: 420 },
      'https://attacker.example',
    );
    frameMessage(frame, { type: 'viceme:widget-resize', workId: WORK_ID, height: 0 });
    frameMessage(
      frame,
      { type: 'viceme:widget-resize', workId: WORK_ID, height: 420 },
      'https://viceme.cn',
      {} as Window,
    );
    await Promise.resolve();
    expect(resolved).toBe(false);
    expect(frame.style.pointerEvents).toBe('none');

    frameMessage(frame, { type: 'viceme:widget-resize', workId: WORK_ID, height: 420 });
    const handle = await pending;
    expect(frame.style.pointerEvents).toBe('auto');

    frameMessage(frame, {
      type: 'viceme:widget-resize',
      workId: '00000000-0000-4000-8000-000000000002',
      height: 800,
    });
    expect(frame.style.height).toBe('420px');
    handle.destroy();
  });

  it('redispatches only validated close and paid fields', async () => {
    const close = vi.fn();
    const paid = vi.fn();
    document.body.addEventListener('viceme:widget-close', close);
    document.body.addEventListener('viceme:tip-paid', paid);
    const { frame, handle } = await completeMount(
      mount(client(), { target: document.body, theme: 'light' }),
    );

    frameMessage(frame, { type: 'viceme:widget-close', workId: WORK_ID, token: 'secret' });
    frameMessage(frame, {
      type: 'viceme:tip-paid',
      workId: WORK_ID,
      orderNo: ORDER_NO,
      status: 'PAID',
      amountCents: 520,
      accessToken: 'secret',
    });
    frameMessage(frame, {
      type: 'viceme:tip-paid',
      workId: WORK_ID,
      orderNo: ORDER_NO,
      status: 'PENDING',
      amountCents: 520,
    });

    expect((close.mock.calls[0]![0] as CustomEvent).detail).toEqual({ workId: WORK_ID });
    expect((paid.mock.calls[0]![0] as CustomEvent).detail).toEqual({
      workId: WORK_ID,
      orderNo: ORDER_NO,
      status: 'PAID',
      amountCents: 520,
    });
    expect(close).toHaveBeenCalledOnce();
    expect(paid).toHaveBeenCalledOnce();
    handle.destroy();
  });

  it('tracks auto appearance and removes the media listener on destroy', async () => {
    let changeListener: ((event: MediaQueryListEvent) => void) | undefined;
    const media = {
      matches: true,
      addEventListener: vi.fn((_type: string, listener: (event: MediaQueryListEvent) => void) => {
        changeListener = listener;
      }),
      removeEventListener: vi.fn(),
    } as unknown as MediaQueryList;
    vi.spyOn(window, 'matchMedia').mockReturnValue(media);

    const { frame, handle } = await completeMount(
      mount(client(), { target: document.body, theme: 'auto' }),
    );
    expect(new URL(frame.src).searchParams.get('appearance')).toBe('dark');

    changeListener?.({ matches: false } as MediaQueryListEvent);
    expect(frame.contentWindow?.postMessage).toHaveBeenCalledWith(
      { type: 'viceme:widget-appearance', appearance: 'light' },
      'https://viceme.cn',
    );
    expect(frame.style.colorScheme).toBe('light');

    handle.destroy();
    expect(media.removeEventListener).toHaveBeenCalledWith('change', changeListener);
  });

  it('uses and removes the legacy media listener when EventTarget methods are unavailable', async () => {
    let changeListener: ((event: MediaQueryListEvent) => void) | undefined;
    const media = {
      matches: false,
      addListener: vi.fn((listener: (event: MediaQueryListEvent) => void) => {
        changeListener = listener;
      }),
      removeListener: vi.fn(),
    } as unknown as MediaQueryList;
    vi.spyOn(window, 'matchMedia').mockReturnValue(media);

    const { frame, handle } = await completeMount(
      mount(client(), { target: document.body, theme: 'auto' }),
    );
    changeListener?.({ matches: true } as MediaQueryListEvent);
    expect(frame.style.colorScheme).toBe('dark');

    handle.destroy();
    expect(media.removeListener).toHaveBeenCalledWith(changeListener);
  });

  it('aborts a pending mount immediately and permits a fresh mount', async () => {
    const sdkClient = client();
    const controller = new AbortController();
    const pending = mountTip(sdkClient, {
      target: document.body,
      theme: 'auto',
      signal: controller.signal,
    });
    const rejection = expect(pending).rejects.toMatchObject({ code: 'CLIENT_DESTROYED' });
    await vi.waitFor(() =>
      expect(document.querySelector('[data-viceme-tip="mounted"]')).not.toBeNull(),
    );

    controller.abort();
    await rejection;
    expect(document.querySelector('[data-viceme-tip="mounted"]')).toBeNull();

    const { handle } = await completeMount(
      mountTip(sdkClient, { target: document.body, theme: 'light' }),
    );
    handle.destroy();
    sdkClient.destroy();
  });

  it('removes a partial mount when the widget never proves its origin', async () => {
    vi.useFakeTimers();
    const pending = mount(client(), { target: document.body, theme: 'auto' });
    const rejection = expect(pending).rejects.toMatchObject({
      capability: 'tip',
      code: 'INTERNAL_ERROR',
      retryable: true,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(document.querySelector('[data-viceme-tip="mounted"]')).not.toBeNull();

    await vi.advanceTimersByTimeAsync(FRAME_READY_TIMEOUT_MS);
    await rejection;
    expect(document.querySelector('[data-viceme-tip="mounted"]')).toBeNull();
  });

  it('uses the global widget origin and fails closed for an unsupported client', async () => {
    const globalPending = mount(client('global'), { target: document.body, theme: 'light' });
    await vi.waitFor(() =>
      expect(document.querySelector('[data-viceme-tip="mounted"]')).not.toBeNull(),
    );
    const frame = mountedFrame();
    frameMessage(
      frame,
      { type: 'viceme:widget-resize', workId: WORK_ID, height: 420 },
      'https://viceme.ai',
    );
    const globalHandle = await globalPending;
    expect(frame.src).toContain('https://viceme.ai/widget/tip/wrk_test');
    globalHandle.destroy();

    const unsupported = {
      version: '0.3.0',
      workKey: 'wrk_test',
      region: 'cn',
      state: 'READY',
      ready: vi.fn(async () => undefined),
      hasCapability: () => false,
      destroy: vi.fn(),
    } as unknown as ViceMeClient;
    await expect(
      mount(unsupported, { target: document.body, theme: 'auto' }),
    ).rejects.toMatchObject({ code: 'CAPABILITY_DISABLED', capability: 'tip' });
  });
});
