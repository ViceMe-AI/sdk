// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { compareSemver, decideMutableTagMove } from '../../../../scripts/lib/release-policy.mjs';

/**
 * Release policy primitives: semver ordering and the monotonic-forward
 * decision used by the npm dist-tag policy.
 */

describe('compareSemver', () => {
  it('orders cores numerically', () => {
    expect(compareSemver('1.2.3', '1.2.4')).toBeLessThan(0);
    expect(compareSemver('0.10.0', '0.9.0')).toBeGreaterThan(0);
    expect(compareSemver('1.2.3', '1.2.3')).toBe(0);
  });

  it('rejects prerelease and malformed versions', () => {
    expect(() => compareSemver('0.1.1-next.0', '0.1.1')).toThrow('invalid input');
    expect(() => compareSemver('v0.1.1', '0.1.1')).toThrow('invalid input');
  });
});

describe('decideMutableTagMove', () => {
  it('allows unset -> target and forward moves', () => {
    expect(decideMutableTagMove({ current: undefined, target: '1.0.0' }).allowed).toBe(true);
    expect(decideMutableTagMove({ current: '1.0.0', target: '1.1.0' }).allowed).toBe(true);
  });

  it('refuses backward moves (stale rerun guard)', () => {
    expect(decideMutableTagMove({ current: '1.1.0', target: '1.0.0' }).allowed).toBe(false);
    expect(decideMutableTagMove({ current: '0.2.0', target: '0.1.9' }).allowed).toBe(false);
  });

  it('same version means the tag already converged (idempotent rerun)', () => {
    const same = decideMutableTagMove({ current: '1.0.0', target: '1.0.0' });
    expect(same.allowed).toBe(false);
    expect(same.converged).toBe(true);
    // Callers must verify and continue, never fail the run.
    expect(same.reason).toContain('already');
  });
});
