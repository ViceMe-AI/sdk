/**
 * Public visitor session.
 *
 * ```text
 * SDK + workKey + Origin -> POST /v1/public/v1/work-sessions
 *   -> short-lived capability token -> public capability calls
 * ```
 *
 * The token lives in memory only (never localStorage/cookies), is bound to the
 * Work, Origin, capability set, and expiry by the server, and is dropped on
 * `destroy()`. `workKey` locates the Work — it is never an authorization
 * credential.
 */

import { ViceMeError } from '../core/errors.ts';
import type { Transport, TransportRequest, TransportResponse } from '../transport/transport.ts';
import type { components } from '../generated/public-contract.ts';

/**
 * DTO shapes come from the generated public contract snapshot — the SDK never
 * hand-writes a second copy of the server DTOs. The runtime validator below
 * stays intentionally narrow (required fields of the current contract only).
 */
type WorkSessionDto = components['schemas']['WorkSession'];
export type CreateWorkSessionRequestDto = components['schemas']['CreateWorkSessionRequest'];

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
  user?: WorkUser;
}

export interface WorkUser {
  subject: string;
  nickname: string | null;
  avatarUrl: string | null;
}

export interface SessionManagerOptions {
  workKey: string;
  transport: Transport;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Injectable clock for tests. */
  now?: () => number;
}

function parseSessionResponse(body: unknown, workKey: string): WorkSessionSnapshot {
  if (typeof body !== 'object' || body === null) {
    throw malformedSessionResponse();
  }
  const raw = body as WorkSessionDto;
  const work = raw.work as { key?: unknown; capabilities?: unknown } | undefined;
  if (
    typeof work !== 'object' ||
    work === null ||
    typeof work.key !== 'string' ||
    !Array.isArray(work.capabilities) ||
    !work.capabilities.every((c) => typeof c === 'string')
  ) {
    throw malformedSessionResponse();
  }
  if (work.key !== workKey) {
    throw new ViceMeError({
      code: 'WORK_NOT_FOUND',
      message: 'Work-session response did not match the requested work key.',
      retryable: false,
    });
  }
  const snapshot: WorkSessionSnapshot = {
    work: {
      key: work.key,
      capabilities: work.capabilities as string[],
    },
  };
  // Unknown extra fields are allowed and ignored (forward compatibility).
  if (typeof raw.token === 'string') snapshot.token = raw.token;
  if (typeof raw.expiresAt === 'number') snapshot.expiresAt = raw.expiresAt;
  return snapshot;
}

function malformedSessionResponse(): ViceMeError {
  return new ViceMeError({
    code: 'INTERNAL_ERROR',
    message: 'Malformed work-session response.',
    retryable: true,
  });
}

export class SessionManager {
  readonly #options: SessionManagerOptions;
  readonly #now: () => number;
  #snapshot: WorkSessionSnapshot | undefined;
  #pending: Promise<WorkSessionSnapshot> | undefined;

  constructor(options: SessionManagerOptions) {
    this.#options = options;
    this.#now = options.now ?? (() => Date.now());
  }

  get snapshot(): WorkSessionSnapshot | undefined {
    return this.#snapshot;
  }

  /** True when the cached snapshot's server-provided expiry has passed. */
  #isExpired(): boolean {
    const expiresAt = this.#snapshot?.expiresAt;
    return expiresAt !== undefined && expiresAt <= this.#now();
  }

  /**
   * Establish (or return the established) public session.
   *
   * A cached snapshot is reused only while it is unexpired; an expired
   * snapshot is dropped and re-authenticated. Concurrent callers share one
   * in-flight request (single flight).
   */
  establish(): Promise<WorkSessionSnapshot> {
    if (this.#snapshot) {
      if (!this.#isExpired()) return Promise.resolve(this.#snapshot);
      this.#snapshot = undefined;
    }
    this.#pending ??= this.#options.transport
      .request({
        method: 'POST',
        path: '/v1/public/v1/work-sessions',
        body: { workKey: this.#options.workKey } satisfies CreateWorkSessionRequestDto,
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

  async request(
    request: Omit<TransportRequest, 'authorization' | 'signal'>,
  ): Promise<TransportResponse> {
    const snapshot = await this.establish();
    if (!snapshot.token) throw malformedSessionResponse();
    return this.#options.transport.request({
      ...request,
      authorization: snapshot.token,
      signal: this.#options.signal,
    });
  }

  authenticate(input: { token: string; expiresAt: number; user: WorkUser }): void {
    if (!this.#snapshot) throw malformedSessionResponse();
    this.#snapshot = {
      ...this.#snapshot,
      token: input.token,
      expiresAt: input.expiresAt,
      user: input.user,
    };
  }

  async signOut(): Promise<void> {
    this.invalidate();
    await this.establish();
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
