import type { ViceMeClient } from '../core/client.ts';
import { BUILD_WIDGET_ORIGINS } from '../core/build-endpoints.ts';
import { isValidTipWorkKey } from '../core/config.ts';
import { clientDestroyed, ViceMeError } from '../core/errors.ts';
import type { TipClient, TipConfig, TipOpenOptions, TipOpenResult } from './index.ts';
import {
  isTipProvider,
  isValidTipWorkTitle,
  parseTipOpenOptions,
  tipOptionInvalid,
} from './validation.ts';

const TIP_CONFIG_KEYS = ['work', 'workKey', 'environment', 'currency', 'amount', 'providers'];
const TIP_WORK_KEYS = ['id', 'title'];
const TIP_AMOUNT_KEYS = ['minCents', 'maxCents', 'stepCents'];
const PUBLIC_ERROR_KEYS = ['statusCode', 'code', 'message', 'requestId'];
const HEADLESS_READY_KEYS = ['type', 'channel', 'workKey'];
const HEADLESS_PAID_KEYS = [
  'type',
  'channel',
  'workKey',
  'status',
  'work',
  'amountCents',
  'currency',
];
const HEADLESS_TERMINAL_KEYS = ['type', 'channel', 'workKey', 'status'];
const HEADLESS_READY_TIMEOUT_MS = 8_000;
const TIP_CONFIG_TIMEOUT_MS = 8_000;
const TIP_CONFIG_MAX_BYTES = 16 * 1024;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type WidgetAppearance = 'light' | 'dark';

function isStrictRecord(value: unknown, keys: string[]): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const actualKeys = Object.keys(value);
  return actualKeys.length === keys.length && keys.every((key) => actualKeys.includes(key));
}

function tipConfigInvalid(): ViceMeError {
  return new ViceMeError({
    code: 'TIP_CONFIG_INVALID',
    message: 'Shop returned an invalid Tip configuration.',
    retryable: false,
    capability: 'tip',
  });
}

function isCredentialsNotAllowedError(input: unknown): input is { requestId: string } {
  if (!isStrictRecord(input, PUBLIC_ERROR_KEYS)) return false;
  return (
    input.statusCode === 400 &&
    input.code === 'TIP_CONFIG_CREDENTIALS_NOT_ALLOWED' &&
    typeof input.message === 'string' &&
    typeof input.requestId === 'string' &&
    input.requestId.length >= 1 &&
    input.requestId.length <= 128
  );
}

function tipConfigCredentialsNotAllowed(requestId: string): ViceMeError {
  return new ViceMeError({
    code: 'TIP_CONFIG_CREDENTIALS_NOT_ALLOWED',
    message: 'Tip configuration requests must not include credentials.',
    retryable: false,
    requestId,
    capability: 'tip',
  });
}

function parseTipConfig(input: unknown, expectedWorkKey: string): TipConfig {
  if (!isStrictRecord(input, TIP_CONFIG_KEYS)) throw tipConfigInvalid();
  if (!isStrictRecord(input.work, TIP_WORK_KEYS)) throw tipConfigInvalid();
  if (
    typeof input.work.id !== 'string' ||
    !UUID_PATTERN.test(input.work.id) ||
    !isValidTipWorkTitle(input.work.title)
  ) {
    throw tipConfigInvalid();
  }
  if (!isValidTipWorkKey(input.workKey) || input.workKey !== expectedWorkKey) {
    throw tipConfigInvalid();
  }
  if (input.environment !== 'SANDBOX' && input.environment !== 'PRODUCTION') {
    throw tipConfigInvalid();
  }
  if (
    (input.workKey.startsWith('wrk_test_') && input.environment !== 'SANDBOX') ||
    (input.workKey.startsWith('wrk_live_') && input.environment !== 'PRODUCTION')
  ) {
    throw tipConfigInvalid();
  }
  if (input.currency !== 'CNY') throw tipConfigInvalid();
  if (
    !isStrictRecord(input.amount, TIP_AMOUNT_KEYS) ||
    input.amount.minCents !== 100 ||
    input.amount.maxCents !== 20_000 ||
    input.amount.stepCents !== 1
  ) {
    throw tipConfigInvalid();
  }
  if (
    !Array.isArray(input.providers) ||
    input.providers.length < 1 ||
    !input.providers.every(isTipProvider) ||
    new Set(input.providers).size !== input.providers.length
  ) {
    throw tipConfigInvalid();
  }

  return {
    work: { id: input.work.id, title: input.work.title },
    workKey: input.workKey,
    environment: input.environment,
    currency: input.currency,
    amount: { minCents: 100, maxCents: 20_000, stepCents: 1 },
    providers: [...input.providers],
  };
}

function parseHeadlessResult(
  input: unknown,
  channel: string,
  config: TipConfig,
  amountCents: number,
): TipOpenResult | undefined {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return undefined;
  const message = input as Record<string, unknown>;
  if (
    message.type !== 'viceme:tip-headless-result' ||
    message.channel !== channel ||
    message.workKey !== config.workKey
  ) {
    return undefined;
  }
  if (message.status === 'PAID') {
    if (
      !isStrictRecord(message, HEADLESS_PAID_KEYS) ||
      !isStrictRecord(message.work, TIP_WORK_KEYS) ||
      message.work.id !== config.work.id ||
      message.work.title !== config.work.title ||
      message.amountCents !== amountCents ||
      message.currency !== 'CNY'
    ) {
      return undefined;
    }
    return {
      status: 'PAID',
      work: { id: config.work.id, title: config.work.title },
      amountCents,
      currency: 'CNY',
    };
  }
  if (
    (message.status === 'CANCELLED' || message.status === 'UNKNOWN') &&
    isStrictRecord(message, HEADLESS_TERMINAL_KEYS)
  ) {
    return { status: message.status };
  }
  return undefined;
}

function internalTipError(): ViceMeError {
  return new ViceMeError({
    code: 'INTERNAL_ERROR',
    message: 'Unable to open the hosted Tip flow.',
    capability: 'tip',
  });
}

function tipCapabilityDisabled(): ViceMeError {
  return new ViceMeError({
    code: 'CAPABILITY_DISABLED',
    message: 'Tip is not available for this Work or region.',
    retryable: false,
    capability: 'tip',
  });
}

async function readTipConfigBody(response: Response): Promise<unknown> {
  const contentLength = response.headers.get('content-length');
  if (contentLength !== null) {
    const declaredBytes = Number(contentLength);
    if (
      !Number.isInteger(declaredBytes) ||
      declaredBytes < 0 ||
      declaredBytes > TIP_CONFIG_MAX_BYTES
    ) {
      await response.body?.cancel().catch(() => undefined);
      throw tipConfigInvalid();
    }
  }

  const reader = response.body?.getReader();
  if (!reader) throw tipConfigInvalid();

  const decoder = new TextDecoder('utf-8', { fatal: true });
  let bytes = 0;
  let text = '';
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > TIP_CONFIG_MAX_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw tipConfigInvalid();
      }
      try {
        text += decoder.decode(chunk.value, { stream: true });
      } catch {
        await reader.cancel().catch(() => undefined);
        throw tipConfigInvalid();
      }
    }
    try {
      text += decoder.decode();
    } catch {
      await reader.cancel().catch(() => undefined);
      throw tipConfigInvalid();
    }
  } finally {
    reader.releaseLock();
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw tipConfigInvalid();
  }
}

async function fetchTipConfig(client: ViceMeClient, ownerSignal: AbortSignal): Promise<TipConfig> {
  await client.ready();
  if (!client.hasCapability('tip')) throw tipCapabilityDisabled();
  if (client.region !== 'cn') throw tipCapabilityDisabled();
  if (!isValidTipWorkKey(client.workKey)) throw tipCapabilityDisabled();
  if (ownerSignal.aborted) throw clientDestroyed();
  const controller = new AbortController();
  const abortRequest = (): void => controller.abort();
  ownerSignal.addEventListener('abort', abortRequest, { once: true });
  const timeout = globalThis.setTimeout(() => controller.abort(), TIP_CONFIG_TIMEOUT_MS);
  const widgetOrigin = BUILD_WIDGET_ORIGINS[client.region];
  const requestUrl = new URL(
    `/v1/work-sdk/${encodeURIComponent(client.workKey)}/tip-config`,
    widgetOrigin,
  );
  try {
    const response = await fetch(requestUrl.toString(), {
      method: 'GET',
      credentials: 'omit',
      redirect: 'error',
      headers: { accept: 'application/json' },
      signal: controller.signal,
    });
    const contentType = response.headers
      .get('content-type')
      ?.split(';', 1)[0]
      ?.trim()
      .toLowerCase();
    let responseOrigin: string | undefined;
    try {
      responseOrigin = response.url ? new URL(response.url).origin : undefined;
    } catch {
      responseOrigin = 'invalid';
    }
    if (response.status !== 200) {
      if (response.status === 404) {
        await response.body?.cancel().catch(() => undefined);
        throw tipCapabilityDisabled();
      }
      if (
        response.status === 400 &&
        contentType === 'application/json' &&
        (!responseOrigin || responseOrigin === widgetOrigin)
      ) {
        let body: unknown;
        try {
          body = await readTipConfigBody(response);
        } catch {
          throw internalTipError();
        }
        if (isCredentialsNotAllowedError(body)) {
          throw tipConfigCredentialsNotAllowed(body.requestId);
        }
      } else {
        await response.body?.cancel().catch(() => undefined);
      }
      throw new ViceMeError({
        code: 'INTERNAL_ERROR',
        message: 'Unable to load Tip configuration.',
        capability: 'tip',
      });
    }
    if (contentType !== 'application/json' || (responseOrigin && responseOrigin !== widgetOrigin)) {
      await response.body?.cancel().catch(() => undefined);
      throw tipConfigInvalid();
    }
    const body = await readTipConfigBody(response);
    return parseTipConfig(body, client.workKey);
  } catch (error) {
    if (ownerSignal.aborted) throw clientDestroyed();
    if (error instanceof ViceMeError) throw error;
    throw internalTipError();
  } finally {
    controller.abort();
    globalThis.clearTimeout(timeout);
    ownerSignal.removeEventListener('abort', abortRequest);
  }
}

function copyTipConfig(config: TipConfig): TipConfig {
  return {
    work: { ...config.work },
    workKey: config.workKey,
    environment: config.environment,
    currency: config.currency,
    amount: { ...config.amount },
    providers: [...config.providers],
  };
}

export function createHeadlessTip(client: ViceMeClient): TipClient {
  let destroyed = false;
  let cancelActive: (() => void) | undefined;
  let configPromise: Promise<TipConfig> | undefined;
  const configController = new AbortController();
  const isDestroyed = (): boolean => destroyed || client.state === 'DESTROYED';

  const loadTrustedConfig = (): Promise<TipConfig> => {
    if (!configPromise) {
      const pending = fetchTipConfig(client, configController.signal);
      configPromise = pending;
      void pending.then(
        () => {
          if (configPromise === pending) configPromise = undefined;
        },
        () => {
          if (configPromise === pending) configPromise = undefined;
        },
      );
    }
    return configPromise;
  };

  return {
    async getConfig(): Promise<TipConfig> {
      if (isDestroyed()) throw clientDestroyed();
      const config = await loadTrustedConfig();
      if (isDestroyed()) throw clientDestroyed();
      return copyTipConfig(config);
    },

    open(input: TipOpenOptions): Promise<TipOpenResult> {
      if (isDestroyed()) return Promise.reject(clientDestroyed());
      if (cancelActive) {
        return Promise.reject(
          new ViceMeError({
            code: 'TIP_OPEN_IN_PROGRESS',
            message: 'This Tip client already has an open flow.',
            retryable: false,
            capability: 'tip',
          }),
        );
      }
      if (!client.hasCapability('tip')) {
        return Promise.reject(tipCapabilityDisabled());
      }
      if (client.region !== 'cn') return Promise.reject(tipCapabilityDisabled());
      if (!isValidTipWorkKey(client.workKey)) return Promise.reject(tipCapabilityDisabled());

      let options: TipOpenOptions;
      try {
        options = parseTipOpenOptions(input);
      } catch (error) {
        return Promise.reject(error);
      }

      if (typeof document === 'undefined') {
        return Promise.reject(tipOptionInvalid());
      }
      const documentObject = document;
      const windowObject = documentObject.defaultView;
      if (!documentObject.body || !windowObject) return Promise.reject(tipOptionInvalid());
      const widgetOrigin = BUILD_WIDGET_ORIGINS[client.region];
      const hostLanguage = documentObject.documentElement.lang || windowObject.navigator.language;
      const locale =
        options.locale ?? (hostLanguage.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en-US');
      const requestedAppearance = options.appearance ?? 'auto';
      const appearance: WidgetAppearance =
        requestedAppearance === 'auto'
          ? windowObject.matchMedia('(prefers-color-scheme: dark)').matches
            ? 'dark'
            : 'light'
          : requestedAppearance;

      let channel: string;
      let clientReady: Promise<void>;
      try {
        const channelBytes = new Uint8Array(16);
        windowObject.crypto.getRandomValues(channelBytes);
        channel = Array.from(channelBytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
        clientReady = client.ready();
      } catch {
        return Promise.reject(internalTipError());
      }

      const portal = documentObject.createElement('div');
      portal.dataset.vicemeTipHeadless = 'open';
      portal.style.all = 'initial';
      portal.style.position = 'fixed';
      portal.style.inset = '0';
      portal.style.display = 'block';
      portal.style.width = '100vw';
      portal.style.height = '100vh';
      portal.style.zIndex = '2147483647';

      const frame = documentObject.createElement('iframe');
      const frameUrl = new URL(`/widget/tip/${encodeURIComponent(client.workKey)}`, widgetOrigin);
      frameUrl.searchParams.set('mode', 'headless');
      frameUrl.searchParams.set('channel', channel);
      frameUrl.searchParams.set('appearance', appearance);
      frameUrl.searchParams.set('locale', locale);
      frame.title = 'ViceMe Tip';
      frame.src = frameUrl.toString();
      frame.loading = 'eager';
      frame.referrerPolicy = 'strict-origin';
      frame.setAttribute(
        'sandbox',
        'allow-forms allow-popups allow-popups-to-escape-sandbox allow-same-origin allow-scripts',
      );
      frame.setAttribute('allow', 'payment');
      frame.style.display = 'block';
      frame.style.width = '100%';
      frame.style.height = '100%';
      frame.style.border = '0';
      frame.style.background = 'transparent';
      frame.style.colorScheme = appearance;
      portal.attachShadow({ mode: 'open' }).append(frame);

      let settled = false;
      let ready = false;
      let initialized = false;
      let trustedConfig: TipConfig | undefined;
      let readyTimer: number | undefined;
      let resolveOpen: (result: TipOpenResult) => void;
      let rejectOpen: (error: unknown) => void;
      const pending = new Promise<TipOpenResult>((resolve, reject) => {
        resolveOpen = resolve;
        rejectOpen = reject;
      });

      const cleanup = (): void => {
        if (readyTimer !== undefined) {
          windowObject.clearTimeout(readyTimer);
          readyTimer = undefined;
        }
        windowObject.removeEventListener('message', onMessage);
        portal.remove();
        if (cancelActive === cancel) cancelActive = undefined;
      };
      const finish = (result: TipOpenResult): void => {
        if (settled) return;
        settled = true;
        cleanup();
        resolveOpen(result);
      };
      const fail = (error: unknown): void => {
        if (settled) return;
        settled = true;
        cleanup();
        rejectOpen(error);
      };
      const cancel = (): void => finish({ status: 'UNKNOWN' });
      const initialize = (): void => {
        if (!ready || !trustedConfig || initialized || settled) return;
        if (options.provider && !trustedConfig.providers.includes(options.provider)) {
          fail(tipOptionInvalid());
          return;
        }
        initialized = true;
        const init = {
          type: 'viceme:tip-headless-init',
          channel,
          workKey: client.workKey,
          amountCents: options.amountCents,
          ...(options.provider === undefined ? {} : { provider: options.provider }),
          locale,
          appearance,
        };
        try {
          const frameWindow = frame.contentWindow;
          if (!frameWindow) {
            fail(internalTipError());
            return;
          }
          frameWindow.postMessage(init, widgetOrigin);
        } catch {
          fail(internalTipError());
        }
      };
      const onMessage = (event: MessageEvent<unknown>): void => {
        if (event.origin !== widgetOrigin || event.source !== frame.contentWindow) return;
        if (!initialized) {
          if (!isStrictRecord(event.data, HEADLESS_READY_KEYS)) return;
          if (
            event.data.type !== 'viceme:tip-headless-ready' ||
            event.data.channel !== channel ||
            event.data.workKey !== client.workKey
          ) {
            return;
          }
          ready = true;
          if (readyTimer !== undefined) {
            windowObject.clearTimeout(readyTimer);
            readyTimer = undefined;
          }
          initialize();
          return;
        }
        if (!trustedConfig) return;
        const result = parseHeadlessResult(event.data, channel, trustedConfig, options.amountCents);
        if (result && result.status !== 'UNKNOWN') finish(result);
      };

      cancelActive = cancel;
      windowObject.addEventListener('message', onMessage);
      readyTimer = windowObject.setTimeout(() => {
        fail(
          new ViceMeError({
            code: 'TIP_READY_TIMEOUT',
            message: 'Hosted Tip did not become ready in time.',
            retryable: true,
            capability: 'tip',
          }),
        );
      }, HEADLESS_READY_TIMEOUT_MS);
      documentObject.body.append(portal);
      void clientReady.catch((error: unknown) => {
        fail(error instanceof ViceMeError ? error : internalTipError());
      });
      void loadTrustedConfig()
        .then((config) => {
          trustedConfig = config;
          initialize();
        })
        .catch((error: unknown) => {
          fail(error instanceof ViceMeError ? error : internalTipError());
        });

      return pending;
    },

    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      configController.abort();
      cancelActive?.();
    },
  };
}
