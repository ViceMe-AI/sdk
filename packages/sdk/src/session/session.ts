/**
 * Public visitor session.
 *
 * ```text
 * SDK + workKey + Origin -> POST /v1/public/work-sdk/sessions
 *   -> short-lived capability token -> public capability calls
 * ```
 *
 * The token lives in memory only (never localStorage/cookies), is bound to the
 * Work, Origin, capability set, and expiry by the server, and is dropped on
 * `destroy()`. `workKey` locates the Work — it is never an authorization
 * credential.
 */

import { clientDestroyed, ViceMeError } from '../core/errors.ts';
import type { Transport, TransportRequest, TransportResponse } from '../transport/transport.ts';
export interface CreateWorkSessionRequestDto {
  workKey: string;
}

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
  userToken?: string;
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
  const raw = body as Record<string, unknown>;
  if (
    typeof raw.workKey !== 'string' ||
    !Array.isArray(raw.capabilities) ||
    !raw.capabilities.every((c) => typeof c === 'string')
  ) {
    throw malformedSessionResponse();
  }
  if (raw.workKey !== workKey) {
    throw new ViceMeError({
      code: 'WORK_NOT_FOUND',
      message: 'Work-session response did not match the requested work key.',
      retryable: false,
    });
  }
  const snapshot: WorkSessionSnapshot = {
    work: {
      key: raw.workKey,
      capabilities: raw.capabilities as string[],
    },
  };
  // Unknown extra fields are allowed and ignored (forward compatibility).
  if (typeof raw.token === 'string') snapshot.token = raw.token;
  if (typeof raw.expiresAt === 'string') {
    const expiresAt = new Date(raw.expiresAt).getTime();
    if (!Number.isNaN(expiresAt)) snapshot.expiresAt = expiresAt;
  }
  return snapshot;
}

function malformedSessionResponse(): ViceMeError {
  return new ViceMeError({
    code: 'INTERNAL_ERROR',
    message: 'Malformed work-session response.',
    retryable: true,
  });
}

function sessionInvalidated(): ViceMeError {
  return new ViceMeError({
    code: 'SESSION_EXPIRED',
    message: 'The work session was invalidated before it completed.',
    retryable: true,
  });
}

export class SessionManager {
  readonly #options: SessionManagerOptions;
  readonly #now: () => number;
  #snapshot: WorkSessionSnapshot | undefined;
  #pending: Promise<WorkSessionSnapshot> | undefined;
  #generation = 0;
  #destroyed = false;

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
    if (this.#destroyed) return Promise.reject(clientDestroyed());
    if (this.#snapshot) {
      if (!this.#isExpired()) return Promise.resolve(this.#snapshot);
      this.#snapshot = undefined;
    }
    if (this.#pending) return this.#pending;
    const generation = this.#generation;
    const pending = this.#options.transport
      .request({
        method: 'POST',
        path: '/v1/public/work-sdk/sessions',
        body: { workKey: this.#options.workKey } satisfies CreateWorkSessionRequestDto,
        signal: this.#options.signal,
        timeoutMs: this.#options.timeoutMs,
      })
      .then((response) => {
        this.#assertCurrent(generation);
        const snapshot = parseSessionResponse(response.body, this.#options.workKey);
        this.#assertCurrent(generation);
        this.#snapshot = snapshot;
        return snapshot;
      })
      .finally(() => {
        if (this.#pending === pending) this.#pending = undefined;
      });
    this.#pending = pending;
    return pending;
  }

  async request(
    request: Omit<TransportRequest, 'authorization' | 'userAuthorization' | 'signal'>,
  ): Promise<TransportResponse> {
    const snapshot = await this.establish();
    if (!snapshot.token) throw malformedSessionResponse();
    try {
      return await this.#requestWithSnapshot(request, snapshot);
    } catch (error) {
      if (this.#destroyed) throw clientDestroyed();
      if (!(error instanceof ViceMeError) || error.code !== 'SESSION_EXPIRED') throw error;
      if (this.#snapshot === snapshot) this.invalidate();
      const refreshed = await this.establish();
      if (!refreshed.token) throw malformedSessionResponse();
      return this.#requestWithSnapshot(request, refreshed);
    }
  }

  authenticate(
    input: { userToken: string; user: WorkUser },
    expectedSession: WorkSessionSnapshot,
  ): void {
    this.#assertAlive();
    // An interactive login belongs to the snapshot that initialized its frame.
    // Sign-out, refresh, or another login must supersede that action even when
    // the server happens to reissue the same Work token string.
    if (this.#snapshot !== expectedSession || this.#isExpired()) throw sessionInvalidated();
    this.#snapshot = {
      ...this.#snapshot,
      userToken: input.userToken,
      user: input.user,
    };
  }

  async signOut(): Promise<void> {
    this.#assertAlive();
    this.invalidate();
    await this.establish();
  }

  /** Drop the token; next `establish()` re-authenticates. */
  invalidate(): void {
    this.#generation += 1;
    this.#snapshot = undefined;
    this.#pending = undefined;
  }

  /** Hard cleanup: forget the token and pending work. */
  destroy(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    this.#generation += 1;
    this.#snapshot = undefined;
    this.#pending = undefined;
  }

  #assertAlive(): void {
    if (this.#destroyed) throw clientDestroyed();
  }

  #assertCurrent(generation: number): void {
    this.#assertAlive();
    if (generation !== this.#generation) throw sessionInvalidated();
  }

  async #requestWithSnapshot(
    request: Omit<TransportRequest, 'authorization' | 'userAuthorization' | 'signal'>,
    snapshot: WorkSessionSnapshot,
  ): Promise<TransportResponse> {
    this.#assertAlive();
    try {
      const response = await this.#options.transport.request({
        ...request,
        authorization: snapshot.token,
        userAuthorization: snapshot.userToken,
        signal: this.#options.signal,
      });
      this.#assertAlive();
      return response;
    } catch (error) {
      if (this.#destroyed) throw clientDestroyed();
      throw error;
    }
  }
}
