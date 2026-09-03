import type { ViceMeClient } from './core/client.ts';

export interface CapabilityMountOptions {
  /** Mount host element; the capability owns its Shadow DOM subtree. */
  target: Element;
  theme: 'light' | 'dark' | 'auto';
  /** Use the shared danmaku controls as the visible Tip launcher. */
  presentation?: 'inline' | 'integrated';
  /** Abort a mount that has not completed and destroy it after completion. */
  signal?: AbortSignal;
}

/** A capability's own lifecycle handle; the loader assigns public identity. */
export interface CapabilityMountHandle {
  readonly capability: string;
  destroy(): void;
}

export type CapabilityMountFunction = (
  client: ViceMeClient,
  options: CapabilityMountOptions,
) => Promise<CapabilityMountHandle>;
