/**
 * `@viceme-ai/sdk` public entry.
 *
 * Production consumers get a local public-danmaku client plus public types.
 */

import { validatePublicConfig } from './core/config.ts';
import { ViceMeClientImpl } from './core/client.ts';
import { ViceMeError, isViceMeError, type ViceMeErrorCode } from './core/errors.ts';
import type { ViceMeClient, ViceMeMountedInstance } from './core/client.ts';
import type { ViceMeRegion, ViceMeConfig } from './core/config.ts';
import type { ViceMeClientState } from './core/lifecycle.ts';
import { SDK_VERSION, API_MAJOR } from './version.ts';

export { ViceMeError, isViceMeError, SDK_VERSION, API_MAJOR };
export type {
  ViceMeClient,
  ViceMeMountedInstance,
  ViceMeConfig,
  ViceMeRegion,
  ViceMeClientState,
  ViceMeErrorCode,
};

/**
 * Create a local public-danmaku client for one Work.
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
  return new ViceMeClientImpl(validated);
}
