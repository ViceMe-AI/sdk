/**
 * `@viceme-ai/sdk/testing` subpath entry (test adapter only).
 *
 * Re-exports the deterministic mock transport and test client so the emitted
 * declaration lands at `dist/testing.d.ts`, matching the package exports map.
 */

export { createTestViceMe, createMemoryTransport, FIXTURE_WORK } from './testing/test-adapter.ts';
export type {
  MemoryTransport,
  MemoryTransportOptions,
  MemoryTransportWorkFixture,
  CreateTestViceMeOptions,
} from './testing/test-adapter.ts';
