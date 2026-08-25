import type { ViceMeClient } from '../core/client.ts';
import { mount } from './mount.ts';

export interface DanmakuMountOptions {
  target: Element;
  theme: 'light' | 'dark' | 'auto';
}

export interface DanmakuMountHandle {
  readonly capability: 'danmaku';
  destroy(): void;
}

const mounts = new WeakMap<ViceMeClient, WeakMap<Element, Promise<DanmakuMountHandle>>>();

/** Explicit ESM/npm entry point; the CDN loader calls the same mount function. */
export function mountDanmaku(
  client: ViceMeClient,
  options: DanmakuMountOptions,
): Promise<DanmakuMountHandle> {
  let byTarget = mounts.get(client);
  if (!byTarget) {
    byTarget = new WeakMap();
    mounts.set(client, byTarget);
  }
  const existing = byTarget.get(options.target);
  if (existing) return existing;

  const pending: Promise<DanmakuMountHandle> = mount(client, options)
    .then((raw) => {
      let destroyed = false;
      return {
        capability: 'danmaku' as const,
        destroy(): void {
          if (destroyed) return;
          destroyed = true;
          if (byTarget.get(options.target) === pending) byTarget.delete(options.target);
          raw.destroy();
        },
      };
    })
    .catch((error: unknown) => {
      if (byTarget.get(options.target) === pending) byTarget.delete(options.target);
      throw error;
    });
  byTarget.set(options.target, pending);
  return pending;
}
