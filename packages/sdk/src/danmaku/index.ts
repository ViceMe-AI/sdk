import type { ViceMeClient } from '../core/client.ts';
import type { CapabilityMountHandle, CapabilityMountOptions } from '../loader/mount-handle.ts';
import { mount } from './mount.ts';

export { mount } from './mount.ts';
export { readDanmakuPageAnchor } from './anchor.ts';
export type { DanmakuPageAnchor } from './anchor.ts';

/** Explicit ESM/npm entry point; the CDN loader calls the same mount function. */
export function mountDanmaku(
  client: ViceMeClient,
  options: CapabilityMountOptions,
): Promise<CapabilityMountHandle> {
  return mount(client, options);
}
