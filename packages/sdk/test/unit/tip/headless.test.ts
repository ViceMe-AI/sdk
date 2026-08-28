import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ViceMeClient } from '../../../src/core/client.ts';
import { createViceMe } from '../../../src/index.ts';
import { createTip, type TipConfig } from '../../../src/tip/index.ts';

const TIP_CONFIG: TipConfig = {
  work: {
    id: '00000000-0000-4000-8000-000000000001',
    title: 'Test work',
  },
  workKey: 'wrk_test_demo',
  environment: 'SANDBOX',
  currency: 'CNY',
  amount: {
    minCents: 100,
    maxCents: 20_000,
    stepCents: 1,
  },
  providers: ['WECHAT_PAY', 'ALIPAY'],
};
const CHANNEL = '11111111111111111111111111111111';

function configResponse(body: unknown = TIP_CONFIG, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  if (!headers.has('content-type')) headers.set('content-type', 'application/json');
  return new Response(JSON.stringify(body), { ...init, status: init.status ?? 200, headers });
}

function setIframePageLoading(disabled: boolean): void {
  const testWindow = window as unknown as {
    happyDOM: { settings: { disableIframePageLoading: boolean } };
  };
  testWindow.happyDOM.settings.disableIframePageLoading = disabled;
}

function findHeadlessFrame(): HTMLIFrameElement | null {
  const portal = document.querySelector<HTMLElement>('[data-viceme-tip-headless="open"]');
  return (
    portal?.shadowRoot?.querySelector<HTMLIFrameElement>('iframe[src*="mode=headless"]') ?? null
  );
}

function headlessFrame(): HTMLIFrameElement {
  const frame = findHeadlessFrame();
  if (!frame) throw new TypeError('Headless Tip frame missing');
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

function readyMessage(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'viceme:tip-headless-ready',
    channel: CHANNEL,
    workKey: 'wrk_test_demo',
    ...overrides,
  };
}

beforeEach(() => {
  setIframePageLoading(true);
  document.documentElement.lang = 'zh-CN';
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => configResponse()),
  );
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(window.crypto, 'getRandomValues').mockImplementation(function <
    T extends ArrayBufferView | null,
  >(array: T): T {
    if (array) new Uint8Array(array.buffer, array.byteOffset, array.byteLength).fill(0x11);
    return array;
  });
  vi.spyOn(window, 'matchMedia').mockReturnValue({ matches: false } as MediaQueryList);
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
  document.documentElement.removeAttribute('lang');
  setIframePageLoading(false);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('TipClient.getConfig', () => {
  it('fetches and returns a strictly parsed config without credentials', async () => {
    const fetchMock = vi.fn(async () => configResponse());
    vi.stubGlobal('fetch', fetchMock);
    const client = createViceMe({ workKey: 'wrk_test_demo', region: 'cn' });
    const tip = createTip(client);

    await expect(tip.getConfig()).resolves.toEqual(TIP_CONFIG);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://viceme.cn/v1/work-sdk/wrk_test_demo/tip-config',
      expect.objectContaining({
        method: 'GET',
        credentials: 'omit',
        redirect: 'error',
        headers: { accept: 'application/json' },
        signal: expect.any(AbortSignal),
      }),
    );

    tip.destroy();
    client.destroy();
  });

  it('accepts a live key only with server-authoritative PRODUCTION config', async () => {
    const productionConfig: TipConfig = {
      ...TIP_CONFIG,
      workKey: 'wrk_live_demo',
      environment: 'PRODUCTION',
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => configResponse(productionConfig)),
    );
    const client = createViceMe({ workKey: 'wrk_live_demo', region: 'cn' });
    const tip = createTip(client);

    await expect(tip.getConfig()).resolves.toEqual(productionConfig);

    tip.destroy();
    client.destroy();
  });

  it.each([
    ['wrk_test_demo', 'PRODUCTION'],
    ['wrk_live_demo', 'SANDBOX'],
  ] as const)('rejects environment %s key/config inconsistency', async (workKey, environment) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => configResponse({ ...TIP_CONFIG, workKey, environment })),
    );
    const client = createViceMe({ workKey, region: 'cn' });
    const tip = createTip(client);

    await expect(tip.getConfig()).rejects.toMatchObject({
      code: 'TIP_CONFIG_INVALID',
      retryable: false,
    });

    tip.destroy();
    client.destroy();
  });

  it.each([
    ['unknown top-level field', { ...TIP_CONFIG, orderNo: 'must-not-pass' }],
    [
      'unknown nested field',
      { ...TIP_CONFIG, work: { ...TIP_CONFIG.work, creatorId: 'must-not-pass' } },
    ],
    [
      'changed amount contract',
      { ...TIP_CONFIG, amount: { ...TIP_CONFIG.amount, maxCents: 20_001 } },
    ],
    ['unknown provider', { ...TIP_CONFIG, providers: ['WECHAT_PAY', 'CARD'] }],
    ['duplicate provider', { ...TIP_CONFIG, providers: ['WECHAT_PAY', 'WECHAT_PAY'] }],
    ['missing provider', { ...TIP_CONFIG, providers: [] }],
    ['invalid work id', { ...TIP_CONFIG, work: { ...TIP_CONFIG.work, id: 'not-a-uuid' } }],
    ['blank work title', { ...TIP_CONFIG, work: { ...TIP_CONFIG.work, title: '' } }],
    ['mismatched work key', { ...TIP_CONFIG, workKey: 'wrk_other' }],
  ])('rejects %s in an untrusted response', async (_case, body) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => configResponse(body)),
    );
    const client = createViceMe({ workKey: 'wrk_test_demo', region: 'cn' });
    const tip = createTip(client);

    await expect(tip.getConfig()).rejects.toMatchObject({
      code: 'TIP_CONFIG_INVALID',
      retryable: false,
      capability: 'tip',
    });

    tip.destroy();
    client.destroy();
  });

  it('counts Work title limits by Unicode code point', async () => {
    const validTitle = '😀'.repeat(200);
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(
          configResponse({ ...TIP_CONFIG, work: { ...TIP_CONFIG.work, title: validTitle } }),
        )
        .mockResolvedValueOnce(
          configResponse({ ...TIP_CONFIG, work: { ...TIP_CONFIG.work, title: `${validTitle}😀` } }),
        ),
    );
    const firstClient = createViceMe({ workKey: 'wrk_test_demo', region: 'cn' });
    const firstTip = createTip(firstClient);
    await expect(firstTip.getConfig()).resolves.toMatchObject({ work: { title: validTitle } });
    firstTip.destroy();
    firstClient.destroy();

    const secondClient = createViceMe({ workKey: 'wrk_test_demo', region: 'cn' });
    const secondTip = createTip(secondClient);
    await expect(secondTip.getConfig()).rejects.toMatchObject({ code: 'TIP_CONFIG_INVALID' });
    secondTip.destroy();
    secondClient.destroy();
  });

  it.each([
    ['non-200 status', configResponse(TIP_CONFIG, { status: 201 })],
    [
      'non-JSON content type',
      configResponse(TIP_CONFIG, { headers: { 'content-type': 'text/plain' } }),
    ],
  ])('rejects a %s response before parsing its body', async (_case, response) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response),
    );
    const client = createViceMe({ workKey: 'wrk_test_demo', region: 'cn' });
    const tip = createTip(client);

    await expect(tip.getConfig()).rejects.toMatchObject({ capability: 'tip' });

    tip.destroy();
    client.destroy();
  });

  it('rejects a response whose final URL leaves the configured Shop Origin', async () => {
    const response = configResponse();
    Object.defineProperty(response, 'url', { value: 'https://attacker.example/tip-config' });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response),
    );
    const client = createViceMe({ workKey: 'wrk_test_demo', region: 'cn' });
    const tip = createTip(client);

    await expect(tip.getConfig()).rejects.toMatchObject({ code: 'TIP_CONFIG_INVALID' });

    tip.destroy();
    client.destroy();
  });

  it('cancels an unfinished error response body', async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(body, { status: 500, headers: { 'content-type': 'application/json' } }),
      ),
    );
    const client = createViceMe({ workKey: 'wrk_test_demo', region: 'cn' });
    const tip = createTip(client);

    await expect(tip.getConfig()).rejects.toMatchObject({ code: 'INTERNAL_ERROR' });
    expect(cancelled).toBe(true);

    tip.destroy();
    client.destroy();
  });

  it('reports an unavailable GLOBAL capability locally with a stable error', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const client = createViceMe({ workKey: 'wrk_test_demo', region: 'global' });
    const tip = createTip(client);

    await expect(tip.getConfig()).rejects.toMatchObject({
      code: 'CAPABILITY_DISABLED',
      retryable: false,
      capability: 'tip',
    });
    expect(fetchMock).not.toHaveBeenCalled();

    tip.destroy();
    client.destroy();
  });

  it('keeps legacy Work keys valid for other capabilities but rejects them for Headless Tip', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const client = createViceMe({ workKey: 'wrk_public_demo', region: 'cn' });
    const tip = createTip(client);

    await expect(tip.getConfig()).rejects.toMatchObject({
      code: 'CAPABILITY_DISABLED',
      retryable: false,
      capability: 'tip',
    });
    expect(fetchMock).not.toHaveBeenCalled();

    tip.destroy();
    client.destroy();
  });

  it('fails closed after destroy without reaching the network', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const client = createViceMe({ workKey: 'wrk_test_demo', region: 'cn' });
    const tip = createTip(client);

    tip.destroy();

    await expect(tip.getConfig()).rejects.toMatchObject({
      code: 'CLIENT_DESTROYED',
      retryable: false,
    });
    expect(fetchMock).not.toHaveBeenCalled();
    client.destroy();
  });

  it('normalizes network failures without exposing transport details', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Promise.reject(new Error('secret transport detail'))),
    );
    const client = createViceMe({ workKey: 'wrk_test_demo', region: 'cn' });
    const tip = createTip(client);

    const error = await tip.getConfig().catch((reason: unknown) => reason);
    expect(error).toMatchObject({ code: 'INTERNAL_ERROR', retryable: true, capability: 'tip' });
    expect(String(error)).not.toContain('secret transport detail');

    tip.destroy();
    client.destroy();
  });

  it('keeps the timeout active while reading the response body', async () => {
    vi.useFakeTimers();
    let requestSignal: AbortSignal | undefined;
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestSignal = init?.signal ?? undefined;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          requestSignal?.addEventListener(
            'abort',
            () => controller.error(new DOMException('aborted', 'AbortError')),
            { once: true },
          );
        },
      });
      return new Response(body, {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = createViceMe({ workKey: 'wrk_test_demo', region: 'cn' });
    const tip = createTip(client);
    const pending = tip.getConfig();
    const rejection = expect(pending).rejects.toMatchObject({
      code: 'INTERNAL_ERROR',
      retryable: true,
      capability: 'tip',
    });

    await vi.advanceTimersByTimeAsync(8_000);

    await rejection;
    expect(requestSignal?.aborted).toBe(true);
    tip.destroy();
    client.destroy();
  });

  it('rejects a config response body larger than the public boundary', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(`${' '.repeat(16_385)}${JSON.stringify(TIP_CONFIG)}`, {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      ),
    );
    const client = createViceMe({ workKey: 'wrk_test_demo', region: 'cn' });
    const tip = createTip(client);

    await expect(tip.getConfig()).rejects.toMatchObject({
      code: 'TIP_CONFIG_INVALID',
      retryable: false,
      capability: 'tip',
    });

    tip.destroy();
    client.destroy();
  });

  it('aborts an in-flight config request when destroyed', async () => {
    let requestSignal: AbortSignal | undefined;
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          requestSignal = init?.signal ?? undefined;
          requestSignal?.addEventListener(
            'abort',
            () => reject(new DOMException('aborted', 'AbortError')),
            { once: true },
          );
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const client = createViceMe({ workKey: 'wrk_test_demo', region: 'cn' });
    const tip = createTip(client);
    const pending = tip.getConfig();
    const rejection = expect(pending).rejects.toMatchObject({
      code: 'CLIENT_DESTROYED',
      retryable: false,
    });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());

    tip.destroy();

    expect(requestSignal?.aborted).toBe(true);
    await rejection;
    client.destroy();
  });

  it('fails without a request when the client build lacks Tip', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const unsupported: ViceMeClient = {
      version: '0.3.0',
      workKey: 'wrk_test_demo',
      region: 'cn',
      state: 'READY',
      ready: vi.fn(async () => undefined),
      hasCapability: () => false,
      destroy: vi.fn(),
    };
    const tip = createTip(unsupported);

    await expect(tip.getConfig()).rejects.toMatchObject({
      code: 'CAPABILITY_DISABLED',
      retryable: false,
      capability: 'tip',
    });
    expect(fetchMock).not.toHaveBeenCalled();
    tip.destroy();
  });
});

describe('TipClient.open', () => {
  it('rejects GLOBAL before creating a frame or reaching the network', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const client = createViceMe({ workKey: 'wrk_test_demo', region: 'global' });
    const tip = createTip(client);

    await expect(tip.open({ amountCents: 520 })).rejects.toMatchObject({
      code: 'CAPABILITY_DISABLED',
      retryable: false,
      capability: 'tip',
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(findHeadlessFrame()).toBeNull();

    tip.destroy();
    client.destroy();
  });

  it('synchronously opens a payment-safe frame and returns only a trusted PAID result', async () => {
    const fetchMock = vi.fn(async () => configResponse());
    vi.stubGlobal('fetch', fetchMock);
    const client = createViceMe({ workKey: 'wrk_test_demo', region: 'cn' });
    const tip = createTip(client);
    const exposedConfig = await tip.getConfig();
    exposedConfig.work.title = 'Host mutation must not become trusted';

    const pending = tip.open({
      amountCents: 520,
      provider: 'WECHAT_PAY',
      locale: 'en-US',
      appearance: 'dark',
    });
    const frame = headlessFrame();
    const portal = document.querySelector<HTMLElement>('[data-viceme-tip-headless="open"]');

    expect(portal?.shadowRoot?.mode).toBe('open');
    expect(frame.src).toBe(
      `https://viceme.cn/widget/tip/wrk_test_demo?mode=headless&channel=${CHANNEL}&appearance=dark&locale=en-US`,
    );
    expect(frame.referrerPolicy).toBe('strict-origin');
    expect(frame.getAttribute('sandbox')).toBe(
      'allow-forms allow-popups allow-popups-to-escape-sandbox allow-same-origin allow-scripts',
    );
    expect(frame.getAttribute('allow')).toBe('payment');
    expect(frame.contentWindow?.postMessage).not.toHaveBeenCalled();

    frameMessage(frame, readyMessage());
    await vi.waitFor(() =>
      expect(frame.contentWindow?.postMessage).toHaveBeenCalledWith(
        {
          type: 'viceme:tip-headless-init',
          channel: CHANNEL,
          workKey: 'wrk_test_demo',
          amountCents: 520,
          provider: 'WECHAT_PAY',
          locale: 'en-US',
          appearance: 'dark',
        },
        'https://viceme.cn',
      ),
    );
    frameMessage(frame, {
      type: 'viceme:tip-headless-result',
      channel: CHANNEL,
      workKey: 'wrk_test_demo',
      status: 'PAID',
      work: TIP_CONFIG.work,
      amountCents: 520,
      currency: 'CNY',
    });

    await expect(pending).resolves.toEqual({
      status: 'PAID',
      work: TIP_CONFIG.work,
      amountCents: 520,
      currency: 'CNY',
    });
    expect(frame.isConnected).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    tip.destroy();
    client.destroy();
  });

  it('opens on public HTTP pages where crypto.randomUUID is unavailable', async () => {
    vi.spyOn(window.crypto, 'randomUUID').mockImplementation(() => {
      throw new TypeError('randomUUID requires a secure context');
    });
    const client = createViceMe({ workKey: 'wrk_test_demo', region: 'cn' });
    const tip = createTip(client);
    const pending = tip.open({ amountCents: 520 });
    const frame = headlessFrame();

    expect(new URL(frame.src).searchParams.get('channel')).toBe(CHANNEL);
    frameMessage(frame, readyMessage());
    await vi.waitFor(() => expect(frame.contentWindow?.postMessage).toHaveBeenCalledOnce());

    tip.destroy();
    await expect(pending).resolves.toEqual({ status: 'UNKNOWN' });
    client.destroy();
  });

  it('refreshes the trusted config for open after the Work title changes', async () => {
    const currentConfig: TipConfig = {
      ...TIP_CONFIG,
      work: { ...TIP_CONFIG.work, title: 'Current work title' },
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(configResponse())
      .mockResolvedValueOnce(configResponse(currentConfig));
    vi.stubGlobal('fetch', fetchMock);
    const client = createViceMe({ workKey: 'wrk_test_demo', region: 'cn' });
    const tip = createTip(client);
    await tip.getConfig();

    const pending = tip.open({ amountCents: 520, provider: 'ALIPAY' });
    const frame = headlessFrame();
    frameMessage(frame, readyMessage());
    await vi.waitFor(() => expect(frame.contentWindow?.postMessage).toHaveBeenCalledOnce());
    frameMessage(frame, {
      type: 'viceme:tip-headless-result',
      channel: CHANNEL,
      workKey: 'wrk_test_demo',
      status: 'PAID',
      work: currentConfig.work,
      amountCents: 520,
      currency: 'CNY',
    });

    await expect(pending).resolves.toEqual({
      status: 'PAID',
      work: currentConfig.work,
      amountCents: 520,
      currency: 'CNY',
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(frame.isConnected).toBe(false);
    tip.destroy();
    client.destroy();
  });

  it('rejects a provider removed after getConfig without leaving a portal', async () => {
    const currentConfig: TipConfig = { ...TIP_CONFIG, providers: ['ALIPAY'] };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(configResponse())
      .mockResolvedValueOnce(configResponse(currentConfig));
    vi.stubGlobal('fetch', fetchMock);
    const client = createViceMe({ workKey: 'wrk_test_demo', region: 'cn' });
    const tip = createTip(client);
    await tip.getConfig();

    const pending = tip.open({ amountCents: 520, provider: 'WECHAT_PAY' });
    const frame = headlessFrame();
    frameMessage(frame, readyMessage());

    await expect(pending).rejects.toMatchObject({
      code: 'CONFIG_INVALID',
      retryable: false,
      capability: 'tip',
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(frame.isConnected).toBe(false);
    tip.destroy();
    client.destroy();
  });

  it('ignores forged ready and result messages before accepting an exact result', async () => {
    const client = createViceMe({ workKey: 'wrk_test_demo', region: 'cn' });
    const tip = createTip(client);
    const pending = tip.open({ amountCents: 520, appearance: 'light', locale: 'zh-CN' });
    const frame = headlessFrame();
    const wrongSource = {} as Window;

    frameMessage(frame, readyMessage(), 'https://attacker.example');
    frameMessage(frame, readyMessage(), 'https://viceme.cn', wrongSource);
    frameMessage(frame, readyMessage({ channel: 'wrong' }));
    frameMessage(frame, readyMessage({ workKey: 'wrk_other' }));
    expect(frame.contentWindow?.postMessage).not.toHaveBeenCalled();

    frameMessage(frame, readyMessage());
    await vi.waitFor(() => expect(frame.contentWindow?.postMessage).toHaveBeenCalledOnce());
    const validPaid = {
      type: 'viceme:tip-headless-result',
      channel: CHANNEL,
      workKey: 'wrk_test_demo',
      status: 'PAID',
      work: TIP_CONFIG.work,
      amountCents: 520,
      currency: 'CNY',
    };
    frameMessage(frame, validPaid, 'https://attacker.example');
    frameMessage(frame, validPaid, 'https://viceme.cn', wrongSource);
    frameMessage(frame, { ...validPaid, channel: 'wrong' });
    frameMessage(frame, { ...validPaid, workKey: 'wrk_other' });
    frameMessage(frame, { ...validPaid, amountCents: 521 });
    frameMessage(frame, { ...validPaid, currency: 'USD' });
    frameMessage(frame, { ...validPaid, work: { ...TIP_CONFIG.work, id: 'wrong' } });
    frameMessage(frame, { ...validPaid, work: { ...TIP_CONFIG.work, title: 'Wrong work' } });
    frameMessage(frame, { ...validPaid, orderNo: 'VT-secret' });
    let settled = false;
    void pending.finally(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(frame.isConnected).toBe(true);

    frameMessage(frame, validPaid);
    await expect(pending).resolves.toEqual({
      status: 'PAID',
      work: TIP_CONFIG.work,
      amountCents: 520,
      currency: 'CNY',
    });

    tip.destroy();
    client.destroy();
  });

  it('returns an exact CANCELLED result', async () => {
    const client = createViceMe({ workKey: 'wrk_test_demo', region: 'cn' });
    const tip = createTip(client);
    const pending = tip.open({ amountCents: 520, appearance: 'light', locale: 'zh-CN' });
    const frame = headlessFrame();

    frameMessage(frame, readyMessage());
    await vi.waitFor(() => expect(frame.contentWindow?.postMessage).toHaveBeenCalledOnce());
    frameMessage(frame, {
      type: 'viceme:tip-headless-result',
      channel: CHANNEL,
      workKey: 'wrk_test_demo',
      status: 'CANCELLED',
    });

    await expect(pending).resolves.toEqual({ status: 'CANCELLED' });
    tip.destroy();
    client.destroy();
  });

  it('keeps UNKNOWN open so the same channel can still report PAID', async () => {
    const client = createViceMe({ workKey: 'wrk_test_demo', region: 'cn' });
    const tip = createTip(client);
    const pending = tip.open({ amountCents: 520, appearance: 'light', locale: 'zh-CN' });
    const frame = headlessFrame();

    frameMessage(frame, readyMessage());
    await vi.waitFor(() => expect(frame.contentWindow?.postMessage).toHaveBeenCalledOnce());
    frameMessage(frame, {
      type: 'viceme:tip-headless-result',
      channel: CHANNEL,
      workKey: 'wrk_test_demo',
      status: 'UNKNOWN',
    });
    let settled = false;
    void pending.finally(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(frame.isConnected).toBe(true);

    frameMessage(frame, {
      type: 'viceme:tip-headless-result',
      channel: CHANNEL,
      workKey: 'wrk_test_demo',
      status: 'PAID',
      work: TIP_CONFIG.work,
      amountCents: 520,
      currency: 'CNY',
    });
    await expect(pending).resolves.toEqual({
      status: 'PAID',
      work: TIP_CONFIG.work,
      amountCents: 520,
      currency: 'CNY',
    });
    tip.destroy();
    client.destroy();
  });

  it('resolves an in-flight call as UNKNOWN when destroyed and remains idempotent', async () => {
    const client = createViceMe({ workKey: 'wrk_test_demo', region: 'cn' });
    const tip = createTip(client);
    const pending = tip.open({ amountCents: 520 });
    const frame = headlessFrame();

    tip.destroy();
    tip.destroy();

    await expect(pending).resolves.toEqual({ status: 'UNKNOWN' });
    expect(frame.isConnected).toBe(false);
    await expect(tip.open({ amountCents: 520 })).rejects.toMatchObject({
      code: 'CLIENT_DESTROYED',
      retryable: false,
    });
    client.destroy();
  });

  it('rejects concurrent calls with one stable non-retryable error', async () => {
    const client = createViceMe({ workKey: 'wrk_test_demo', region: 'cn' });
    const tip = createTip(client);
    const first = tip.open({ amountCents: 520 });

    await expect(tip.open({ amountCents: 620 })).rejects.toMatchObject({
      code: 'TIP_OPEN_IN_PROGRESS',
      retryable: false,
      capability: 'tip',
    });
    expect(document.querySelectorAll('[data-viceme-tip-headless="open"]')).toHaveLength(1);
    expect(findHeadlessFrame()).not.toBeNull();

    tip.destroy();
    await expect(first).resolves.toEqual({ status: 'UNKNOWN' });
    client.destroy();
  });

  it('cleans up and rejects with a stable error when ready times out', async () => {
    vi.useFakeTimers();
    const client = createViceMe({ workKey: 'wrk_test_demo', region: 'cn' });
    const tip = createTip(client);
    const pending = tip.open({ amountCents: 520 });
    const frame = headlessFrame();
    const rejection = expect(pending).rejects.toMatchObject({
      code: 'TIP_READY_TIMEOUT',
      retryable: true,
      capability: 'tip',
    });

    await vi.runAllTimersAsync();

    await rejection;
    expect(frame.isConnected).toBe(false);
    tip.destroy();
    client.destroy();
  });

  it('resolves auto appearance before putting it on the security boundary', async () => {
    vi.mocked(window.matchMedia).mockReturnValue({ matches: true } as MediaQueryList);
    const client = createViceMe({ workKey: 'wrk_test_demo', region: 'cn' });
    const tip = createTip(client);
    const pending = tip.open({ amountCents: 520, appearance: 'auto' });
    const frame = headlessFrame();

    expect(new URL(frame.src).searchParams.get('appearance')).toBe('dark');
    expect(new URL(frame.src).searchParams.get('locale')).toBe('zh-CN');
    frameMessage(frame, readyMessage());
    await vi.waitFor(() =>
      expect(frame.contentWindow?.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ appearance: 'dark', locale: 'zh-CN' }),
        'https://viceme.cn',
      ),
    );

    tip.destroy();
    await expect(pending).resolves.toEqual({ status: 'UNKNOWN' });
    client.destroy();
  });

  it('defaults locale from the host document rather than the market region', async () => {
    document.documentElement.lang = 'en-GB';
    const client = createViceMe({ workKey: 'wrk_test_demo', region: 'cn' });
    const tip = createTip(client);
    const pending = tip.open({ amountCents: 520, appearance: 'light' });
    const frame = headlessFrame();

    expect(new URL(frame.src).searchParams.get('locale')).toBe('en-US');
    frameMessage(frame, readyMessage());
    await vi.waitFor(() =>
      expect(frame.contentWindow?.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ locale: 'en-US' }),
        'https://viceme.cn',
      ),
    );

    tip.destroy();
    await expect(pending).resolves.toEqual({ status: 'UNKNOWN' });
    client.destroy();
  });

  it.each([
    ['metadata', { amountCents: 520, metadata: { source: 'host' } }],
    ['scene', { amountCents: 520, scene: 'checkout' }],
    ['fractional amount', { amountCents: 520.5 }],
    ['too-small amount', { amountCents: 99 }],
    ['unknown provider', { amountCents: 520, provider: 'CARD' }],
    ['unknown locale', { amountCents: 520, locale: 'fr-FR' }],
    ['unknown appearance', { amountCents: 520, appearance: 'system' }],
  ])('rejects invalid option: %s without creating a frame', async (_case, options) => {
    const client = createViceMe({ workKey: 'wrk_test_demo', region: 'cn' });
    const tip = createTip(client);

    await expect(tip.open(options as never)).rejects.toMatchObject({
      code: 'CONFIG_INVALID',
      retryable: false,
      capability: 'tip',
    });
    expect(findHeadlessFrame()).toBeNull();

    tip.destroy();
    client.destroy();
  });
});
