import { ViceMeError } from './errors.ts';
import {
  defaultAccessPresenter,
  type AccessActionResult,
  type AccessFrameAction,
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
  target: FollowTarget;
}

export interface FollowTarget {
  kind: 'CREATOR' | 'USER';
  displayName: string;
  avatarUrl: string | null;
  description: string | null;
}

export type AccessReason =
  | 'OWNER'
  | 'FOLLOWING'
  | 'PURCHASED'
  | 'ENTITLED'
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
  featureKey: string;
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
  open(options: CheckoutOptions): Promise<CheckoutResult>;
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
  const target = objectBody(body.target);
  if (
    !(target.kind === 'CREATOR' || target.kind === 'USER') ||
    typeof target.displayName !== 'string' ||
    !(typeof target.avatarUrl === 'string' || target.avatarUrl === null) ||
    !(typeof target.description === 'string' || target.description === null)
  ) {
    throw malformedResponse();
  }
  return {
    following: body.following,
    followedAt: body.followedAt,
    target: {
      kind: target.kind,
      displayName: target.displayName,
      avatarUrl: target.avatarUrl,
      description: target.description,
    },
  };
}

function parseDecision(value: unknown): AccessDecision {
  const body = objectBody(value);
  const reasons: ReadonlySet<string> = new Set([
    'OWNER',
    'FOLLOWING',
    'PURCHASED',
    'ENTITLED',
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

function parseOrigin(value: unknown): string {
  if (typeof value !== 'string') throw malformedResponse();
  try {
    const origin = new URL(value).origin;
    if (origin !== value) throw malformedResponse();
    return origin;
  } catch (error) {
    if (error instanceof ViceMeError) throw error;
    throw malformedResponse();
  }
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

function resolveLocale(): 'zh-CN' | 'en-US' {
  return typeof document !== 'undefined' && document.documentElement.lang.toLowerCase() === 'en-us'
    ? 'en-US'
    : 'zh-CN';
}

export function createCapabilities(deps: CapabilityDeps): {
  auth: AuthCapability;
  follow: FollowCapability;
  access: AccessCapability;
  checkout: CheckoutCapability;
} {
  const authenticate = async (code: string, codeVerifier: string): Promise<AuthState> => {
    const exchange = objectBody(
      (
        await deps.session.request({
          method: 'POST',
          path: '/v1/public/v1/auth/exchange',
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

  const cancelled = () =>
    new ViceMeError({
      code: 'AUTH_CANCELLED',
      message: 'The interactive action was cancelled.',
      retryable: false,
    });

  const embeddedFrame = (
    url: string,
    completionOrigin: string,
    channel: string,
    type: 'auth' | 'checkout',
    complete: (data: Record<string, unknown>) => Promise<void>,
  ): AccessFrameAction => {
    if (typeof window === 'undefined') {
      throw new ViceMeError({
        code: 'CONFIG_INVALID',
        message: 'Interactive access requires a browser window.',
        retryable: false,
      });
    }
    let active = true;
    let settle!: () => void;
    let fail!: (error: unknown) => void;
    const cleanup = () => {
      if (!active) return;
      active = false;
      window.removeEventListener('message', receive);
    };
    const completion = new Promise<void>((resolve, reject) => {
      settle = resolve;
      fail = reject;
    });
    const receive = (event: MessageEvent) => {
      if (!active || event.origin !== completionOrigin) return;
      if (typeof event.data !== 'object' || event.data === null) return;
      const data = event.data as Record<string, unknown>;
      if (data.workKey !== deps.workKey || data.channel !== channel) return;
      if (data.type === `viceme:${type}:cancelled`) {
        cleanup();
        fail(cancelled());
        return;
      }
      if (data.type !== `viceme:${type}:complete`) return;
      cleanup();
      void complete(data).then(settle, fail);
    };
    window.addEventListener('message', receive);
    return {
      type: 'frame',
      url,
      completion,
      cancel() {
        cleanup();
        settle();
      },
    };
  };

  const startSignIn = async (
    afterAuthenticate?: () => Promise<void>,
  ): Promise<AccessActionResult> => {
    await deps.ready();
    const channel = randomVerifier();
    const response = await deps.session.request({
      method: 'POST',
      path: '/v1/public/v1/auth/wechat/authorize',
      body: {
        channel,
        // Keep the debuggable QR flow until the embedded WeChat H5 design is restored.
        clientType: 'pc',
        locale: resolveLocale(),
      },
    });
    const authorize = objectBody(response.body);
    if (typeof authorize.authorizationUrl !== 'string') throw malformedResponse();
    return embeddedFrame(
      authorize.authorizationUrl,
      parseOrigin(authorize.completionOrigin),
      channel,
      'auth',
      async (data) => {
        if (typeof data.code !== 'string' || typeof data.codeVerifier !== 'string') {
          throw malformedResponse();
        }
        await authenticate(data.code, data.codeVerifier);
        await afterAuthenticate?.();
      },
    );
  };

  const getFollowState = async (): Promise<FollowState> => {
    await deps.ready();
    return parseFollowState(
      (await deps.session.request({ method: 'GET', path: '/v1/public/v1/follow' })).body,
    );
  };

  const updateFollow = async (method: 'PUT' | 'DELETE'): Promise<FollowState> => {
    await deps.ready();
    return parseFollowState(
      (await deps.session.request({ method, path: '/v1/public/v1/follow' })).body,
    );
  };

  const auth: AuthCapability = {
    async getState() {
      await deps.ready();
      const user = deps.session.snapshot?.user ?? null;
      return { authenticated: user !== null, user };
    },
    async signIn() {
      const presenter = deps.presenter ?? defaultAccessPresenter;
      const followTarget = (await getFollowState()).target;
      const result = await presenter({
        featureKey: 'auth',
        reason: 'AUTH_REQUIRED',
        action: 'SIGN_IN',
        followTarget,
        perform: () =>
          startSignIn(async () => {
            await updateFollow('PUT');
          }),
      });
      if (result === 'dismissed') throw cancelled();
      return this.getState();
    },
    async signOut() {
      await deps.ready();
      await deps.session.signOut();
    },
  };

  const follow: FollowCapability = {
    getState: getFollowState,
    follow: () => updateFollow('PUT'),
    unfollow: () => updateFollow('DELETE'),
  };

  const checkMany = async (featureKeys: string[]): Promise<Record<string, AccessDecision>> => {
    await deps.ready();
    const response = objectBody(
      (
        await deps.session.request({
          method: 'POST',
          path: '/v1/public/v1/access/check',
          body: { featureKeys },
        })
      ).body,
    );
    const raw = objectBody(response.decisions);
    return Object.fromEntries(
      Object.entries(raw).map(([key, value]) => [key, parseDecision(value)]),
    );
  };

  const startCheckout = async (
    featureKey: string,
    options: Omit<CheckoutOptions, 'featureKey'> = {},
  ): Promise<{ result: CheckoutResult; action: AccessActionResult }> => {
    await deps.ready();
    const channel = randomVerifier();
    const body = {
      featureKey,
      locale: options.locale ?? 'zh-CN',
      channel,
    };
    const response = objectBody(
      (
        await deps.session.request({
          method: 'POST',
          path: '/v1/public/v1/checkout/sessions',
          body,
        })
      ).body,
    );
    if (typeof response.checkoutUrl !== 'string' || typeof response.alreadyOwned !== 'boolean') {
      throw malformedResponse();
    }
    const completionOrigin = parseOrigin(response.completionOrigin);
    const result = {
      checkoutUrl: response.checkoutUrl,
      alreadyOwned: response.alreadyOwned,
    };
    return {
      result,
      action: result.alreadyOwned
        ? { type: 'completed' }
        : embeddedFrame(result.checkoutUrl, completionOrigin, channel, 'checkout', async () => {}),
    };
  };

  const checkout: CheckoutCapability = {
    async open(options) {
      const presenter = deps.presenter ?? defaultAccessPresenter;
      let checkoutResult: CheckoutResult | undefined;
      const presented = await presenter({
        featureKey: options.featureKey,
        reason: 'PURCHASE_REQUIRED',
        action: 'CHECKOUT',
        perform: async () => {
          const prepared = await startCheckout(options.featureKey, options);
          checkoutResult = prepared.result;
          return prepared.action;
        },
      });
      if (presented === 'dismissed' || !checkoutResult) throw cancelled();
      return checkoutResult;
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
        const nextAction = decision.nextAction;
        if (nextAction === 'FOLLOW') {
          await follow.follow();
          decision = await this.check(featureKey);
          continue;
        }
        const followTarget =
          nextAction === 'SIGN_IN' ? (await follow.getState()).target : undefined;
        const result = await presenter({
          featureKey,
          reason: decision.reason,
          action: nextAction,
          ...(followTarget ? { followTarget } : {}),
          perform: async () => {
            if (nextAction === 'SIGN_IN') {
              return startSignIn(async () => {
                await follow.follow();
              });
            } else {
              return (await startCheckout(featureKey)).action;
            }
          },
        });
        if (result === 'dismissed') return decision;
        decision = await this.check(featureKey);
      }
      return decision;
    },
    async refresh() {
      await deps.ready();
    },
  };

  return { auth, follow, access, checkout };
}
