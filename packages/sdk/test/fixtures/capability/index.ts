/**
 * Fixture capability entry — the shape every capability feature chunk exports.
 *
 * ```ts
 * export function mount(client, options): Promise<CapabilityMountHandle>
 * ```
 */

export { mount } from './mount.ts';
export { createFixtureCapability } from './client.ts';
export type { FixtureCapability } from './client.ts';
