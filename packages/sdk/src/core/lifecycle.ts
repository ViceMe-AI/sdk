/**
 * Client lifecycle state machine.
 *
 * ```text
 * CREATED -> READY -> DESTROYED
 * READY -> DEGRADED (single capability unavailable; host page keeps working)
 * ```
 *
 * State is exposed read-only; consumers can never assign it directly.
 */

import { ViceMeError, clientDestroyed } from './errors.ts';

export type ViceMeClientState = 'CREATED' | 'READY' | 'DEGRADED' | 'DESTROYED';

const ALLOWED_TRANSITIONS: Readonly<Record<ViceMeClientState, readonly ViceMeClientState[]>> = {
  CREATED: ['READY', 'DESTROYED'],
  READY: ['DEGRADED', 'DESTROYED'],
  DEGRADED: ['DESTROYED'],
  DESTROYED: [],
};

export type LifecycleListener = (state: ViceMeClientState) => void;

export class Lifecycle {
  #state: ViceMeClientState = 'CREATED';
  #listeners = new Set<LifecycleListener>();

  get state(): ViceMeClientState {
    return this.#state;
  }

  get destroyed(): boolean {
    return this.#state === 'DESTROYED';
  }

  transition(next: ViceMeClientState): void {
    if (next === this.#state) return;
    if (!ALLOWED_TRANSITIONS[this.#state]!.includes(next)) {
      throw new ViceMeError({
        code: 'INTERNAL_ERROR',
        message: `Illegal lifecycle transition ${this.#state} -> ${next}.`,
        retryable: false,
      });
    }
    this.#state = next;
    for (const listener of this.#listeners) listener(next);
  }

  /** Any operation on a destroyed client must fail closed with this guard. */
  assertAlive(): void {
    if (this.destroyed) throw clientDestroyed();
  }

  subscribe(listener: LifecycleListener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  clearListeners(): void {
    this.#listeners.clear();
  }
}
