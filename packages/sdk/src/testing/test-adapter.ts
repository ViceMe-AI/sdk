/**
 * `@viceme-ai/sdk/testing` — explicit test adapter.
 *
 * Deterministic fixture helpers for SDK consumers and capability authors.
 * This code must never be imported from production core, loader, or capability
 * bundles; it is excluded from them at build time and only exported via the
 * `./testing` subpath.
 *
 * The test client runs the exact same config, lifecycle, error, and contract
 * validation as production `createViceMe()` — it is not a bypass mock.
 */

import { configInvalid } from '../core/errors.ts';
import { isValidWorkKey, isValidRegion } from '../core/config.ts';
import { ViceMeClientImpl } from '../core/client.ts';
import type { ViceMeClient } from '../core/client.ts';
import type { ViceMeRegion } from '../core/config.ts';
import type { AccessPresenter } from '../core/presentation.ts';
import type { Transport, TransportRequest, TransportResponse } from '../transport/transport.ts';

export interface MemoryTransportWorkFixture {
  key: string;
  capabilities: string[];
  token?: string;
  expiresAt?: number;
}

export interface MemoryTransportOptions {
  /** Work descriptor served for `POST /v1/public/work-sdk/sessions`. */
  work: MemoryTransportWorkFixture;
  /** Artificial response latency in milliseconds (default 0). */
  latencyMs?: number;
  /**
   * Queue of failures thrown before the fixture response is served; each
   * entry is consumed by one session request. Use for retry/timeout tests.
   */
  sessionFailures?: Array<Error | { status: number; code: string; message?: string }>;
}

export interface MemoryTransport extends Transport {
  /** Every request seen so far, for assertions. */
  readonly requests: TransportRequest[];
}

export function createMemoryTransport(options: MemoryTransportOptions): MemoryTransport {
  const requests: TransportRequest[] = [];
  const failures = [...(options.sessionFailures ?? [])];
  const latencyMs = options.latencyMs ?? 0;

  return {
    requests,
    async request(request: TransportRequest): Promise<TransportResponse> {
      // A pre-aborted signal never counts as an issued request.
      if (request.signal?.aborted) {
        throw new DOMException('Aborted', 'AbortError');
      }
      requests.push(request);
      await new Promise<void>((resolve, reject) => {
        const signal = request.signal;
        const timer = setTimeout(() => resolve(), latencyMs);
        signal?.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            reject(new DOMException('Aborted', 'AbortError'));
          },
          { once: true },
        );
      });
      if (request.path === '/v1/public/work-sdk/sessions' && request.method === 'POST') {
        const failure = failures.shift();
        if (failure) {
          if (failure instanceof Error) throw failure;
          return {
            status: failure.status,
            body: {
              error: { code: failure.code, message: failure.message ?? 'Simulated failure.' },
            },
          };
        }
        return {
          status: 201,
          body: {
            workKey: options.work.key,
            capabilities: [...options.work.capabilities],
            ...(options.work.token !== undefined ? { token: options.work.token } : {}),
            ...(options.work.expiresAt !== undefined
              ? { expiresAt: new Date(options.work.expiresAt).toISOString() }
              : {}),
          },
          requestId: `test-${requests.length}`,
        };
      }
      return {
        status: 404,
        body: { error: { code: 'CONFIG_INVALID', message: `No fixture for ${request.path}.` } },
      };
    },
  };
}

export interface CreateTestViceMeOptions {
  workKey: string;
  region: ViceMeRegion;
  /** Mock transport serving the fixture contract. */
  transport: Transport;
  signal?: AbortSignal;
  presenter?: AccessPresenter;
  /** Stable virtual clock for deterministic time-based assertions. */
  now?: () => number;
}

/**
 * Create a client backed by an injected transport. Runs identical validation
 * and lifecycle logic to `createViceMe()`.
 */
export function createTestViceMe(options: CreateTestViceMeOptions): ViceMeClient {
  if (!isValidWorkKey(options.workKey)) {
    throw configInvalid('Test client requires a valid workKey ("wrk_…").');
  }
  if (!isValidRegion(options.region)) {
    throw configInvalid('Test client requires region "cn" or "global".');
  }
  if (typeof options.transport?.request !== 'function') {
    throw configInvalid('Test client requires a transport with a request() method.');
  }
  return new ViceMeClientImpl({
    config: {
      workKey: options.workKey,
      region: options.region,
      signal: options.signal,
    },
    transport: options.transport,
    presenter: options.presenter,
    ...(options.now !== undefined ? { now: options.now } : {}),
  });
}

/** Standard fixture work used across repo tests and examples. */
export const FIXTURE_WORK: MemoryTransportWorkFixture = {
  key: 'wrk_test',
  capabilities: ['fixture'],
  token: 'test-session-token',
};
