/**
 * Release policy primitives shared by publish-or-verify and the alias
 * pointer writer. Kept dependency-free and unit-testable.
 */

/**
 * Compare two semver strings (core + optional prerelease).
 * Returns >0 when a > b, 0 when equal, <0 when a < b.
 * Prerelease ordering follows the semver spec subset we publish
 * (numeric identifiers compare numerically, others lexically; a release
 * without a prerelease is greater than the same core with one).
 */
export function compareSemver(a, b) {
  const pa = parse(a);
  const pb = parse(b);
  if (pa === null || pb === null) {
    throw new Error(`compareSemver: invalid input ${a} vs ${b}`);
  }
  for (let i = 0; i < 3; i += 1) {
    if (pa.core[i] !== pb.core[i]) return pa.core[i] - pb.core[i];
  }
  if (pa.pre === null && pb.pre === null) return 0;
  if (pa.pre === null) return 1;
  if (pb.pre === null) return -1;
  const len = Math.max(pa.pre.length, pb.pre.length);
  for (let i = 0; i < len; i += 1) {
    const x = pa.pre[i];
    const y = pb.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) {
      const diff = Number(x) - Number(y);
      if (diff !== 0) return diff;
    } else if (xn) {
      return -1;
    } else if (yn) {
      return 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

function parse(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(version ?? '');
  if (!match) return null;
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    pre: match[4] === undefined ? null : match[4].split('.'),
  };
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
