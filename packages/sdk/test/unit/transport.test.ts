import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFetchTransport } from '../../src/transport/transport.ts';
import { ViceMeError } from '../../src/core/errors.ts';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function fakeResponse(init: { status?: number; body?: unknown; headers?: Record<string, string> }) {
  return {
    ok: (init.status ?? 200) >= 200 && (init.status ?? 200) < 300,
    status: init.status ?? 200,
    headers: new Headers(init.headers ?? {}),
    async json() {
      return init.body;
    },
  } as unknown as Response;
}

describe('FetchTransport', () => {
  it.each([200, 401])(
    'honors caller cancellation after an HTTP %i body has already parsed',
    async (status) => {
      vi.useFakeTimers();
      const controller = new AbortController();
      const reason = new Error('Host stopped waiting');
      const removeListener = vi.spyOn(controller.signal, 'removeEventListener');
      const response = new Response(JSON.stringify({ ok: true }), { status });
      const readJson = response.json.bind(response);
      vi.spyOn(response, 'json').mockImplementation(() => {
        const parsed = readJson();
        // Parsing can finish before the transport's await continuation runs.
        // Aborting at that boundary cannot reject the already fulfilled body.
        void parsed.then(() => controller.abort(reason));
        return parsed;
      });
      const transport = createFetchTransport({
        apiBaseUrl: 'https://api.viceme.cn',
        fetchImpl: vi.fn(async () => response),
      });

      await expect(
        transport.request({ method: 'GET', path: '/test', signal: controller.signal }),
      ).rejects.toBe(reason);
      expect(removeListener).toHaveBeenCalledWith('abort', expect.any(Function));
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it('honors a deadline reached after parsing but before delivering the response', async () => {
    vi.useFakeTimers();
    const response = new Response(JSON.stringify({ ok: true }));
    const readJson = response.json.bind(response);
    vi.spyOn(response, 'json').mockImplementation(() => {
      const parsed = readJson();
      void parsed.then(() => vi.advanceTimersByTime(10));
      return parsed;
    });
    const transport = createFetchTransport({
      apiBaseUrl: 'https://api.viceme.cn',
      fetchImpl: vi.fn(async () => response),
      defaultTimeoutMs: 10,
      generateRequestId: () => 'deadline-request',
    });

    await expect(transport.request({ method: 'GET', path: '/test' })).rejects.toMatchObject({
      code: 'NETWORK_TIMEOUT',
      retryable: true,
      requestId: 'deadline-request',
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('sends a JSON POST with client request id and omits credentials', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) =>
      fakeResponse({ status: 200, body: { ok: true } }),
    );
    const transport = createFetchTransport({
      apiBaseUrl: 'https://api.viceme.cn/',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const res = await transport.request({
      method: 'POST',
      path: '/v1/public/work-sdk/sessions',
      body: { workKey: 'wrk_test_demo' },
    });

    expect(res.status).toBe(200);
    const call = fetchImpl.mock.calls[0]!;
    const url = call[0] as string;
    const init = call[1] as RequestInit;
    expect(url).toBe('https://api.viceme.cn/v1/public/work-sdk/sessions');
    expect(init.credentials).toBe('omit');
    expect(init.mode).toBe('cors');
    expect((init.headers as Record<string, string>)['content-type']).toBe('application/json');
    expect(typeof (init.headers as Record<string, string>)['x-client-request-id']).toBe('string');
  });

  it('maps non-ok responses through the error body and status map', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) =>
      fakeResponse({
        status: 404,
        body: { error: { code: 'WORK_NOT_FOUND', message: 'no such work' } },
        headers: { 'x-request-id': 'srv-1' },
      }),
    );
    const transport = createFetchTransport({
      apiBaseUrl: 'https://api.viceme.cn',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await expect(
      transport.request({ method: 'POST', path: '/v1/public/work-sdk/sessions' }),
    ).rejects.toSatisfy((err: unknown) => {
      const e = err as ViceMeError;
      return e instanceof ViceMeError && e.code === 'WORK_NOT_FOUND' && e.requestId === 'srv-1';
    });
  });

  it('falls back to INTERNAL_ERROR for unmapped 5xx', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) =>
      fakeResponse({ status: 500, body: {} }),
    );
    const transport = createFetchTransport({
      apiBaseUrl: 'https://api.viceme.cn',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(
      transport.request({ method: 'POST', path: '/v1/public/work-sdk/sessions' }),
    ).rejects.toSatisfy(
      (e: unknown) => (e as ViceMeError).code === 'INTERNAL_ERROR' && (e as ViceMeError).retryable,
    );
  });

  it('rejects with NETWORK_TIMEOUT on timeout', async () => {
    const fetchImpl = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            // Real fetch rejects with the signal's abort reason.
            reject(
              (init.signal as AbortSignal & { reason?: unknown }).reason ??
                new DOMException('timeout', 'AbortError'),
            );
          });
        }),
    );
    const transport = createFetchTransport({
      apiBaseUrl: 'https://api.viceme.cn',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      defaultTimeoutMs: 10,
    });
    await expect(
      transport.request({ method: 'POST', path: '/v1/public/work-sdk/sessions' }),
    ).rejects.toSatisfy((e: unknown) => (e as ViceMeError).code === 'NETWORK_TIMEOUT');
  });

  it('rethrows caller AbortError unchanged', async () => {
    const fetchImpl = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          );
        }),
    );
    const transport = createFetchTransport({
      apiBaseUrl: 'https://api.viceme.cn',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      defaultTimeoutMs: 10_000,
    });
    const controller = new AbortController();
    const p = transport.request({
      method: 'POST',
      path: '/v1/public/work-sdk/sessions',
      signal: controller.signal,
    });
    controller.abort();
    await expect(p).rejects.toSatisfy((e: unknown) => (e as DOMException).name === 'AbortError');
  });

  it('rejects before issuing a request when the signal is already aborted', async () => {
    const fetchImpl = vi.fn();
    const transport = createFetchTransport({
      apiBaseUrl: 'https://api.viceme.cn',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const controller = new AbortController();
    controller.abort(new DOMException('cancelled early', 'AbortError'));

    await expect(
      transport.request({
        method: 'POST',
        path: '/v1/public/work-sdk/sessions',
        signal: controller.signal,
      }),
    ).rejects.toSatisfy((e: unknown) => {
      return (
        e instanceof DOMException && e.name === 'AbortError' && e.message === 'cancelled early'
      );
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('NETWORK_TIMEOUT when the server returns headers but never ends the body', async () => {
    const fetchImpl = vi.fn((_url: string, init: RequestInit) =>
      Promise.resolve({
        ok: true,
        status: 200,
        headers: new Headers(),
        // Real fetch cancels the body stream when the abort signal fires.
        json: () =>
          new Promise<never>((_resolve, reject) => {
            const signal = init.signal;
            if (signal?.aborted) {
              reject(signal.reason ?? new DOMException('aborted', 'AbortError'));
              return;
            }
            signal?.addEventListener(
              'abort',
              () => reject(signal.reason ?? new DOMException('aborted', 'AbortError')),
              { once: true },
            );
          }),
      }),
    );
    const transport = createFetchTransport({
      apiBaseUrl: 'https://api.viceme.cn',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      defaultTimeoutMs: 80,
    });
    await expect(
      transport.request({ method: 'POST', path: '/v1/public/work-sdk/sessions' }),
    ).rejects.toSatisfy((e: unknown) => (e as ViceMeError).code === 'NETWORK_TIMEOUT');
  });

  it('caller abort cancels an in-progress body read', async () => {
    const fetchImpl = vi.fn((_url: string, init: RequestInit) =>
      Promise.resolve({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: () =>
          new Promise<never>((_resolve, reject) => {
            const signal = init.signal;
            if (signal?.aborted) {
              reject(signal.reason ?? new DOMException('aborted', 'AbortError'));
              return;
            }
            signal?.addEventListener(
              'abort',
              () => reject(signal.reason ?? new DOMException('aborted', 'AbortError')),
              { once: true },
            );
          }),
      }),
    );
    const transport = createFetchTransport({
      apiBaseUrl: 'https://api.viceme.cn',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      defaultTimeoutMs: 10_000,
    });
    const controller = new AbortController();
    const pending = transport.request({
      method: 'POST',
      path: '/v1/public/work-sdk/sessions',
      signal: controller.signal,
    });
    // Let the response headers (and the json() reader) attach first.
    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort();
    await expect(pending).rejects.toSatisfy(
      (e: unknown) => (e as DOMException).name === 'AbortError',
    );
  });
});
