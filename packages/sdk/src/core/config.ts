/**
 * Public client configuration.
 *
 * Production `createViceMe()` accepts exactly `workKey`, `region`, and
 * `signal`. Anything else (transport, clock, request ids, base URLs) is a
 * testing-only concern and lives in `@viceme-ai/sdk/testing`, so Agents can
 * never bake temporary or internal endpoints into user projects.
 */

import { configInvalid } from './errors.ts';
import { BUILD_API_BASE_URLS } from './build-endpoints.ts';
export type ViceMeRegion = 'cn' | 'global';

export interface ViceMeConfig {
  /** Public opaque test or live Work key. It is not a secret. */
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
  cn: BUILD_API_BASE_URLS.cn,
  global: BUILD_API_BASE_URLS.global,
};

export function resolveApiBaseUrl(region: ViceMeRegion): string {
  return PUBLIC_API_BASE_URLS[region];
}

export function isValidWorkKey(value: unknown): value is string {
  return typeof value === 'string' && /^wrk_(?:test|live)_[A-Za-z0-9_-]{4,119}$/.test(value);
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
    throw configInvalid(
      'Configuration field "workKey" must start with "wrk_test_" or "wrk_live_".',
    );
  }
  if (!isValidRegion(raw.region)) {
    throw configInvalid('Configuration field "region" must be "cn" or "global".');
  }
  if (raw.signal !== undefined && !(raw.signal instanceof AbortSignal)) {
    throw configInvalid('Configuration field "signal" must be an AbortSignal.');
  }
  return {
    workKey: raw.workKey,
    region: raw.region,
    signal: raw.signal,
  };
}
