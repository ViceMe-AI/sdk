/**
 * `@viceme-ai/sdk` public entry.
 *
 * Production consumers get `createViceMe` plus public types. Test injection
 * lives under `@viceme-ai/sdk/testing`.
 */

import { createFetchTransport } from './transport/transport.ts';
import { resolveApiBaseUrl, validatePublicConfig } from './core/config.ts';
import { ViceMeClientImpl } from './core/client.ts';
import { ViceMeError, isViceMeError, type ViceMeErrorCode } from './core/errors.ts';
import type { ViceMeClient, ViceMeMountedInstance } from './core/client.ts';
import type { ViceMeRegion, ViceMeConfig } from './core/config.ts';
import type { ViceMeClientState } from './core/lifecycle.ts';
import type {
  AccessCapability,
  AccessDecision,
  AccessReason,
  AuthCapability,
  AuthState,
  CheckoutCapability,
  CheckoutOptions,
  CheckoutResult,
} from './core/capabilities.ts';
import type { WorkUser } from './session/session.ts';
import { SDK_VERSION, API_MAJOR } from './version.ts';

export { ViceMeError, isViceMeError, SDK_VERSION, API_MAJOR, resolveApiBaseUrl };
export type {
  ViceMeClient,
  ViceMeMountedInstance,
  ViceMeConfig,
  ViceMeRegion,
  ViceMeClientState,
  ViceMeErrorCode,
  AccessCapability,
  AccessDecision,
  AccessReason,
  AuthCapability,
  AuthState,
  CheckoutCapability,
  CheckoutOptions,
  CheckoutResult,
  WorkUser,
};

/**
 * Create a headless ViceMe client for one Work.
 *
 * @example
 * ```ts
 * const client = createViceMe({ workKey: 'wrk_public_xxx', region: 'cn' });
 * await client.ready();
 * client.destroy();
 * ```
 */
export function createViceMe(config: unknown): ViceMeClient {
  const validated = validatePublicConfig(config);
  const apiBaseUrl = resolveApiBaseUrl(validated.region);
  const transport = createFetchTransport({
    apiBaseUrl,
  });
  return new ViceMeClientImpl({ config: validated, transport });
}
