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
  workCount: number;
}

export type AccessReason =
  | 'PUBLIC'
  | 'OWNER'
  | 'FOLLOWING'
  | 'ENTITLED'
  | 'AUTH_REQUIRED'
  | 'FOLLOW_REQUIRED'
  | 'PURCHASE_REQUIRED'
  | 'FEATURE_NOT_FOUND'
  | 'FEATURE_DISABLED';

export interface AccessDecision {
  allowed: boolean;
  reason: AccessReason;
  nextAction: 'SIGN_IN' | 'FOLLOW' | 'CHECKOUT' | null;
}

export type AccessPolicyType = 'PUBLIC' | 'FOLLOW_OWNER' | 'WORK_ENTITLEMENT';

export interface AccessFeaturePresentation {
  featureKey: string;
  title: string;
  policy: { type: AccessPolicyType };
  price: { amountCents: number; currency: 'CNY' } | null;
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
  getFeatures(): Promise<AccessFeaturePresentation[]>;
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
  widgetOrigin: string;
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
    typeof body.id !== 'string' ||
    !(typeof body.displayName === 'string' || body.displayName === null) ||
    !(typeof body.avatarUrl === 'string' || body.avatarUrl === null)
  ) {
    throw malformedResponse();
  }
  return {
    subject: body.id,
    nickname: body.displayName,
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
  const target = objectBody(body.creator);
  if (
    typeof target.displayName !== 'string' ||
    !(typeof target.avatarUrl === 'string' || target.avatarUrl === null) ||
    !(typeof target.description === 'string' || target.description === null) ||
    !Number.isInteger(target.publishedWorkCount) ||
    (target.publishedWorkCount as number) < 0
  ) {
    throw malformedResponse();
  }
  return {
    following: body.following,
    followedAt: body.followedAt,
    target: {
      kind: 'CREATOR',
      displayName: target.displayName,
      avatarUrl: target.avatarUrl,
      description: target.description,
      workCount: target.publishedWorkCount as number,
    },
  };
}

function parseDecision(value: unknown): AccessDecision {
  const body = objectBody(value);
  const reasons: ReadonlySet<string> = new Set([
    'PUBLIC',
    'OWNER',
    'FOLLOWING',
    'ENTITLED',
    'AUTH_REQUIRED',
    'FOLLOW_REQUIRED',
    'PURCHASE_REQUIRED',
    'FEATURE_NOT_FOUND',
    'FEATURE_DISABLED',
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

function parseFeaturePresentation(value: unknown): AccessFeaturePresentation {
  const body = objectBody(value);
  if (
    typeof body.featureKey !== 'string' ||
    !/^[a-z][a-z0-9_-]{1,63}$/.test(body.featureKey) ||
    typeof body.title !== 'string' ||
    body.title.trim().length === 0 ||
    body.title.length > 120 ||
    !(
      body.policyType === 'PUBLIC' ||
      body.policyType === 'FOLLOW_OWNER' ||
      body.policyType === 'WORK_ENTITLEMENT'
    )
  ) {
    throw malformedResponse();
  }
  const price = body.price === null ? null : objectBody(body.price);
  if (
    price !== null &&
    (!Number.isInteger(price.amountCents) ||
      (price.amountCents as number) <= 0 ||
      price.currency !== 'CNY')
  ) {
    throw malformedResponse();
  }
  if ((body.policyType === 'WORK_ENTITLEMENT') !== (price !== null)) {
    throw malformedResponse();
  }
  return {
    featureKey: body.featureKey,
    title: body.title,
    policy: { type: body.policyType },
    price: price === null ? null : { amountCents: price.amountCents as number, currency: 'CNY' },
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
    type: 'auth',
    initialization: Record<string, unknown>,
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
      if (data.type === `viceme:${type}:ready`) {
        if (event.source && 'postMessage' in event.source) {
          (event.source as WindowProxy).postMessage(
            {
              type: `viceme:${type}:init`,
              workKey: deps.workKey,
              channel,
              ...initialization,
            },
            completionOrigin,
          );
        }
        return;
      }
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

  const startSignIn = async (): Promise<AccessActionResult> => {
    await deps.ready();
    if (typeof window === 'undefined') {
      throw new ViceMeError({
        code: 'CONFIG_INVALID',
        message: 'Interactive access requires a browser window.',
        retryable: false,
      });
    }
    const channel = randomVerifier();
    const authorizationUrl = new URL('/sdk/login', deps.widgetOrigin);
    authorizationUrl.search = new URLSearchParams({
      workKey: deps.workKey,
      channel,
      parentOrigin: window.location.origin,
      locale: resolveLocale(),
    }).toString();
    const workSessionToken = deps.session.snapshot?.token;
    if (!workSessionToken) throw malformedResponse();
    return embeddedFrame(
      authorizationUrl.toString(),
      deps.widgetOrigin,
      channel,
      'auth',
      { workSessionToken },
      async (data) => {
        if (typeof data.userToken !== 'string') {
          throw malformedResponse();
        }
        deps.session.authenticate({ userToken: data.userToken, user: parseUser(data.user) });
      },
    );
  };

  const getFollowState = async (): Promise<FollowState> => {
    await deps.ready();
    return parseFollowState(
      (await deps.session.request({ method: 'GET', path: '/v1/public/work-sdk/follow' })).body,
    );
  };

  const updateFollow = async (): Promise<FollowState> => {
    await deps.ready();
    return parseFollowState(
      (await deps.session.request({ method: 'PUT', path: '/v1/public/work-sdk/follow' })).body,
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
      const result = await presenter({
        featureKey: 'auth',
        reason: 'AUTH_REQUIRED',
        action: 'SIGN_IN',
        perform: startSignIn,
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
    follow: updateFollow,
    unfollow: async () => {
      throw new ViceMeError({
        code: 'CAPABILITY_DISABLED',
        message: 'Unfollow is not exposed by website access.',
        retryable: false,
      });
    },
  };

  const checkMany = async (featureKeys: string[]): Promise<Record<string, AccessDecision>> => {
    await deps.ready();
    const response = objectBody(
      (
        await deps.session.request({
          method: 'POST',
          path: '/v1/public/work-sdk/access/check',
          body: { featureKeys },
        })
      ).body,
    );
    const raw = objectBody(response.decisions);
    return Object.fromEntries(
      Object.entries(raw).map(([key, value]) => [key, parseDecision(value)]),
    );
  };

  const createCheckout = async (
    featureKey: string,
    options: Omit<CheckoutOptions, 'featureKey'> = {},
  ): Promise<CheckoutResult> => {
    await deps.ready();
    const body = {
      featureKey,
      locale: options.locale ?? 'zh-CN',
    };
    const response = objectBody(
      (
        await deps.session.request({
          method: 'POST',
          path: '/v1/public/work-sdk/checkout',
          body,
        })
      ).body,
    );
    if (typeof response.checkoutUrl !== 'string' || typeof response.alreadyOwned !== 'boolean') {
      throw malformedResponse();
    }
    try {
      new URL(response.checkoutUrl as string);
    } catch {
      throw malformedResponse();
    }
    return {
      checkoutUrl: response.checkoutUrl,
      alreadyOwned: response.alreadyOwned,
    };
  };

  const openCheckout = (result: CheckoutResult, featureKey: string): AccessActionResult => {
    if (result.alreadyOwned) return { type: 'completed' };
    if (typeof window === 'undefined') {
      throw new ViceMeError({
        code: 'CONFIG_INVALID',
        message: 'Hosted checkout requires a browser window.',
        retryable: false,
      });
    }

    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let settle!: () => void;
    let fail!: (error: unknown) => void;
    const completion = new Promise<void>((resolve, reject) => {
      settle = resolve;
      fail = reject;
    });
    const poll = async () => {
      if (!active) return;
      try {
        const decision = (await checkMany([featureKey]))[featureKey];
        if (!decision) throw malformedResponse();
        if (decision.allowed) {
          active = false;
          settle();
          return;
        }
        timer = setTimeout(() => void poll(), 1_500);
      } catch (error) {
        active = false;
        fail(error);
      }
    };
    timer = setTimeout(() => void poll(), 1_500);
    return {
      type: 'frame',
      url: result.checkoutUrl,
      completion,
      cancel() {
        if (!active) return;
        active = false;
        if (timer) clearTimeout(timer);
        settle();
      },
    };
  };

  const checkout: CheckoutCapability = {
    async open(options) {
      const checkoutResult = await createCheckout(options.featureKey, options);
      if (checkoutResult.alreadyOwned) return checkoutResult;
      const presenter = deps.presenter ?? defaultAccessPresenter;
      const presented = await presenter({
        featureKey: options.featureKey,
        reason: 'PURCHASE_REQUIRED',
        action: 'CHECKOUT',
        perform: async () => openCheckout(checkoutResult, options.featureKey),
      });
      if (presented === 'dismissed') throw cancelled();
      return checkoutResult;
    },
  };

  const access: AccessCapability = {
    async getFeatures() {
      await deps.ready();
      const response = objectBody(
        (
          await deps.session.request({
            method: 'GET',
            path: '/v1/public/work-sdk/access/features',
          })
        ).body,
      );
      if (!Array.isArray(response.features) || response.features.length > 100) {
        throw malformedResponse();
      }
      return response.features.map(parseFeaturePresentation);
    },
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
        const followTarget = nextAction === 'FOLLOW' ? (await follow.getState()).target : undefined;
        const checkoutResult =
          nextAction === 'CHECKOUT' ? await createCheckout(featureKey) : undefined;
        if (checkoutResult?.alreadyOwned) {
          decision = await this.check(featureKey);
          continue;
        }
        const result = await presenter({
          featureKey,
          reason: decision.reason,
          action: nextAction,
          ...(followTarget ? { followTarget } : {}),
          perform: async () => {
            if (nextAction === 'SIGN_IN') {
              return startSignIn();
            } else if (nextAction === 'FOLLOW') {
              await follow.follow();
              return { type: 'completed' };
            } else {
              return openCheckout(checkoutResult!, featureKey);
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
