import { describe, expect, it, vi } from 'vitest';
import { dispatchViceMeEvent, type VicemeReadyDetail } from '../../../src/loader/events.ts';

describe('dispatchViceMeEvent', () => {
  it('dispatches viceme:ready with only allowlisted fields', () => {
    const host = document.createElement('div');
    const listener = vi.fn();
    host.addEventListener('viceme:ready', listener);

    const detail: VicemeReadyDetail & Record<string, unknown> = {
      clientKey: 'v1+cn+wrk_test_demo',
      workKey: 'wrk_test_demo',
      capabilities: ['fixture'],
      version: '0.1.0',
      // Extra fields must be stripped by the sanitizer.
      token: 'leak',
    };
    dispatchViceMeEvent(host, 'viceme:ready', detail);

    expect(listener).toHaveBeenCalledTimes(1);
    const received = (listener.mock.calls[0]![0] as CustomEvent).detail;
    expect(received).toEqual({
      clientKey: 'v1+cn+wrk_test_demo',
      workKey: 'wrk_test_demo',
      capabilities: ['fixture'],
      version: '0.1.0',
    });
  });

  it('bubbles and is composed (listen from document for a host element)', () => {
    const host = document.createElement('div');
    document.body.append(host);
    const listener = vi.fn();
    document.addEventListener('viceme:capability-ready', listener);

    dispatchViceMeEvent(host, 'viceme:capability-ready', {
      clientKey: 'v1+cn+wrk_test_demo',
      instanceKey: 'v1+cn+wrk_test_demo::fixture::el1',
      capability: 'fixture',
      version: '0.1.0',
    });

    expect(listener).toHaveBeenCalledTimes(1);
    host.remove();
    document.removeEventListener('viceme:capability-ready', listener);
  });

  it('strips undefined optional fields from viceme:error', () => {
    const listener = vi.fn();
    document.addEventListener('viceme:error', listener);
    dispatchViceMeEvent(document, 'viceme:error', {
      code: 'CONFIG_INVALID',
      retryable: false,
    });
    const detail = (listener.mock.calls[0]![0] as CustomEvent).detail;
    expect(Object.keys(detail).sort()).toEqual(['code', 'retryable']);
    document.removeEventListener('viceme:error', listener);
  });

  it('dispatches a sanitized tip payment result', () => {
    const host = document.createElement('div');
    const listener = vi.fn();
    host.addEventListener('viceme:tip-paid', listener);

    dispatchViceMeEvent(host, 'viceme:tip-paid', {
      work: {
        id: '00000000-0000-4000-8000-000000000001',
        title: 'Test work',
        creatorId: 'must-not-leak',
      },
      orderNo: 'VT20260827010203abcdef123456',
      status: 'PAID',
      amountCents: 520,
      currency: 'CNY',
      accessToken: 'must-not-leak',
    } as never);

    expect((listener.mock.calls[0]![0] as CustomEvent).detail).toEqual({
      status: 'PAID',
      work: {
        id: '00000000-0000-4000-8000-000000000001',
        title: 'Test work',
      },
      amountCents: 520,
      currency: 'CNY',
    });
  });
});
