/**
 * Loader registry.
 *
 * Only the CDN loader maintains this registry (explicit `createViceMe()`
 * instances never register). Local clients are shared by
 * `major + region + workKey`; danmaku mounts are deduplicated by
 * `clientKey + capability + target Element identity`.
 *
 * The registry itself is never exposed on `window` — only the fixed
 * `ViceMe.versions.v1` diagnostics/destroy namespace is. It stores raw
 * capability handles; the loader wraps them into the public
 * `ViceMeMountedInstance` and owns destroy/event deduplication.
 */

import type { ViceMeClient } from '../core/client.ts';
import type { CapabilityMountHandle } from './mount-handle.ts';

export interface RegisteredClient {
  clientKey: string;
  client: ViceMeClient;
  ready: Promise<void>;
}

export interface RegisteredInstance {
  instanceKey: string;
  clientKey: string;
  capability: string;
  host: Element;
  raw: CapabilityMountHandle;
  destroyed: boolean;
}

export function clientKeyOf(majorVersion: number, region: string, workKey: string): string {
  return `v${majorVersion}+${region}+${workKey}`;
}

export class LoaderRegistry {
  readonly #clients = new Map<string, RegisteredClient>();
  readonly #instances = new Map<string, RegisteredInstance>();
  /** (clientKey, capability) -> mounted host element -> instance. */
  readonly #elements = new Map<string, WeakMap<Element, RegisteredInstance>>();
  #elementCounter = 0;

  getClient(clientKey: string): RegisteredClient | undefined {
    return this.#clients.get(clientKey);
  }

  registerClient(entry: RegisteredClient): void {
    this.#clients.set(entry.clientKey, entry);
  }

  unregisterClient(clientKey: string): void {
    this.#clients.delete(clientKey);
  }

  getInstance(instanceKey: string): RegisteredInstance | undefined {
    return this.#instances.get(instanceKey);
  }

  /** Existing mount for the same client+capability+element, if any. */
  findInstance(
    clientKey: string,
    capability: string,
    element: Element,
  ): RegisteredInstance | undefined {
    return this.#elements.get(`${clientKey}::${capability}`)?.get(element);
  }

  registerInstance(
    clientKey: string,
    capability: string,
    element: Element,
    raw: CapabilityMountHandle,
  ): RegisteredInstance {
    const compositeKey = `${clientKey}::${capability}`;
    let byElement = this.#elements.get(compositeKey);
    if (byElement === undefined) {
      byElement = new WeakMap();
      this.#elements.set(compositeKey, byElement);
    }
    const existing = byElement.get(element);
    if (existing) return existing;

    this.#elementCounter += 1;
    const instance: RegisteredInstance = {
      instanceKey: `${clientKey}::${capability}::el${this.#elementCounter}`,
      clientKey,
      capability,
      host: element,
      raw,
      destroyed: false,
    };
    this.#instances.set(instance.instanceKey, instance);
    byElement.set(element, instance);
    return instance;
  }

  removeInstance(instanceKey: string): RegisteredInstance | undefined {
    const instance = this.#instances.get(instanceKey);
    if (!instance) return undefined;
    this.#instances.delete(instanceKey);
    this.#elements.get(`${instance.clientKey}::${instance.capability}`)?.delete(instance.host);
    return instance;
  }

  instancesForClient(clientKey: string): RegisteredInstance[] {
    return [...this.#instances.values()].filter((i) => i.clientKey === clientKey);
  }
}
