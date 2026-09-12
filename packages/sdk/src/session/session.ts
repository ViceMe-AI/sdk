/**
 * Public visitor session.
 *
 * ```text
 * SDK + workKey + supported protocols -> POST /v1/public/work-sdk/sessions
 *   -> short-lived capability token -> public capability calls
 * ```
 *
 * The token lives in memory only (never localStorage/cookies), is bound to the
 * Work, market, capability set, and expiry by the server, and is dropped on
 * `destroy()`. `workKey` locates the Work — it is never an authorization
 * credential.
 */

import { clientDestroyed, ViceMeError } from '../core/errors.ts';
import type { Transport, TransportRequest, TransportResponse } from '../transport/transport.ts';
export interface CreateWorkSessionRequestDto {
  workKey: string;
  supportedAccessProtocolVersions: [3];
}

export interface AccessMarketCapabilities {
  market: 'CN' | 'GLOBAL';
  loginMethods: string[];
  supportedPriceCurrencies: Array<'CNY' | 'USD'>;
  checkoutAvailability: 'AVAILABLE' | 'PENDING_CHANNEL' | 'DISABLED';
  anonymousPurchase: boolean;
}

export interface WorkDescriptor {
  key: string;
  /** Capability names enabled for this work. */
  capabilities: string[];
  creator?: WorkCreatorDescriptor;
  details?: WorkPresentationDescriptor;
}

export interface WorkCreatorDescriptor {
  displayName: string;
  avatarUrl: string | null;
  publishedWorkCount: number;
}

export interface WorkPresentationDescriptor {
  title: string;
  summary: string;
  coverUrl: string | null;
}

export interface WorkSessionSnapshot {
  work: WorkDescriptor;
  /** Opaque short-lived capability token; memory-only. */
  token?: string;
  /** Epoch milliseconds when the token expires, when provided by the server. */
  expiresAt?: number;
  user?: WorkUser;
  userToken?: string;
  userExpiresAt?: number;
  accessProtocolVersion?: 3;
  marketCapabilities?: AccessMarketCapabilities;
  buyerToken?: string;
  buyerExpiresAt?: number;
}

export interface WorkUser {
  subject: string;
  nickname: string | null;
  avatarUrl: string | null;
}

export interface SessionManagerOptions {
  workKey: string;
  region?: 'cn' | 'global';
  transport: Transport;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Injectable clock for tests. */
  now?: () => number;
}

function parseSessionResponse(
  body: unknown,
  workKey: string,
  region?: 'cn' | 'global',
): WorkSessionSnapshot {
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
  if (raw.accessProtocolVersion !== undefined) {
    if (raw.accessProtocolVersion !== 3) throw malformedSessionResponse();
    const capabilities = record(raw.marketCapabilities);
    if (region !== undefined && capabilities.market !== (region === 'cn' ? 'CN' : 'GLOBAL')) {
      throw malformedSessionResponse();
    }
    if (
      !['CN', 'GLOBAL'].includes(capabilities.market as string) ||
      !Array.isArray(capabilities.loginMethods) ||
      !capabilities.loginMethods.every((method) => typeof method === 'string') ||
      !Array.isArray(capabilities.supportedPriceCurrencies) ||
      !capabilities.supportedPriceCurrencies.every(
        (currency) => currency === 'CNY' || currency === 'USD',
      ) ||
      !['AVAILABLE', 'PENDING_CHANNEL', 'DISABLED'].includes(
        capabilities.checkoutAvailability as string,
      ) ||
      typeof capabilities.anonymousPurchase !== 'boolean'
    )
      throw malformedSessionResponse();
    snapshot.accessProtocolVersion = 3;
    snapshot.marketCapabilities = capabilities as unknown as AccessMarketCapabilities;
  }
  if (raw.creator !== undefined || raw.work !== undefined) {
    const creator = record(raw.creator);
    const work = record(raw.work);
    if (
      typeof creator.displayName !== 'string' ||
      creator.displayName.length === 0 ||
      !nullableUrl(creator.avatarUrl) ||
      !Number.isInteger(creator.publishedWorkCount) ||
      (creator.publishedWorkCount as number) < 0 ||
      typeof work.title !== 'string' ||
      work.title.length === 0 ||
      typeof work.summary !== 'string' ||
      !nullableUrl(work.coverUrl)
    ) {
      throw malformedSessionResponse();
    }
    snapshot.work.creator = {
      displayName: creator.displayName,
      avatarUrl: creator.avatarUrl as string | null,
      publishedWorkCount: creator.publishedWorkCount as number,
    };
    snapshot.work.details = {
      title: work.title,
      summary: work.summary,
      coverUrl: work.coverUrl as string | null,
    };
  }
  // Unknown extra fields are allowed and ignored (forward compatibility).
  if (typeof raw.token === 'string') snapshot.token = raw.token;
  if (typeof raw.expiresAt === 'string') {
    const expiresAt = new Date(raw.expiresAt).getTime();
    if (!Number.isNaN(expiresAt)) snapshot.expiresAt = expiresAt;
  }
  return snapshot;
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null) throw malformedSessionResponse();
  return value as Record<string, unknown>;
}

function nullableUrl(value: unknown): value is string | null {
  if (value === null) return true;
  if (typeof value !== 'string') return false;
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
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
  #identityGeneration = 0;
  #destroyed = false;

  constructor(options: SessionManagerOptions) {
    this.#options = options;
    this.#now = options.now ?? (() => Date.now());
  }

  get snapshot(): WorkSessionSnapshot | undefined {
    return this.#snapshot;
  }

  /** Identity generation prevents a late bridge from undoing logout or account changes. */
  get identityGeneration(): number {
    return this.#identityGeneration;
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
      if (!this.#isExpired()) {
        if (
          this.#snapshot.userExpiresAt !== undefined &&
          this.#snapshot.userExpiresAt <= this.#now()
        ) {
          this.#generation += 1;
          this.#identityGeneration += 1;
          this.#snapshot = {
            ...this.#snapshot,
            user: undefined,
            userToken: undefined,
            userExpiresAt: undefined,
          };
        }
        if (
          this.#snapshot.buyerExpiresAt !== undefined &&
          this.#snapshot.buyerExpiresAt <= this.#now()
        ) {
          this.#generation += 1;
          this.#identityGeneration += 1;
          this.#snapshot = { ...this.#snapshot, buyerToken: undefined, buyerExpiresAt: undefined };
        }
        return Promise.resolve(this.#snapshot);
      }
      this.#generation += 1;
      this.#snapshot = undefined;
    }
    if (this.#pending) return this.#pending;
    const generation = this.#generation;
    const pending = this.#options.transport
      .request({
        method: 'POST',
        path: '/v1/public/work-sdk/sessions',
        body: {
          workKey: this.#options.workKey,
          supportedAccessProtocolVersions: [3],
        } satisfies CreateWorkSessionRequestDto,
        signal: this.#options.signal,
        timeoutMs: this.#options.timeoutMs,
      })
      .then((response) => {
        this.#assertCurrent(generation);
        const snapshot = parseSessionResponse(
          response.body,
          this.#options.workKey,
          this.#options.region,
        );
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
    request: Omit<TransportRequest, 'authorization' | 'userAuthorization' | 'buyerAuthorization'>,
  ): Promise<TransportResponse> {
    const snapshot = await this.establish();
    if (!snapshot.token) throw malformedSessionResponse();
    try {
      return await this.#requestWithSnapshot(request, snapshot);
    } catch (error) {
      if (this.#destroyed) throw clientDestroyed();
      if (request.signal?.aborted || this.#options.signal?.aborted) throw error;
      if (!(error instanceof ViceMeError) || error.code !== 'SESSION_EXPIRED') throw error;
      if (this.#snapshot === snapshot) this.invalidate();
      const refreshed = await this.establish();
      if (!refreshed.token) throw malformedSessionResponse();
      return this.#requestWithSnapshot(request, refreshed);
    }
  }

  authenticate(input: { userToken: string; user: WorkUser; expiresAt?: number }): void {
    this.#assertAlive();
    if (!this.#snapshot) throw malformedSessionResponse();
    if (input.expiresAt !== undefined && input.expiresAt <= this.#now()) throw sessionInvalidated();
    this.#generation += 1;
    this.#identityGeneration += 1;
    this.#snapshot = {
      ...this.#snapshot,
      userToken: input.userToken,
      user: input.user,
      userExpiresAt: input.expiresAt,
      buyerToken: undefined,
      buyerExpiresAt: undefined,
    };
  }

  identifyBuyer(input: { buyerToken: string; expiresAt: number }, generation: number): void {
    this.#assertAlive();
    if (generation !== this.#identityGeneration) throw sessionInvalidated();
    if (!this.#snapshot || input.expiresAt <= this.#now()) throw sessionInvalidated();
    this.#generation += 1;
    this.#identityGeneration += 1;
    this.#snapshot = {
      ...this.#snapshot,
      user: undefined,
      userToken: undefined,
      userExpiresAt: undefined,
      buyerToken: input.buyerToken,
      buyerExpiresAt: input.expiresAt,
    };
  }

  async signOut(): Promise<void> {
    this.#assertAlive();
    this.#identityGeneration += 1;
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
    this.#identityGeneration += 1;
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
    request: Omit<TransportRequest, 'authorization' | 'userAuthorization' | 'buyerAuthorization'>,
    snapshot: WorkSessionSnapshot,
  ): Promise<TransportResponse> {
    this.#assertAlive();
    const generation = this.#generation;
    try {
      const response = await this.#options.transport.request({
        ...request,
        authorization: snapshot.token,
        userAuthorization: snapshot.userToken,
        buyerAuthorization:
          snapshot.buyerExpiresAt !== undefined && snapshot.buyerExpiresAt > this.#now()
            ? snapshot.buyerToken
            : undefined,
        signal:
          request.signal && this.#options.signal
            ? AbortSignal.any([request.signal, this.#options.signal])
            : (request.signal ?? this.#options.signal),
      });
      this.#assertAlive();
      // A late authorization read must not grant access after identity changes.
      // Successful mutations are not replayed just because another request refreshed a session.
      if (request.method === 'GET' || request.path === '/v1/public/work-sdk/access/check') {
        this.#assertCurrent(generation);
      }
      return response;
    } catch (error) {
      if (this.#destroyed) throw clientDestroyed();
      throw error;
    }
  }
}
