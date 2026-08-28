/**
 * Public client configuration.
 *
 * Production `createViceMe()` accepts exactly `workKey` and `region`.
 * Endpoints, credentials, access policy, and provider state are not client
 * configuration: the hosted Shop runtime owns those concerns.
 */

import { configInvalid } from './errors.ts';
export type ViceMeRegion = 'cn' | 'global';

export interface ViceMeConfig {
  /** Public opaque Work key (`wrk_...`). It is not a secret. */
  workKey: string;
  /** Selects the hosted Shop region. */
  region: ViceMeRegion;
}

const REGIONS: ReadonlySet<string> = new Set(['cn', 'global']);

export function isValidWorkKey(value: unknown): value is string {
  return typeof value === 'string' && /^wrk_[A-Za-z0-9_-]{4,124}$/.test(value);
}

export function isValidTipWorkKey(value: unknown): value is string {
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

  const known = new Set(['workKey', 'region']);
  for (const key of Object.keys(raw)) {
    if (!known.has(key)) {
      throw configInvalid(`Unknown configuration field "${key}".`);
    }
  }
  if (!isValidWorkKey(raw.workKey)) {
    throw configInvalid('Configuration field "workKey" must be a public work key ("wrk_...").');
  }
  if (!isValidRegion(raw.region)) {
    throw configInvalid('Configuration field "region" must be "cn" or "global".');
  }
  return {
    workKey: raw.workKey,
    region: raw.region,
  };
}
