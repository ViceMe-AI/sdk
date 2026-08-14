// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { compareSemver, decideMutableTagMove } from '../../../../scripts/lib/release-policy.mjs';

/**
 * Release policy primitives: semver ordering and the monotonic-forward /
 * authorized-rollback decision used by both the npm dist-tag policy and the
 * CDN alias pointer.
 */

describe('compareSemver', () => {
  it('orders cores numerically', () => {
    expect(compareSemver('1.2.3', '1.2.4')).toBeLessThan(0);
    expect(compareSemver('0.10.0', '0.9.0')).toBeGreaterThan(0);
    expect(compareSemver('1.2.3', '1.2.3')).toBe(0);
  });

  it('orders prereleases below their release', () => {
    expect(compareSemver('0.1.1-next.0', '0.1.1')).toBeLessThan(0);
    expect(compareSemver('0.1.1', '0.1.1-next.0')).toBeGreaterThan(0);
  });

  it('orders prerelease identifiers per semver', () => {
    expect(compareSemver('0.1.1-next.1', '0.1.1-next.2')).toBeLessThan(0);
    expect(compareSemver('0.1.1-next.2', '0.1.1-next.10')).toBeLessThan(0);
    expect(compareSemver('0.1.1-next.0', '0.1.1-next.0')).toBe(0);
  });
});

describe('decideMutableTagMove', () => {
  it('promote: allows unset -> target and forward moves', () => {
    expect(
      decideMutableTagMove({ mode: 'promote', current: undefined, target: '1.0.0' }).allowed,
    ).toBe(true);
    expect(
      decideMutableTagMove({ mode: 'promote', current: '1.0.0', target: '1.1.0' }).allowed,
    ).toBe(true);
    expect(
      decideMutableTagMove({ mode: 'promote', current: '0.1.1-next.0', target: '0.1.1' }).allowed,
    ).toBe(true);
  });

  it('promote: refuses backward and same-version moves (stale rerun guard)', () => {
    expect(
      decideMutableTagMove({ mode: 'promote', current: '1.1.0', target: '1.0.0' }).allowed,
    ).toBe(false);
    expect(
      decideMutableTagMove({ mode: 'promote', current: '1.0.0', target: '1.0.0' }).allowed,
    ).toBe(false);
    expect(
      decideMutableTagMove({ mode: 'promote', current: '0.2.0', target: '0.1.9' }).allowed,
    ).toBe(false);
  });

  it('rollback: requires the exact declared current value', () => {
    const allowed = decideMutableTagMove({
      mode: 'rollback',
      current: '1.2.3',
      target: '1.2.2',
      expectedCurrent: '1.2.3',
    });
    expect(allowed.allowed).toBe(true);

    const stale = decideMutableTagMove({
      mode: 'rollback',
      current: '1.3.0',
      target: '1.2.2',
      expectedCurrent: '1.2.3',
    });
    expect(stale.allowed).toBe(false);
    expect(stale.reason).toContain("live value is '1.3.0'");
  });

  it('rollback: refuses without expectedCurrent or with a newer target', () => {
    expect(
      decideMutableTagMove({ mode: 'rollback', current: '1.2.3', target: '1.2.2' }).allowed,
    ).toBe(false);
    expect(
      decideMutableTagMove({
        mode: 'rollback',
        current: '1.2.2',
        target: '1.2.3',
        expectedCurrent: '1.2.2',
      }).allowed,
    ).toBe(false);
  });
});
