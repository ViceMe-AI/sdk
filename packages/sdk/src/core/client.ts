/**
 * Local ViceMe client for the public hosted danmaku capability.
 *
 * Initialization performs no network request. The static loader owns release
 * manifest/chunk loading, while the hosted iframe owns Shop API calls.
 */

import { clientDestroyed } from './errors.ts';
import { Lifecycle, type ViceMeClientState } from './lifecycle.ts';
import type { ViceMeConfig, ViceMeRegion } from './config.ts';

const MARK_DEGRADED = Symbol('ViceMeClient.markDegraded');

interface DegradableViceMeClient {
  [MARK_DEGRADED](): void;
}

export interface ViceMeClient {
  readonly workKey: string;
  readonly region: ViceMeRegion;
  readonly state: ViceMeClientState;
  ready(): Promise<void>;
  hasCapability(name: string): boolean;
  destroy(): void;
}

export interface ViceMeMountedInstance {
  readonly instanceKey: string;
  readonly capability: string;
  destroy(): void;
}

/** Internal loader hook; not part of the client object's string-keyed surface. */
export function markClientDegraded(client: ViceMeClient): void {
  if (MARK_DEGRADED in client) {
    (client as ViceMeClient & DegradableViceMeClient)[MARK_DEGRADED]();
  }
}

export class ViceMeClientImpl implements ViceMeClient {
  readonly #lifecycle = new Lifecycle();
  readonly #config: ViceMeConfig;
  #readyPromise: Promise<void> | undefined;

  constructor(config: ViceMeConfig) {
    this.#config = config;
  }

  get workKey(): string {
    return this.#config.workKey;
  }

  get region(): ViceMeRegion {
    return this.#config.region;
  }

  get state(): ViceMeClientState {
    return this.#lifecycle.state;
  }

  ready(): Promise<void> {
    if (this.#lifecycle.destroyed) return Promise.reject(clientDestroyed());
    if (!this.#readyPromise) {
      this.#lifecycle.transition('READY');
      this.#readyPromise = Promise.resolve();
    }
    return this.#readyPromise;
  }

  hasCapability(name: string): boolean {
    return !this.#lifecycle.destroyed && name === 'danmaku';
  }

  /**
   * Internal: mark one capability unavailable without taking down the client
   * (loader uses this when a feature chunk fails after the core is READY).
   */
  [MARK_DEGRADED](): void {
    if (this.#lifecycle.state === 'READY') this.#lifecycle.transition('DEGRADED');
  }

  destroy(): void {
    if (this.#lifecycle.destroyed) return;
    this.#lifecycle.transition('DESTROYED');
    this.#lifecycle.clearListeners();
    this.#readyPromise = undefined;
  }
}
