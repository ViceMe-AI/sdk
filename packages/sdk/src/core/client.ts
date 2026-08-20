/**
 * Headless ViceMe client.
 *
 * `ready()` and access checks remain headless. Interactive authentication and
 * checkout touch `window` only when the caller explicitly invokes them. `ready()` is
 * idempotent per instance (shares one promise), `destroy()` is idempotent and
 * synchronously cancels requests and subscriptions; every business method on a
 * destroyed client fails with `CLIENT_DESTROYED`.
 */

import { clientDestroyed } from './errors.ts';
import { Lifecycle, type ViceMeClientState } from './lifecycle.ts';
import type { ViceMeConfig, ViceMeRegion } from './config.ts';
import { SessionManager } from '../session/session.ts';
import type { Transport } from '../transport/transport.ts';
import { API_MAJOR, SDK_VERSION } from '../version.ts';
import {
  createCapabilities,
  type AccessCapability,
  type AuthCapability,
  type CheckoutCapability,
} from './capabilities.ts';
import type { AccessPresenter } from './presentation.ts';

export interface ViceMeClient {
  readonly version: string;
  readonly workKey: string;
  readonly region: ViceMeRegion;
  readonly state: ViceMeClientState;
  readonly auth: AuthCapability;
  readonly access: AccessCapability;
  readonly checkout: CheckoutCapability;
  ready(): Promise<void>;
  hasCapability(name: string): boolean;
  destroy(): void;
}

export interface ViceMeMountedInstance {
  readonly instanceKey: string;
  readonly capability: string;
  destroy(): void;
}

/** Marker so in-flight requests cancelled by `destroy()` map to CLIENT_DESTROYED. */
class DestroySignalReason extends DOMException {
  constructor() {
    super('ViceMe client destroyed.', 'AbortError');
  }
}

export interface ViceMeClientDeps {
  config: ViceMeConfig;
  transport: Transport;
  /** Interaction override for the testing entry only. */
  presenter?: AccessPresenter;
  /** Injectable clock (testing only). */
  now?: () => number;
}

export class ViceMeClientImpl implements ViceMeClient {
  readonly #lifecycle = new Lifecycle();
  readonly #session: SessionManager;
  readonly #config: ViceMeConfig;
  readonly #internalSignal = new AbortController();
  #readyPromise: Promise<void> | undefined;
  readonly auth: AuthCapability;
  readonly access: AccessCapability;
  readonly checkout: CheckoutCapability;
  /** Detaches the caller-signal listener; undefined when none was attached. */
  #detachCallerAbort: (() => void) | undefined;

  constructor(deps: ViceMeClientDeps) {
    this.#config = deps.config;
    this.#session = new SessionManager({
      workKey: deps.config.workKey,
      transport: deps.transport,
      signal: this.#internalSignal.signal,
      ...(deps.now !== undefined ? { now: deps.now } : {}),
    });
    const capabilities = createCapabilities({
      session: this.#session,
      workKey: deps.config.workKey,
      presenter: deps.presenter,
      ready: () => this.ready(),
    });
    this.auth = capabilities.auth;
    this.access = capabilities.access;
    this.checkout = capabilities.checkout;
    const callerSignal = deps.config.signal;
    if (callerSignal) {
      // Propagate the caller's own abort reason when one was set.
      const abortInternal = () => {
        this.#internalSignal.abort(
          callerSignal.reason instanceof Error
            ? callerSignal.reason
            : new DOMException('Caller signal aborted.', 'AbortError'),
        );
      };
      // An already-aborted signal never fires the listener; check
      // synchronously so a pre-cancelled caller cannot issue session
      // requests or reach the network at all.
      if (callerSignal.aborted) abortInternal();
      else {
        callerSignal.addEventListener('abort', abortInternal, { once: true });
        this.#detachCallerAbort = () => {
          callerSignal.removeEventListener('abort', abortInternal);
        };
      }
    }
  }

  get version(): string {
    return SDK_VERSION;
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

  /** Internal: public API major, used by the loader registry namespace. */
  get apiMajor(): number {
    return API_MAJOR;
  }

  ready(): Promise<void> {
    if (this.#lifecycle.destroyed) return Promise.reject(clientDestroyed());
    this.#readyPromise ??= this.#initialize();
    return this.#readyPromise;
  }

  async #initialize(): Promise<void> {
    if (this.#lifecycle.destroyed) throw clientDestroyed();
    this.#lifecycle.transition('INITIALIZING');
    try {
      await this.#session.establish();
      if (this.#lifecycle.destroyed) throw clientDestroyed();
      this.#lifecycle.transition('READY');
    } catch (error) {
      // If the client was destroyed mid-flight, report CLIENT_DESTROYED and do
      // not attempt any further lifecycle transitions.
      if (this.#lifecycle.destroyed) throw clientDestroyed();
      this.#lifecycle.transition('FAILED');
      // Allow a later `ready()` retry instead of caching the failure forever.
      this.#readyPromise = undefined;
      this.#session.invalidate();
      throw error;
    }
  }

  hasCapability(name: string): boolean {
    if (this.#lifecycle.destroyed) return false;
    const capabilities = this.#session.snapshot?.work.capabilities;
    return capabilities !== undefined && capabilities.includes(name);
  }

  /** Names of capabilities enabled for this work (empty before `ready()`). */
  get capabilities(): readonly string[] {
    return this.#session.snapshot?.work.capabilities ?? [];
  }

  /**
   * Internal: mark one capability unavailable without taking down the client
   * (loader uses this when a feature chunk fails after the core is READY).
   */
  markDegraded(): void {
    if (this.#lifecycle.state === 'READY') this.#lifecycle.transition('DEGRADED');
  }

  /** Internal: session snapshot access for capability modules. */
  get sessionSnapshot() {
    return this.#session.snapshot;
  }

  destroy(): void {
    if (this.#lifecycle.destroyed) return;
    this.#lifecycle.transition('DESTROYED');
    this.#internalSignal.abort(new DestroySignalReason());
    this.#session.destroy();
    this.#lifecycle.clearListeners();
    this.#readyPromise = undefined;
    // A destroyed client must not stay reachable through the caller's own
    // (possibly long-lived, never-aborting) signal.
    this.#detachCallerAbort?.();
    this.#detachCallerAbort = undefined;
  }
}
