/**
 * Public client configuration.
 *
 * Production `createViceMe()` accepts exactly `workKey`, `region`, and
 * `signal`. Anything else (transport, clock, request ids, base URLs) is a
 * testing-only concern and lives in `@viceme-ai/sdk/testing`, so Agents can
 * never bake temporary or internal endpoints into user projects.
 */

import { configInvalid } from './errors.ts';

export type ViceMeRegion = 'cn' | 'global';

export interface ViceMeConfig {
  /** Public opaque work key (`wrk_…`). Locates a Work; it is not a secret. */
  workKey: string;
  /** Routes public API and CDN traffic. */
  region: ViceMeRegion;
  /** Optional abort signal owned by the host page. */
  signal?: AbortSignal;
}

const REGIONS: ReadonlySet<string> = new Set(['cn', 'global']);

/**
 * Public API origins per region. These are the only production endpoints the
 * SDK may contact; B1 confirms final hostnames and any change happens here in
 * one place (never via a public `apiBaseUrl` option).
 */
export const PUBLIC_API_BASE_URLS: Readonly<Record<ViceMeRegion, string>> = {
  cn: 'https://api.viceme.cn/v1',
  global: 'https://api.viceme.ai/v1',
};

export function resolveApiBaseUrl(region: ViceMeRegion): string {
  return PUBLIC_API_BASE_URLS[region];
}

export function isValidWorkKey(value: unknown): value is string {
  return typeof value === 'string' && /^wrk_[A-Za-z0-9_-]{4,124}$/.test(value);
}

export function isValidRegion(value: unknown): value is ViceMeRegion {
  return typeof value === 'string' && REGIONS.has(value);
}

/**
 * Validate unknown input as a public client config. Throws a CONFIG_INVALID
 * ViceMeError that never echoes values back beyond the offending field name.
 */
export function validatePublicConfig(input: unknown): ViceMeConfig {
  if (typeof input !== 'object' || input === null) {
    throw configInvalid('createViceMe expects a configuration object.');
  }
  const raw = input as Record<string, unknown>;

  const known = new Set(['workKey', 'region', 'signal']);
  for (const key of Object.keys(raw)) {
    if (!known.has(key)) {
      throw configInvalid(`Unknown configuration field "${key}".`);
    }
  }
  if (!isValidWorkKey(raw.workKey)) {
    throw configInvalid('Configuration field "workKey" must be a public work key ("wrk_…").');
  }
  if (!isValidRegion(raw.region)) {
    throw configInvalid('Configuration field "region" must be "cn" or "global".');
  }
  if (raw.signal !== undefined && !(raw.signal instanceof AbortSignal)) {
    throw configInvalid('Configuration field "signal" must be an AbortSignal.');
  }
  return { workKey: raw.workKey, region: raw.region, signal: raw.signal };
}
