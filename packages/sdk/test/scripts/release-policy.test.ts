// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  compareSemver,
  decideMutableTagMove,
  decideNpmPublicationAuth,
} from '../../../../scripts/lib/release-policy.mjs';

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

  it('rejects prerelease and malformed versions', () => {
    expect(() => compareSemver('0.1.1-next.0', '0.1.1')).toThrow('invalid input');
    expect(() => compareSemver('v0.1.1', '0.1.1')).toThrow('invalid input');
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
  });

  it('promote: refuses backward moves (stale rerun guard)', () => {
    expect(
      decideMutableTagMove({ mode: 'promote', current: '1.1.0', target: '1.0.0' }).allowed,
    ).toBe(false);
    expect(
      decideMutableTagMove({ mode: 'promote', current: '0.2.0', target: '0.1.9' }).allowed,
    ).toBe(false);
  });

  it('promote: same version means the region already converged (idempotent rerun)', () => {
    const same = decideMutableTagMove({ mode: 'promote', current: '1.0.0', target: '1.0.0' });
    expect(same.allowed).toBe(false);
    expect(same.converged).toBe(true);
    // Callers must verify and continue, never fail the run.
    expect(same.reason).toContain('converged');
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

describe('decideNpmPublicationAuth', () => {
  const packageName = '@viceme-ai/sdk-poc';

  it('allows the one-time token only while the package is absent', () => {
    expect(
      decideNpmPublicationAuth({
        packageName,
        packageExists: false,
        bootstrapTokenPresent: true,
      }),
    ).toMatchObject({ allowed: true, mode: 'bootstrap-token' });
    expect(
      decideNpmPublicationAuth({
        packageName,
        packageExists: false,
        bootstrapTokenPresent: false,
      }),
    ).toMatchObject({ allowed: false });
  });

  it('requires OIDC and rejects a lingering token after package creation', () => {
    expect(
      decideNpmPublicationAuth({
        packageName,
        packageExists: true,
        bootstrapTokenPresent: false,
      }),
    ).toMatchObject({ allowed: true, mode: 'oidc' });
    expect(
      decideNpmPublicationAuth({
        packageName,
        packageExists: true,
        bootstrapTokenPresent: true,
      }),
    ).toMatchObject({ allowed: false });
  });
});
