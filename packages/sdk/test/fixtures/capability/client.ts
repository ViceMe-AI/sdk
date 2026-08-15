/**
 * Fixture capability — headless client (no DOM).
 *
 * Test-only (B0.1): validates the loader, on-demand loading, mount,
 * events, and destroy pipeline without shipping a fake production
 * capability. Not part of npm exports, the tarball, or CDN release.
 */

import type { ViceMeClient } from '../../../src/core/client.ts';

export interface FixtureCapability {
  readonly name: 'fixture';
  /** Headless call that never touches the DOM. */
  ping(): { workKey: string; ready: boolean };
}

export function createFixtureCapability(client: ViceMeClient): FixtureCapability {
  return {
    name: 'fixture',
    ping() {
      return { workKey: client.workKey, ready: client.state === 'READY' };
    },
  };
}
