import type { ViceMeClient } from '../core/client.ts';
import { createHeadlessTip } from './headless.ts';
import { mount } from './mount.ts';

export type TipProvider = 'WECHAT_PAY' | 'ALIPAY';

export interface TipConfig {
  work: {
    id: string;
    title: string;
  };
  workKey: string;
  environment: 'SANDBOX' | 'PRODUCTION';
  currency: 'CNY';
  amount: {
    minCents: 100;
    maxCents: 20_000;
    stepCents: 1;
  };
  providers: TipProvider[];
}

export interface TipOpenOptions {
  amountCents: number;
  provider?: TipProvider;
  locale?: 'zh-CN' | 'en-US';
  appearance?: 'light' | 'dark' | 'auto';
}

export type TipOpenResult =
  | {
      status: 'PAID';
      work: {
        id: string;
        title: string;
      };
      amountCents: number;
      currency: 'CNY';
    }
  | { status: 'CANCELLED' }
  | { status: 'UNKNOWN' };

export interface TipClient {
  getConfig(): Promise<TipConfig>;
  open(options: TipOpenOptions): Promise<TipOpenResult>;
  destroy(): void;
}

export interface TipMountOptions {
  target: Element;
  theme: 'light' | 'dark' | 'auto';
  signal?: AbortSignal;
}

export interface TipMountHandle {
  readonly capability: 'tip';
  destroy(): void;
}

export interface TipWidgetCloseDetail {
  workId: string;
}

export interface TipPaidDetail {
  status: 'PAID';
  work: {
    id: string;
    title: string;
  };
  amountCents: number;
  currency: 'CNY';
}

const mounts = new WeakMap<ViceMeClient, WeakMap<Element, Promise<TipMountHandle>>>();

/** Create a framework-independent controller for a host-rendered Tip flow. */
export function createTip(client: ViceMeClient): TipClient {
  return createHeadlessTip(client);
}

/** Explicit ESM/npm entry point; the CDN loader calls the same mount function. */
export function mountTip(client: ViceMeClient, options: TipMountOptions): Promise<TipMountHandle> {
  let byTarget = mounts.get(client);
  if (!byTarget) {
    byTarget = new WeakMap();
    mounts.set(client, byTarget);
  }
  const existing = byTarget.get(options.target);
  if (existing) return existing;

  const pending: Promise<TipMountHandle> = mount(client, options)
    .then((raw) => {
      let destroyed = false;
      const handle: TipMountHandle = {
        capability: 'tip' as const,
        destroy(): void {
          if (destroyed) return;
          destroyed = true;
          options.signal?.removeEventListener('abort', handle.destroy);
          if (byTarget.get(options.target) === pending) byTarget.delete(options.target);
          raw.destroy();
        },
      };
      options.signal?.addEventListener('abort', handle.destroy, { once: true });
      if (options.signal?.aborted) handle.destroy();
      return handle;
    })
    .catch((error: unknown) => {
      if (byTarget.get(options.target) === pending) byTarget.delete(options.target);
      throw error;
    });
  byTarget.set(options.target, pending);
  return pending;
}
