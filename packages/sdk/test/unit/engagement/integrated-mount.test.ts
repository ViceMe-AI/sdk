import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createViceMe } from '../../../src/index.ts';
import { mountDanmaku } from '../../../src/danmaku/index.ts';
import { mountTip } from '../../../src/tip/index.ts';

const WORK_ID = '00000000-0000-4000-8000-000000000001';
const WORK = { id: WORK_ID, title: 'Integrated work' };

function setIframePageLoading(disabled: boolean): void {
  const testWindow = window as unknown as {
    happyDOM: { settings: { disableIframePageLoading: boolean } };
  };
  testWindow.happyDOM.settings.disableIframePageLoading = disabled;
}

function dispatchFrameMessage(frame: HTMLIFrameElement, data: Record<string, unknown>): void {
  window.dispatchEvent(
    new MessageEvent('message', {
      origin: 'https://viceme.cn',
      source: frame.contentWindow,
      data,
    }),
  );
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
      value = { focus: vi.fn(), postMessage: vi.fn() } as unknown as Window;
      frameWindows.set(this, value);
    }
    return value;
  });
});

afterEach(() => {
  document.body.replaceChildren();
  setIframePageLoading(false);
  vi.restoreAllMocks();
});

describe('integrated danmaku and Tip mount', () => {
  it('uses one bottom interaction bar to open the official Tip dialog', async () => {
    const target = document.createElement('div');
    document.body.append(target);
    const client = createViceMe({ workKey: 'wrk_test_demo', region: 'cn' });

    const danmakuPending = mountDanmaku(client, { target, theme: 'auto' });
    await vi.waitFor(() =>
      expect(target.querySelector('[data-viceme-danmaku="mounted"]')).not.toBeNull(),
    );
    const danmakuPortal = target.querySelector<HTMLElement>('[data-viceme-danmaku="mounted"]')!;
    const danmakuFrames = Array.from(
      danmakuPortal.shadowRoot!.querySelectorAll<HTMLIFrameElement>('iframe'),
    );
    const controls = danmakuFrames[1]!;
    dispatchFrameMessage(danmakuFrames[0]!, {
      source: 'viceme-danmaku',
      action: 'frame-ready',
      mode: 'stage',
    });
    dispatchFrameMessage(controls, {
      source: 'viceme-danmaku',
      action: 'frame-ready',
      mode: 'controls',
    });
    const danmakuHandle = await danmakuPending;

    const tipPending = mountTip(client, {
      target,
      theme: 'auto',
      presentation: 'integrated',
    });
    await vi.waitFor(() =>
      expect(target.querySelector('[data-viceme-tip="mounted"]')).not.toBeNull(),
    );
    const tipPortal = target.querySelector<HTMLElement>('[data-viceme-tip="mounted"]')!;
    const tipFrame = tipPortal.shadowRoot!.querySelector<HTMLIFrameElement>('iframe')!;
    expect(new URL(tipFrame.src).searchParams.get('mode')).toBe('dialog');
    expect(tipPortal.style.display).toBe('none');
    expect(tipFrame.style.height).toBe('100%');

    dispatchFrameMessage(tipFrame, {
      type: 'viceme:widget-resize',
      workId: WORK_ID,
      work: WORK,
      height: 640,
    });
    const tipHandle = await tipPending;

    dispatchFrameMessage(controls, {
      source: 'viceme-engagement',
      action: 'request-tip-availability',
      workKey: 'wrk_test_demo',
    });
    expect(controls.contentWindow?.postMessage).toHaveBeenCalledWith(
      {
        source: 'viceme-engagement',
        action: 'tip-availability',
        available: true,
        workKey: 'wrk_test_demo',
      },
      'https://viceme.cn',
    );

    const focusControls = vi.spyOn(controls, 'focus');
    dispatchFrameMessage(controls, {
      source: 'viceme-engagement',
      action: 'open-tip',
      workKey: 'wrk_test_demo',
    });
    expect(tipPortal.style.display).toBe('block');
    expect(tipFrame.style.pointerEvents).toBe('auto');
    expect(tipFrame.contentWindow?.postMessage).toHaveBeenCalledWith(
      { type: 'viceme:widget-open', workId: WORK_ID },
      'https://viceme.cn',
    );

    dispatchFrameMessage(tipFrame, {
      type: 'viceme:widget-close',
      workId: WORK_ID,
    });
    expect(tipPortal.style.display).toBe('none');
    expect(focusControls).toHaveBeenCalledOnce();

    tipHandle.destroy();
    expect(controls.contentWindow?.postMessage).toHaveBeenLastCalledWith(
      {
        source: 'viceme-engagement',
        action: 'tip-availability',
        available: false,
        workKey: 'wrk_test_demo',
      },
      'https://viceme.cn',
    );
    expect(target.querySelector('[data-viceme-danmaku="mounted"]')).not.toBeNull();

    danmakuHandle.destroy();
    client.destroy();
  });
});
