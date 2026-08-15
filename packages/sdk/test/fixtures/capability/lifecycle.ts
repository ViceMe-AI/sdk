/**
 * Fixture capability — subscribe/unsubscribe and resource tracking.
 *
 * Demonstrates the cleanup contract every real capability must follow:
 * listeners, observers, and timers are owned here and removed by `destroy()`.
 */

export interface FixtureLifecycle {
  subscribe(listener: () => void): () => void;
  emit(): void;
  listenerCount: number;
}

export function createFixtureLifecycle(): FixtureLifecycle {
  const listeners = new Set<() => void>();
  return {
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    emit(): void {
      for (const listener of listeners) listener();
    },
    get listenerCount(): number {
      return listeners.size;
    },
  };
}
