/**
 * Release policy primitives for publish-or-verify. Kept dependency-free and
 * unit-testable.
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
 * Decide whether a mutable npm dist-tag may move from `current` to `target`.
 * Only monotonic forward moves are allowed, so stale reruns of older releases
 * can never pull the tag backward.
 *
 * Returns { allowed, converged, reason }. `converged: true` means the
 * live value already equals the target: the caller must VERIFY the
 * existing objects and continue (idempotent recovery), never fail.
 */
export function decideMutableTagMove({ current, target }) {
  if (current === undefined || current === null || current === '') {
    return { allowed: true, converged: false, reason: `tag unset; moving to ${target}` };
  }
  const ordering = compareSemver(target, current);
  if (ordering > 0) {
    return { allowed: true, converged: false, reason: `forward move ${current} -> ${target}` };
  }
  if (ordering === 0) {
    return {
      allowed: false,
      converged: true,
      reason: `tag already at ${target}`,
    };
  }
  return {
    allowed: false,
    converged: false,
    reason: `refusing to move tag backward ${current} -> ${target}`,
  };
}
