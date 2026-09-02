import { afterEach, describe, expect, it, vi } from 'vitest';
// Importing the module runs `bootstrap()` once: with no currentScript and no
// explicit script[data-viceme-loader], it must stay a no-op.
import {
  ensureNamespace,
  runAutoLoader,
  type ViceMeBrowserGlobal,
} from '../../../src/loader/auto-loader.ts';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe('auto-loader module side effects', () => {
  it('does not create the window namespace when no loader script exists', () => {
    // The import-time bootstrap ran against this DOM-less context and must
    // not have registered anything.
    expect((globalThis as { ViceMe?: ViceMeBrowserGlobal }).ViceMe).toBeUndefined();
  });
});

describe('ensureNamespace', () => {
  it('installs a non-enumerable, idempotent v1 namespace', () => {
    const ns = ensureNamespace('0.1.0');
    const holder = globalThis as { ViceMe?: ViceMeBrowserGlobal };
    expect(holder.ViceMe).toBeDefined();
    expect(holder.ViceMe!.versions.v1).toBe(ns);
    expect(ns.version).toBe('0.1.0');

    expect(Object.keys(holder.ViceMe!)).not.toContain('versions');

    // Second install returns the existing namespace.
    expect(ensureNamespace('0.2.0')).toBe(ns);
  });

  it('whenReady rejects for unknown client keys', async () => {
    const ns = ensureNamespace('0.1.0');
    await expect(ns.whenReady('v1+cn+wrk_test_nope')).rejects.toSatisfy((e: unknown) => {
      return (e as { code?: string }).code === 'CONFIG_INVALID';
    });
  });

  it('getInstance/destroyInstance are safe for unknown keys', () => {
    const ns = ensureNamespace('0.1.0');
    expect(ns.getInstance('nope')).toBeUndefined();
    expect(() => ns.destroyInstance('nope')).not.toThrow();
    expect(() => ns.destroyClient('v1+cn+wrk_test_nope')).not.toThrow();
  });
});

describe('manifest request lifecycle', () => {
  it('reports a stalled manifest request as a retryable internal error', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => reject(new DOMException('manifest timed out', 'AbortError')),
            { once: true },
          );
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const target = document.createElement('div');
    target.id = 'loader-request-timeout-target';
    const script = document.createElement('script');
    script.src = 'https://s3.viceme.cn/viceme-sdk/0.6.1/viceme.min.js';
    script.setAttribute('data-viceme-work', 'wrk_test_request_timeout');
    script.setAttribute('data-viceme-region', 'cn');
    script.setAttribute('data-viceme-features', 'danmaku');
    script.setAttribute('data-viceme-target', '#loader-request-timeout-target');
    document.body.append(target);
    const details: unknown[] = [];
    document.addEventListener(
      'viceme:error',
      (event) => details.push((event as CustomEvent<unknown>).detail),
      { once: true },
    );

    const run = runAutoLoader(script);
    await vi.advanceTimersByTimeAsync(8_000);
    await run;

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(details).toEqual([
      expect.objectContaining({
        code: 'INTERNAL_ERROR',
        retryable: true,
        clientKey: 'v1+cn+wrk_test_request_timeout',
      }),
    ]);
  });

  it('times out on engines without AbortSignal.timeout instead of blocking the loader queue', async () => {
    vi.useFakeTimers();
    const timeoutDescriptor = Object.getOwnPropertyDescriptor(AbortSignal, 'timeout');
    Object.defineProperty(AbortSignal, 'timeout', {
      value: undefined,
      configurable: true,
      writable: true,
    });
    try {
      const fetchMock = vi.fn((_url: string | URL | Request, init?: RequestInit) =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            new Promise<unknown>((_resolve, reject) => {
              init?.signal?.addEventListener(
                'abort',
                () => reject(new DOMException('manifest body timed out', 'AbortError')),
                { once: true },
              );
            }),
        } as Response),
      );
      vi.stubGlobal('fetch', fetchMock);
      const target = document.createElement('div');
      target.id = 'loader-timeout-target';
      const script = document.createElement('script');
      script.src = 'https://s3.viceme.cn/viceme-sdk/0.6.1/viceme.min.js';
      script.setAttribute('data-viceme-work', 'wrk_test_timeout');
      script.setAttribute('data-viceme-region', 'cn');
      script.setAttribute('data-viceme-features', 'danmaku');
      script.setAttribute('data-viceme-target', '#loader-timeout-target');
      document.body.append(target);
      const details: unknown[] = [];
      document.addEventListener(
        'viceme:error',
        (event) => details.push((event as CustomEvent<unknown>).detail),
        { once: true },
      );

      const run = runAutoLoader(script);
      await vi.advanceTimersByTimeAsync(8_000);
      await run;

      expect(fetchMock).toHaveBeenCalledOnce();
      expect((fetchMock.mock.calls[0]?.[1] as RequestInit | undefined)?.signal).toBeDefined();
      expect(details).toEqual([
        expect.objectContaining({
          code: 'INTERNAL_ERROR',
          retryable: true,
          clientKey: 'v1+cn+wrk_test_timeout',
        }),
      ]);
    } finally {
      if (timeoutDescriptor) Object.defineProperty(AbortSignal, 'timeout', timeoutDescriptor);
      else delete (AbortSignal as { timeout?: unknown }).timeout;
    }
  });
});
