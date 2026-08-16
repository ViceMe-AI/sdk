import { ViceMeError } from './errors.ts';
import {
  defaultAccessPresenter,
  type AccessInteractionAction,
  type AccessPresenter,
} from './presentation.ts';
import type { SessionManager, WorkUser } from '../session/session.ts';

export interface AuthState {
  authenticated: boolean;
  user: WorkUser | null;
}

export interface FollowState {
  following: boolean;
  followedAt: string | null;
}

export type AccessReason =
  | 'OWNER'
  | 'FOLLOWING'
  | 'PURCHASED'
  | 'AUTH_REQUIRED'
  | 'FOLLOW_REQUIRED'
  | 'PURCHASE_REQUIRED'
  | 'FEATURE_NOT_FOUND'
  | 'FEATURE_DISABLED'
  | 'POLICY_UNSUPPORTED';

export interface AccessDecision {
  allowed: boolean;
  reason: AccessReason;
  nextAction: 'SIGN_IN' | 'FOLLOW' | 'CHECKOUT' | null;
}

export interface CheckoutOptions {
  returnUrl?: string;
  locale?: 'zh-CN' | 'en-US';
}

export interface CheckoutResult {
  checkoutUrl: string;
  alreadyOwned: boolean;
}

export interface AuthCapability {
  getState(): Promise<AuthState>;
  signIn(): Promise<AuthState>;
  signOut(): Promise<void>;
}

export interface FollowCapability {
  getState(): Promise<FollowState>;
  follow(): Promise<FollowState>;
  unfollow(): Promise<FollowState>;
}

export interface AccessCapability {
  check(featureKey: string): Promise<AccessDecision>;
  checkMany(featureKeys: string[]): Promise<Record<string, AccessDecision>>;
  require(featureKey: string): Promise<AccessDecision>;
  refresh(): Promise<void>;
}

export interface CheckoutCapability {
  open(options?: CheckoutOptions): Promise<CheckoutResult>;
}

interface CapabilityDeps {
  session: SessionManager;
  workKey: string;
  presenter?: AccessPresenter;
  ready: () => Promise<void>;
}

function objectBody(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null) throw malformedResponse();
  return value as Record<string, unknown>;
}

function malformedResponse(): ViceMeError {
  return new ViceMeError({
    code: 'INTERNAL_ERROR',
    message: 'Malformed public API response.',
    retryable: true,
  });
}

function parseUser(value: unknown): WorkUser {
  const body = objectBody(value);
  if (
    typeof body.subject !== 'string' ||
    !(typeof body.nickname === 'string' || body.nickname === null) ||
    !(typeof body.avatarUrl === 'string' || body.avatarUrl === null)
  ) {
    throw malformedResponse();
  }
  return {
    subject: body.subject,
    nickname: body.nickname,
    avatarUrl: body.avatarUrl,
  };
}

function parseFollowState(value: unknown): FollowState {
  const body = objectBody(value);
  if (
    typeof body.following !== 'boolean' ||
    !(typeof body.followedAt === 'string' || body.followedAt === null)
  ) {
    throw malformedResponse();
  }
  return { following: body.following, followedAt: body.followedAt };
}

function parseDecision(value: unknown): AccessDecision {
  const body = objectBody(value);
  const reasons: ReadonlySet<string> = new Set([
    'OWNER',
    'FOLLOWING',
    'PURCHASED',
    'AUTH_REQUIRED',
    'FOLLOW_REQUIRED',
    'PURCHASE_REQUIRED',
    'FEATURE_NOT_FOUND',
    'FEATURE_DISABLED',
    'POLICY_UNSUPPORTED',
  ]);
  const actions: ReadonlySet<unknown> = new Set([null, 'SIGN_IN', 'FOLLOW', 'CHECKOUT']);
  if (
    typeof body.allowed !== 'boolean' ||
    typeof body.reason !== 'string' ||
    !reasons.has(body.reason) ||
    !actions.has(body.nextAction)
  ) {
    throw malformedResponse();
  }
  return {
    allowed: body.allowed,
    reason: body.reason as AccessReason,
    nextAction: body.nextAction as AccessDecision['nextAction'],
  };
}

function randomVerifier(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return base64Url(bytes);
}

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

async function codeChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64Url(new Uint8Array(digest));
}

function authStorageKey(workKey: string): string {
  return `viceme:auth:${workKey}`;
}

function checkoutResumeStorageKey(workKey: string): string {
  return `viceme:checkout-resume:${workKey}`;
}

export function createCapabilities(deps: CapabilityDeps): {
  auth: AuthCapability;
  follow: FollowCapability;
  access: AccessCapability;
  checkout: CheckoutCapability;
  resumeRedirects(): Promise<void>;
} {
  const authenticate = async (code: string, codeVerifier: string): Promise<AuthState> => {
    const exchange = objectBody(
      (
        await deps.session.request({
          method: 'POST',
          path: '/public/v1/auth/exchange',
          body: { code, codeVerifier },
        })
      ).body,
    );
    if (typeof exchange.token !== 'string' || typeof exchange.expiresAt !== 'number') {
      throw malformedResponse();
    }
    const user = parseUser(exchange.user);
    deps.session.authenticate({ token: exchange.token, expiresAt: exchange.expiresAt, user });
    return { authenticated: true, user };
  };

  const resumeRedirects = async (): Promise<void> => {
    if (typeof window === 'undefined') return;
    const checkoutCode = window.sessionStorage.getItem(checkoutResumeStorageKey(deps.workKey));
    if (checkoutCode) {
      window.sessionStorage.removeItem(checkoutResumeStorageKey(deps.workKey));
      const response = objectBody(
        (
          await deps.session.request({
            method: 'POST',
            path: '/public/v1/auth/resume',
            body: { code: checkoutCode },
          })
        ).body,
      );
      if (typeof response.token !== 'string' || typeof response.expiresAt !== 'number') {
        throw malformedResponse();
      }
      const user = parseUser(response.user);
      deps.session.authenticate({ token: response.token, expiresAt: response.expiresAt, user });
    }

    const url = new URL(window.location.href);
    const code = url.searchParams.get('vicemeAuthCode');
    if (!code) return;
    const raw = window.sessionStorage.getItem(authStorageKey(deps.workKey));
    window.sessionStorage.removeItem(authStorageKey(deps.workKey));
    url.searchParams.delete('vicemeAuthCode');
    window.history.replaceState(window.history.state, '', url);
    if (!raw) {
      throw new ViceMeError({
        code: 'AUTH_CANCELLED',
        message: 'The sign-in continuation is missing or expired.',
        retryable: false,
      });
    }
    const state = JSON.parse(raw) as { verifier?: unknown };
    if (typeof state.verifier !== 'string') throw malformedResponse();
    await authenticate(code, state.verifier);
  };

  const auth: AuthCapability = {
    async getState() {
      await deps.ready();
      const user = deps.session.snapshot?.user ?? null;
      return { authenticated: user !== null, user };
    },
    async signIn() {
      await deps.ready();
      if (typeof window === 'undefined') {
        throw new ViceMeError({
          code: 'CONFIG_INVALID',
          message: 'WeChat sign-in requires a browser window.',
          retryable: false,
        });
      }
      const verifier = randomVerifier();
      const response = await deps.session.request({
        method: 'POST',
        path: '/public/v1/auth/wechat/authorize',
        body: {
          codeChallenge: await codeChallenge(verifier),
          returnUrl: window.location.href,
        },
      });
      const authorize = objectBody(response.body);
      if (typeof authorize.authorizationUrl !== 'string') throw malformedResponse();
      window.sessionStorage.setItem(
        authStorageKey(deps.workKey),
        JSON.stringify({ verifier, startedAt: Date.now() }),
      );
      window.location.assign(authorize.authorizationUrl);
      return { authenticated: false, user: null };
    },
    async signOut() {
      await deps.ready();
      await deps.session.signOut();
    },
  };

  const follow: FollowCapability = {
    async getState() {
      await deps.ready();
      return parseFollowState(
        (await deps.session.request({ method: 'GET', path: '/public/v1/follow' })).body,
      );
    },
    async follow() {
      await deps.ready();
      return parseFollowState(
        (await deps.session.request({ method: 'PUT', path: '/public/v1/follow' })).body,
      );
    },
    async unfollow() {
      await deps.ready();
      return parseFollowState(
        (await deps.session.request({ method: 'DELETE', path: '/public/v1/follow' })).body,
      );
    },
  };

  const checkMany = async (featureKeys: string[]): Promise<Record<string, AccessDecision>> => {
    await deps.ready();
    const response = objectBody(
      (
        await deps.session.request({
          method: 'POST',
          path: '/public/v1/access/check',
          body: { featureKeys },
        })
      ).body,
    );
    const raw = objectBody(response.decisions);
    return Object.fromEntries(
      Object.entries(raw).map(([key, value]) => [key, parseDecision(value)]),
    );
  };

  const checkout: CheckoutCapability = {
    async open(options = {}) {
      await deps.ready();
      const body: { locale: 'zh-CN' | 'en-US'; returnUrl?: string } = {
        locale: options.locale ?? 'zh-CN',
      };
      if (options.returnUrl !== undefined) body.returnUrl = options.returnUrl;
      const response = objectBody(
        (
          await deps.session.request({
            method: 'POST',
            path: '/public/v1/checkout/sessions',
            body,
          })
        ).body,
      );
      if (typeof response.checkoutUrl !== 'string' || typeof response.alreadyOwned !== 'boolean') {
        throw malformedResponse();
      }
      const result = {
        checkoutUrl: response.checkoutUrl,
        alreadyOwned: response.alreadyOwned,
      };
      if (!result.alreadyOwned && typeof window !== 'undefined') {
        const resume = objectBody(
          (
            await deps.session.request({
              method: 'POST',
              path: '/public/v1/auth/resume-codes',
            })
          ).body,
        );
        if (typeof resume.code !== 'string') throw malformedResponse();
        window.sessionStorage.setItem(checkoutResumeStorageKey(deps.workKey), resume.code);
        window.location.assign(result.checkoutUrl);
      }
      return result;
    },
  };

  const access: AccessCapability = {
    async check(featureKey) {
      const decisions = await checkMany([featureKey]);
      const decision = decisions[featureKey];
      if (!decision) throw malformedResponse();
      return decision;
    },
    checkMany,
    async require(featureKey) {
      let decision = await this.check(featureKey);
      const presenter = deps.presenter ?? defaultAccessPresenter;
      for (
        let attempts = 0;
        !decision.allowed && decision.nextAction && attempts < 3;
        attempts += 1
      ) {
        const nextAction = decision.nextAction as AccessInteractionAction;
        const result = await presenter({
          featureKey,
          reason: decision.reason,
          action: nextAction,
          perform: async () => {
            if (nextAction === 'SIGN_IN') {
              await auth.signIn();
            } else if (nextAction === 'FOLLOW') {
              await follow.follow();
            } else {
              await checkout.open({
                returnUrl: typeof location === 'undefined' ? undefined : location.href,
              });
            }
          },
        });
        if (result === 'dismissed' || nextAction !== 'FOLLOW') return decision;
        decision = await this.check(featureKey);
      }
      return decision;
    },
    async refresh() {
      await deps.ready();
    },
  };

  return { auth, follow, access, checkout, resumeRedirects };
}
