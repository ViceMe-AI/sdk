/**
 * HTTP transport for the public API.
 *
 * Responsibilities: request execution with timeout, abort, client request ids,
 * and normalization of every failure into the public `ViceMeError` model.
 * Capabilities and the loader never build their own `fetch` calls — they go
 * through a Transport so tests can swap in `createMemoryTransport`.
 */

import { ViceMeError, type ViceMeErrorCode } from '../core/errors.ts';

export interface TransportRequest {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  /** Absolute path under the public API base. */
  path: string;
  /** JSON-serializable request body. */
  body?: unknown;
  /** Work-session token. It is never persisted by the transport. */
  authorization?: string;
  /** Optional memory-only signed-in widget token. */
  userAuthorization?: string;
  signal?: AbortSignal;
  /** Per-request timeout; defaults to the transport default. */
  timeoutMs?: number;
}

export interface TransportResponse {
  status: number;
  body?: unknown;
  /** Echoed server request id, when provided. */
  requestId?: string;
}

export interface Transport {
  request(request: TransportRequest): Promise<TransportResponse>;
}

export interface FetchTransportOptions {
  apiBaseUrl: string;
  /** Injectable for tests; defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
  defaultTimeoutMs?: number;
  /** Injectable id generator (default: `crypto.randomUUID`). */
  generateRequestId?: () => string;
}

const DEFAULT_TIMEOUT_MS = 10_000;

const STATUS_CODE_MAP: ReadonlyMap<number, ViceMeErrorCode> = new Map([
  [400, 'CONFIG_INVALID'],
  [401, 'SESSION_EXPIRED'],
  [403, 'CAPABILITY_DISABLED'],
  [404, 'WORK_NOT_FOUND'],
  [409, 'CONFIG_INVALID'],
  [422, 'CONFIG_INVALID'],
  [429, 'RATE_LIMITED'],
]);

const KNOWN_CODES: ReadonlySet<string> = new Set([
  'CONFIG_INVALID',
  'WORK_NOT_FOUND',
  'CAPABILITY_DISABLED',
  'SESSION_EXPIRED',
  'AUTH_REQUIRED',
  'AUTH_CANCELLED',
  'RETURN_URL_NOT_ALLOWED',
  'RATE_LIMITED',
  'NETWORK_TIMEOUT',
  'CHECKOUT_UNAVAILABLE',
  'INTERNAL_ERROR',
]);

/** Extract a stable error payload from a JSON error body, if well-formed. */
function parseErrorBody(body: unknown): {
  code?: ViceMeErrorCode;
  message?: string;
  retryable?: boolean;
  requestId?: string;
} {
  if (typeof body !== 'object' || body === null) return {};
  const raw = body as Record<string, unknown>;
  const candidate =
    typeof raw.error === 'object' && raw.error !== null
      ? (raw.error as Record<string, unknown>)
      : raw;
  const result: {
    code?: ViceMeErrorCode;
    message?: string;
    retryable?: boolean;
    requestId?: string;
  } = {};
  if (typeof candidate.code === 'string' && KNOWN_CODES.has(candidate.code)) {
    result.code = candidate.code as ViceMeErrorCode;
  }
  if (typeof candidate.message === 'string') {
    result.message = candidate.message.slice(0, 200);
  }
  if (typeof candidate.retryable === 'boolean') {
    result.retryable = candidate.retryable;
  }
  if (typeof candidate.requestId === 'string') {
    result.requestId = candidate.requestId;
  }
  return result;
}

function defaultRequestId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `req-${Math.random().toString(36).slice(2)}`;
}

export class FetchTransport implements Transport {
  readonly #apiBaseUrl: string;
  readonly #fetchImpl: typeof fetch;
  readonly #defaultTimeoutMs: number;
  readonly #generateRequestId: () => string;

  constructor(options: FetchTransportOptions) {
    this.#apiBaseUrl = options.apiBaseUrl.replace(/\/+$/, '');
    this.#fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.#defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#generateRequestId = options.generateRequestId ?? defaultRequestId;
  }

  async request(request: TransportRequest): Promise<TransportResponse> {
    // A pre-aborted signal must never reach the network. Preserve the
    // caller's abort reason when one was set.
    if (request.signal?.aborted) {
      throw this.#callerAbortError(request.signal);
    }
    const timeoutMs = request.timeoutMs ?? this.#defaultTimeoutMs;
    const controller = new AbortController();
    // Engine notes: Chrome/Firefox reject fetch with the abort reason and
    // WebKit may reject with a plain error — so timeout/abort classification
    // keys off our own timer/signal state, never off the exception shape.
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort(new TimeoutAbort());
    }, timeoutMs);
    const onOuterAbort = () => controller.abort(new TimeoutAbort(false));
    request.signal?.addEventListener('abort', onOuterAbort, { once: true });

    const requestId = this.#generateRequestId();
    try {
      const response = await this.#fetchImpl(`${this.#apiBaseUrl}${request.path}`, {
        method: request.method,
        // Public API is CORS-only; credentials must stay off so Shop session
        // cookies can never attach to public SDK requests.
        credentials: 'omit',
        mode: 'cors',
        headers: {
          'content-type': 'application/json',
          'x-client-request-id': requestId,
          ...(request.authorization !== undefined
            ? { authorization: `Bearer ${request.authorization}` }
            : {}),
          ...(request.userAuthorization !== undefined
            ? { 'x-viceme-user-token': request.userAuthorization }
            : {}),
        },
        body: request.body !== undefined ? JSON.stringify(request.body) : undefined,
        signal: controller.signal,
      });

      // Body reading stays inside the same timeout/abort lifecycle: a server
      // that returns headers and then stalls the body still hits
      // NETWORK_TIMEOUT, caller abort still cancels the read, and a late
      // body can never outlive a destroyed client/session.
      let body: unknown;
      try {
        body = await response.json();
      } catch (error) {
        // A malformed/empty body is tolerated; a cancelled read must
        // propagate so the outer handler can classify it.
        if (request.signal?.aborted || timedOut) {
          throw error;
        }
        body = undefined;
      }

      const serverRequestId = response.headers.get('x-request-id') ?? undefined;
      if (!response.ok) {
        const parsed = parseErrorBody(body);
        const code = parsed.code ?? STATUS_CODE_MAP.get(response.status) ?? 'INTERNAL_ERROR';
        throw new ViceMeError({
          code,
          message: parsed.message ?? 'Public API request failed.',
          retryable: parsed.retryable,
          requestId: parsed.requestId ?? serverRequestId,
        });
      }
      return { status: response.status, body, requestId: serverRequestId };
    } catch (cause) {
      if (request.signal?.aborted) {
        throw this.#callerAbortError(request.signal);
      }
      if (timedOut) {
        throw new ViceMeError({
          code: 'NETWORK_TIMEOUT',
          message: 'Public API request timed out.',
          retryable: true,
          requestId,
        });
      }
      // Non-OK statuses already carry a normalized error — pass it through.
      if (cause instanceof ViceMeError) {
        throw cause;
      }
      if (cause instanceof DOMException && cause.name === 'AbortError') {
        throw new DOMException('ViceMe request aborted by caller.', 'AbortError');
      }
      throw new ViceMeError({
        code: 'INTERNAL_ERROR',
        message: 'Public API request failed.',
        retryable: true,
        requestId,
      });
    } finally {
      clearTimeout(timer);
      request.signal?.removeEventListener('abort', onOuterAbort);
    }
  }

  /** Caller-abort error that preserves the caller's own abort reason. */
  #callerAbortError(signal: AbortSignal): unknown {
    return signal.reason instanceof Error
      ? signal.reason
      : new DOMException('ViceMe request aborted by caller.', 'AbortError');
  }
}

export function createFetchTransport(options: FetchTransportOptions): Transport {
  return new FetchTransport(options);
}

/** Internal marker distinguishing timeout aborts from caller aborts. */
class TimeoutAbort extends DOMException {
  constructor(timedOut = true) {
    super(timedOut ? 'ViceMe request timed out.' : 'ViceMe request aborted.', 'AbortError');
  }
}
