/**
 * `@viceme-ai/sdk` public entry.
 *
 * Production consumers get exactly `createViceMe` plus types. Test injection
 * lives under `@viceme-ai/sdk/testing`. Capability subpaths (danmaku, payment)
 * are added only when the capability is real.
 */

import { createFetchTransport } from './transport/transport.ts';
import { resolveApiBaseUrl, validatePublicConfig } from './core/config.ts';
import { ViceMeClientImpl } from './core/client.ts';
import { ViceMeError, isViceMeError, type ViceMeErrorCode } from './core/errors.ts';
import type { ViceMeClient, ViceMeMountedInstance } from './core/client.ts';
import type { ViceMeRegion, ViceMeConfig } from './core/config.ts';
import type { ViceMeClientState } from './core/lifecycle.ts';
import { SDK_VERSION, API_MAJOR } from './version.ts';

export { ViceMeError, isViceMeError, SDK_VERSION, API_MAJOR, resolveApiBaseUrl };
export type {
  ViceMeClient,
  ViceMeMountedInstance,
  ViceMeConfig,
  ViceMeRegion,
  ViceMeClientState,
  ViceMeErrorCode,
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
  const transport = createFetchTransport({
    apiBaseUrl: resolveApiBaseUrl(validated.region),
  });
  return new ViceMeClientImpl({ config: validated, transport });
}
