/**
 * Release policy primitives shared by publish-or-verify and the alias
 * pointer writer. Kept dependency-free and unit-testable.
 */

/**
 * Compare two stable semver strings.
 * Returns >0 when a > b, 0 when equal, <0 when a < b.
 */
export function compareSemver(a, b) {
  const pa = parse(a);
  const pb = parse(b);
  if (pa === null || pb === null) {
    throw new Error(`compareSemver: invalid input ${a} vs ${b}`);
  }
  for (let i = 0; i < 3; i += 1) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
}

function parse(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version ?? '');
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/**
 * Decide whether a mutable npm dist-tag / CDN pointer may move from
 * `current` to `target` under the given mode.
 *
 *   promote  : only monotonic forward moves (stale reruns of older releases
 *              must never pull the tag backward);
 *   rollback : only an explicitly authorized backward move — the caller
 *              must declare the exact `expectedCurrent` it expects to move
 *              away from, and the live value must match (stale-job guard).
 *
 * Returns { allowed, converged, reason }. `converged: true` means the
 * live value already equals the target: the caller must VERIFY the
 * existing objects and continue (idempotent recovery), never fail.
 */
export function decideMutableTagMove({ mode, current, target, expectedCurrent }) {
  if (mode === 'rollback') {
    if (expectedCurrent === undefined || expectedCurrent === '') {
      return {
        allowed: false,
        reason: 'rollback requires expectedCurrent (the version being rolled back FROM)',
      };
    }
    if (current !== expectedCurrent) {
      return {
        allowed: false,
        converged: false,
        reason: `rollback expected current '${expectedCurrent}' but live value is '${current ?? 'unset'}' (stale or concurrent move?)`,
      };
    }
    if (compareSemver(target, current) >= 0) {
      return {
        allowed: false,
        reason: `rollback target ${target} must be older than current ${current}`,
      };
    }
    return {
      allowed: true,
      converged: false,
      reason: `authorized rollback ${current} -> ${target}`,
    };
  }
  // promote
  if (current === undefined || current === null || current === '') {
    return { allowed: true, converged: false, reason: `pointer unset; promoting to ${target}` };
  }
  const ordering = compareSemver(target, current);
  if (ordering > 0) {
    return { allowed: true, converged: false, reason: `forward move ${current} -> ${target}` };
  }
  if (ordering === 0) {
    return {
      allowed: false,
      converged: true,
      reason: `pointer already at ${target} (region converged)`,
    };
  }
  return {
    allowed: false,
    converged: false,
    reason: `refusing to move pointer backward ${current} -> ${target}; use explicit rollback mode`,
  };
}

/**
 * Enforce the one-time npm package bootstrap boundary.
 *
 * npm cannot configure a Trusted Publisher before the package exists. The
 * first publication may therefore use a short-lived granular token, but that
 * credential must be removed immediately afterwards. Once the package exists,
 * OIDC is the only accepted publication identity.
 */
export function decideNpmPublicationAuth({ packageExists, bootstrapTokenPresent }) {
  if (!packageExists) {
    if (!bootstrapTokenPresent) {
      return {
        allowed: false,
        reason:
          '@viceme-ai/sdk does not exist yet; add the one-time NPM_TOKEN to the npm environment',
      };
    }
    return {
      allowed: true,
      mode: 'bootstrap-token',
      reason: 'authorizing the first package publication with the one-time bootstrap token',
    };
  }

  if (bootstrapTokenPresent) {
    return {
      allowed: false,
      reason:
        '@viceme-ai/sdk already exists; delete NPM_TOKEN and configure Trusted Publisher OIDC',
    };
  }

  return {
    allowed: true,
    mode: 'oidc',
    reason: 'authorizing publication with Trusted Publisher OIDC',
  };
}
