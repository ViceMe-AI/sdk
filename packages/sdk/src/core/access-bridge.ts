import { clientDestroyed, ViceMeError } from './errors.ts';
import type { AccessFrameAction } from './presentation.ts';
import type { SessionManager, WorkUser } from '../session/session.ts';

export type AccessBridgePurpose = 'IDENTIFY' | 'RESTORE' | 'CLAIM' | 'SIGN_IN';

interface BridgeOptions {
  session: SessionManager;
  workKey: string;
  widgetOrigin: string;
  signal: AbortSignal;
  now: () => number;
}

interface Handshake {
  challengeId: string;
  bridgeUrl: string;
  expiresAt: number;
  verifier: string;
  state: string;
  purpose: AccessBridgePurpose;
  featureKey?: string;
}

function invalid(): ViceMeError {
  return new ViceMeError({
    code: 'INTERNAL_ERROR',
    message: 'Malformed access bridge response.',
    retryable: false,
  });
}

function body(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw invalid();
  return value as Record<string, unknown>;
}

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function officialUrl(value: unknown, origin: string): string {
  if (typeof value !== 'string') throw invalid();
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw invalid();
  }
  if (url.protocol !== 'https:' || url.origin !== origin || url.username || url.password)
    throw invalid();
  return url.href;
}

function expired(): ViceMeError {
  return new ViceMeError({
    code: 'SESSION_EXPIRED',
    message: 'Access recovery expired. Please try again.',
    retryable: true,
  });
}

/** A proof-of-possession bridge: window messages and return URLs never carry credentials. */
export function createAccessBridge(options: BridgeOptions): {
  start(purpose: AccessBridgePurpose, featureKey?: string): Promise<AccessFrameAction>;
  clear(): void;
} {
  const storageKey = `viceme:access-bridge:v3:${options.widgetOrigin}:${options.workKey}`;
  let active: AbortController | undefined;
  const clear = () => {
    active?.abort(options.signal.aborted ? options.signal.reason : undefined);
    active = undefined;
    try {
      sessionStorage.removeItem(storageKey);
    } catch {
      /* Storage may be unavailable. */
    }
  };
  options.signal.addEventListener('abort', clear, { once: true });

  return {
    clear,
    async start(purpose, featureKey) {
      if (options.signal.aborted) throw options.signal.reason ?? clientDestroyed();
      if (active)
        throw new ViceMeError({
          code: 'CONFIG_INVALID',
          message: 'An access interaction is already open.',
          retryable: true,
        });
      if (typeof window === 'undefined' || !globalThis.crypto?.subtle) {
        throw new ViceMeError({
          code: 'CONFIG_INVALID',
          message: 'Access recovery requires a browser with Web Crypto.',
          retryable: false,
        });
      }
      const controller = new AbortController();
      active = controller;
      const signal = AbortSignal.any([options.signal, controller.signal]);
      const assertActive = () => {
        if (signal.aborted) throw signal.reason ?? clientDestroyed();
      };
      try {
        await options.session.establish();
        const generation = options.session.identityGeneration;
        const request = async (path: string, fields: Record<string, unknown>) => {
          assertActive();
          const snapshot = await options.session.establish();
          const response = await options.session.request({
            method: 'POST',
            path,
            signal,
            body: { ...fields, workSessionToken: snapshot.token },
          });
          assertActive();
          return body(response.body);
        };

        let handshake: Handshake | undefined;
        try {
          const stored = JSON.parse(sessionStorage.getItem(storageKey) ?? 'null');
          if (
            stored &&
            (stored.purpose === purpose ||
              (purpose === 'IDENTIFY' && ['RESTORE', 'CLAIM'].includes(stored.purpose))) &&
            stored.featureKey === featureKey &&
            typeof stored.expiresAt === 'number' &&
            stored.expiresAt > options.now() &&
            stored.expiresAt <= options.now() + 300_000 &&
            typeof stored.challengeId === 'string' &&
            /^[A-Za-z0-9_-]+$/.test(stored.challengeId) &&
            typeof stored.verifier === 'string' &&
            /^[A-Za-z0-9_-]{43,128}$/.test(stored.verifier) &&
            typeof stored.state === 'string'
          ) {
            handshake = {
              ...stored,
              bridgeUrl: officialUrl(stored.bridgeUrl, options.widgetOrigin),
            } as Handshake;
            // require() may resume the user's already-authorized recovery/claim after navigation.
            purpose = handshake.purpose;
          }
        } catch {
          /* Invalid or unavailable navigation state starts a new handshake. */
        }
        if (!handshake) {
          const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
          const state = base64url(crypto.getRandomValues(new Uint8Array(32)));
          const codeChallenge = base64url(
            new Uint8Array(
              await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)),
            ),
          );
          assertActive();
          const returnUrl = /^https?:$/.test(window.location.protocol)
            ? window.location.href
            : undefined;
          const result = await request('/v1/public/work-sdk/buyer/challenges', {
            purpose,
            ...(featureKey ? { featureKey } : {}),
            codeChallenge,
            state,
            requestId: crypto.randomUUID(),
            ...(returnUrl ? { returnUrl } : {}),
          });
          const expiresAt =
            typeof result.expiresAt === 'string' ? Date.parse(result.expiresAt) : NaN;
          if (
            typeof result.challengeId !== 'string' ||
            !/^[A-Za-z0-9_-]+$/.test(result.challengeId) ||
            !Number.isFinite(expiresAt) ||
            expiresAt <= options.now()
          )
            throw invalid();
          handshake = {
            challengeId: result.challengeId,
            bridgeUrl: officialUrl(result.bridgeUrl, options.widgetOrigin),
            expiresAt: Math.min(expiresAt, options.now() + 300_000),
            verifier,
            state,
            purpose,
            featureKey,
          };
        }
        const current = handshake;
        let navigating = false;
        const forget = () => {
          if (active === controller) active = undefined;
          if (!navigating) {
            try {
              sessionStorage.removeItem(storageKey);
            } catch {
              /* No persistent credential required. */
            }
          }
        };
        let timer: ReturnType<typeof setTimeout> | undefined;
        let deadline: ReturnType<typeof setTimeout> | undefined;
        const pause = () =>
          new Promise<void>((resolve, reject) => {
            const abort = () => {
              if (timer) clearTimeout(timer);
              reject(signal.reason);
            };
            signal.addEventListener('abort', abort, { once: true });
            timer = setTimeout(() => {
              signal.removeEventListener('abort', abort);
              resolve();
            }, 1_000);
            if (signal.aborted) abort();
          });
        const complete = async () => {
          deadline = setTimeout(
            () => controller.abort(expired()),
            Math.max(0, current.expiresAt - options.now()),
          );
          try {
            while (options.now() < current.expiresAt) {
              assertActive();
              const result = await request(
                `/v1/public/work-sdk/buyer/challenges/${current.challengeId}/result`,
                { codeVerifier: current.verifier },
              );
              if (result.status === 'EXPIRED') throw expired();
              if (result.status === 'PENDING') {
                await pause();
                continue;
              }
              if (result.status !== 'READY' || typeof result.code !== 'string' || !result.code)
                throw invalid();
              const identity = await request('/v1/public/work-sdk/buyer/exchange', {
                code: result.code,
                codeVerifier: current.verifier,
              });
              assertActive();
              if (options.session.identityGeneration !== generation) throw expired();
              if (identity.purpose !== purpose) throw invalid();
              const identityExpiresAt =
                typeof identity.expiresAt === 'string' ? Date.parse(identity.expiresAt) : NaN;
              if (!Number.isFinite(identityExpiresAt) || identityExpiresAt <= options.now())
                throw invalid();
              if (typeof identity.userToken === 'string' && identity.userToken) {
                if (purpose !== 'SIGN_IN' && purpose !== 'CLAIM') throw invalid();
                const user = body(identity.user);
                if (
                  typeof user.id !== 'string' ||
                  !(typeof user.displayName === 'string' || user.displayName === null) ||
                  !(typeof user.avatarUrl === 'string' || user.avatarUrl === null)
                )
                  throw invalid();
                const parsed: WorkUser = {
                  subject: user.id,
                  nickname: user.displayName,
                  avatarUrl: user.avatarUrl,
                };
                options.session.authenticate({
                  userToken: identity.userToken,
                  user: parsed,
                  expiresAt: identityExpiresAt,
                });
              } else {
                const expiresAt =
                  typeof identity.expiresAt === 'string' ? Date.parse(identity.expiresAt) : NaN;
                if (
                  purpose === 'SIGN_IN' ||
                  purpose === 'CLAIM' ||
                  typeof identity.buyerToken !== 'string' ||
                  !identity.buyerToken ||
                  !Number.isFinite(expiresAt)
                )
                  throw invalid();
                options.session.identifyBuyer(
                  { buyerToken: identity.buyerToken, expiresAt },
                  generation,
                );
              }
              return;
            }
            throw expired();
          } finally {
            if (deadline) clearTimeout(deadline);
            if (timer) clearTimeout(timer);
            forget();
          }
        };
        let completion: Promise<void> | undefined;
        return {
          type: 'frame',
          url: current.bridgeUrl,
          get completion() {
            // Do not exchange an identity before the presenter accepts the action.
            return (completion ??= complete());
          },
          cancel: () => {
            controller.abort();
            forget();
          },
          continueInSamePage: () => {
            assertActive();
            // Only a bounded PKCE handshake is saved, never buyer/user tokens or recovery secrets.
            try {
              sessionStorage.setItem(storageKey, JSON.stringify(current));
            } catch {
              throw new ViceMeError({
                code: 'CONFIG_INVALID',
                message: 'Browser storage is unavailable. Use the recovery page in another window.',
                retryable: true,
              });
            }
            navigating = true;
            controller.abort();
            window.location.assign(current.bridgeUrl);
          },
        };
      } catch (error) {
        if (active === controller) active = undefined;
        controller.abort();
        throw error;
      }
    },
  };
}
