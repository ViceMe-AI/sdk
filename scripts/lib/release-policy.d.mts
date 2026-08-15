/**
 * Type declarations for release-policy.mjs (consumed by TypeScript tests).
 */

export function compareSemver(a: string, b: string): number;

export function decideMutableTagMove(options: {
  mode: 'promote' | 'rollback';
  current?: string;
  target: string;
  expectedCurrent?: string;
}): { allowed: boolean; converged: boolean; reason: string };
