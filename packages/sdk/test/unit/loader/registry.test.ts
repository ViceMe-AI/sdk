import { describe, expect, it } from 'vitest';
import { LoaderRegistry, clientKeyOf } from '../../../src/loader/registry.ts';
import type { CapabilityMountHandle } from '../../../src/loader/mount-handle.ts';

function raw(capability: string, destroyed: string[] = []): CapabilityMountHandle {
  return {
    capability,
    destroy: () => destroyed.push(capability),
  };
}

describe('LoaderRegistry', () => {
  it('keys clients by major+region+workKey', () => {
    expect(clientKeyOf(1, 'cn', 'wrk_a')).toBe('v1+cn+wrk_a');
    expect(clientKeyOf(2, 'cn', 'wrk_a')).not.toBe(clientKeyOf(1, 'cn', 'wrk_a'));
  });

  it('deduplicates instances by element identity, not selector', () => {
    const registry = new LoaderRegistry();
    const el1 = document.createElement('div');
    const el2 = document.createElement('div');

    const first = registry.registerInstance('v1+cn+wrk_a', 'danmaku', el1, raw('danmaku'));
    const same = registry.registerInstance('v1+cn+wrk_a', 'danmaku', el1, raw('danmaku'));
    const other = registry.registerInstance('v1+cn+wrk_a', 'danmaku', el2, raw('danmaku'));

    expect(same).toBe(first);
    expect(other).not.toBe(first);
    expect(other.instanceKey).not.toBe(first.instanceKey);

    expect(registry.findInstance('v1+cn+wrk_a', 'danmaku', el1)).toBe(first);
    expect(registry.findInstance('v1+cn+wrk_b', 'danmaku', el1)).toBeUndefined();
  });

  it('removes element mapping on removeInstance', () => {
    const registry = new LoaderRegistry();
    const el = document.createElement('div');
    const instance = registry.registerInstance('v1+cn+wrk_a', 'danmaku', el, raw('danmaku'));

    registry.removeInstance(instance.instanceKey);
    expect(registry.getInstance(instance.instanceKey)).toBeUndefined();
    expect(registry.findInstance('v1+cn+wrk_a', 'danmaku', el)).toBeUndefined();

    // Re-mounting the same element creates a fresh instance key.
    const next = registry.registerInstance('v1+cn+wrk_a', 'danmaku', el, raw('danmaku'));
    expect(next.instanceKey).not.toBe(instance.instanceKey);
  });

  it('lists instances per client', () => {
    const registry = new LoaderRegistry();
    const a1 = document.createElement('div');
    const a2 = document.createElement('div');
    registry.registerInstance('v1+cn+wrk_a', 'danmaku', a1, raw('danmaku'));
    registry.registerInstance('v1+cn+wrk_a', 'danmaku', a2, raw('danmaku'));
    registry.registerInstance('v1+cn+wrk_b', 'danmaku', a1, raw('danmaku'));

    expect(registry.instancesForClient('v1+cn+wrk_a')).toHaveLength(2);
    expect(registry.instancesForClient('v1+cn+wrk_b')).toHaveLength(1);
  });
});
