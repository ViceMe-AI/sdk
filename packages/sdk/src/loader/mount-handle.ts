/**
 * The handle the danmaku `mount()` returns to the loader (no
 * registry/identity concerns). The loader wraps it into the public
 * `ViceMeMountedInstance`, which carries the registry-assigned `instanceKey`
 * and owns idempotent destroy + event dispatch.
 */

import type { ViceMeClient } from '../core/client.ts';
import type { ViceMeTheme } from './attributes.ts';

export interface CapabilityMountOptions {
  /** Mount host element; the capability owns its Shadow DOM subtree. */
  target: Element;
  theme: ViceMeTheme;
}

/** A capability's own lifecycle handle — no `instanceKey`, no registry. */
export interface CapabilityMountHandle {
  readonly capability: string;
  /** Remove listeners, observers, timers, portals, and Shadow DOM nodes. */
  destroy(): void;
}

export type CapabilityMountFunction = (
  client: ViceMeClient,
  options: CapabilityMountOptions,
) => Promise<CapabilityMountHandle>;

/** Convenience for ESM-direct capability entry points. */
export interface ViceMeCapabilityModule {
  mount: CapabilityMountFunction;
}
