/**
 * Public visitor session.
 *
 * ```text
 * SDK + workKey + Origin -> POST /public/v1/work-sessions
 *   -> short-lived capability token -> public capability calls
 * ```
 *
 * The token lives in memory only (never localStorage/cookies), is bound to the
 * Work, Origin, capability set, and expiry by the server, and is dropped on
 * `destroy()`. `workKey` locates the Work — it is never an authorization
 * credential.
 */

import { ViceMeError } from '../core/errors.ts';
import type { Transport } from '../transport/transport.ts';

export interface WorkDescriptor {
  key: string;
  /** Capability names enabled for this work. */
  capabilities: string[];
}

export interface WorkSessionSnapshot {
  work: WorkDescriptor;
  /** Opaque short-lived capability token; memory-only. */
  token?: string;
  /** Epoch milliseconds when the token expires, when provided by the server. */
  expiresAt?: number;
}

export interface SessionManagerOptions {
  workKey: string;
  transport: Transport;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Injectable clock for tests. */
  now?: () => number;
}

interface WorkSessionResponse {
  work?: { key?: unknown; capabilities?: unknown };
  token?: unknown;
  expiresAt?: unknown;
}

function parseSessionResponse(body: unknown, workKey: string): WorkSessionSnapshot {
  if (typeof body !== 'object' || body === null) {
    throw new ViceMeError({
      code: 'INTERNAL_ERROR',
      message: 'Malformed work-session response.',
      retryable: true,
    });
  }
  const raw = body as WorkSessionResponse;
  if (
    typeof raw.work !== 'object' ||
    raw.work === null ||
    typeof raw.work.key !== 'string' ||
    !Array.isArray(raw.work.capabilities) ||
    !raw.work.capabilities.every((c) => typeof c === 'string')
  ) {
    throw new ViceMeError({
      code: 'INTERNAL_ERROR',
      message: 'Malformed work-session response.',
      retryable: true,
    });
  }
  if (raw.work.key !== workKey) {
    throw new ViceMeError({
      code: 'WORK_NOT_FOUND',
      message: 'Work-session response did not match the requested work key.',
      retryable: false,
    });
  }
  const snapshot: WorkSessionSnapshot = {
    work: {
      key: raw.work.key,
      capabilities: raw.work.capabilities as string[],
    },
  };
  // Unknown extra fields are allowed and ignored (forward compatibility).
  if (typeof raw.token === 'string') snapshot.token = raw.token;
  if (typeof raw.expiresAt === 'number') snapshot.expiresAt = raw.expiresAt;
  return snapshot;
}

export class SessionManager {
  readonly #options: SessionManagerOptions;
  #snapshot: WorkSessionSnapshot | undefined;
  #pending: Promise<WorkSessionSnapshot> | undefined;

  constructor(options: SessionManagerOptions) {
    this.#options = options;
  }

  get snapshot(): WorkSessionSnapshot | undefined {
    return this.#snapshot;
  }

  /** Establish (or return the established) public session. */
  establish(): Promise<WorkSessionSnapshot> {
    if (this.#snapshot) return Promise.resolve(this.#snapshot);
    this.#pending ??= this.#options.transport
      .request({
        method: 'POST',
        path: '/public/v1/work-sessions',
        body: { workKey: this.#options.workKey },
        signal: this.#options.signal,
        timeoutMs: this.#options.timeoutMs,
      })
      .then((response) => {
        const snapshot = parseSessionResponse(response.body, this.#options.workKey);
        this.#snapshot = snapshot;
        return snapshot;
      })
      .finally(() => {
        this.#pending = undefined;
      });
    return this.#pending;
  }

  /** Drop the token; next `establish()` re-authenticates. */
  invalidate(): void {
    this.#snapshot = undefined;
  }

  /** Hard cleanup: forget the token and pending work. */
  destroy(): void {
    this.invalidate();
    this.#pending = undefined;
  }
}
