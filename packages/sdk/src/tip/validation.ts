import { ViceMeError } from '../core/errors.ts';
import type { TipOpenOptions, TipProvider } from './index.ts';

const TIP_PROVIDERS: ReadonlySet<string> = new Set(['WECHAT_PAY', 'ALIPAY']);
const TIP_OPEN_OPTION_KEYS: ReadonlySet<string> = new Set([
  'amountCents',
  'provider',
  'locale',
  'appearance',
]);

export function isTipProvider(value: unknown): value is TipProvider {
  return typeof value === 'string' && TIP_PROVIDERS.has(value);
}

export function isValidTipWorkTitle(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const length = Array.from(value).length;
  return length >= 1 && length <= 200;
}

export function tipOptionInvalid(): ViceMeError {
  return new ViceMeError({
    code: 'CONFIG_INVALID',
    message: 'Tip open options are invalid.',
    retryable: false,
    capability: 'tip',
  });
}

export function parseTipOpenOptions(input: unknown): TipOpenOptions {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw tipOptionInvalid();
  }
  const raw = input as Record<string, unknown>;
  if (Object.keys(raw).some((key) => !TIP_OPEN_OPTION_KEYS.has(key))) {
    throw tipOptionInvalid();
  }
  if (
    typeof raw.amountCents !== 'number' ||
    !Number.isInteger(raw.amountCents) ||
    raw.amountCents < 100 ||
    raw.amountCents > 20_000
  ) {
    throw tipOptionInvalid();
  }
  if (raw.provider !== undefined && !isTipProvider(raw.provider)) throw tipOptionInvalid();
  if (raw.locale !== undefined && raw.locale !== 'zh-CN' && raw.locale !== 'en-US') {
    throw tipOptionInvalid();
  }
  if (
    raw.appearance !== undefined &&
    raw.appearance !== 'light' &&
    raw.appearance !== 'dark' &&
    raw.appearance !== 'auto'
  ) {
    throw tipOptionInvalid();
  }
  return {
    amountCents: raw.amountCents,
    ...(raw.provider === undefined ? {} : { provider: raw.provider }),
    ...(raw.locale === undefined ? {} : { locale: raw.locale }),
    ...(raw.appearance === undefined ? {} : { appearance: raw.appearance }),
  };
}
