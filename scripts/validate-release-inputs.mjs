#!/usr/bin/env node
/**
 * Strict validation of workflow_dispatch inputs BEFORE any network, file,
 * or credential operation (shell-injection defense in depth: even with
 * env-passed inputs, malformed values are rejected here).
 *
 *   --version x.y.z                exact stable release version
 *   --regions cn,global            optional region subset
 *
 * Exit 0 = valid; exit 1 prints every violation.
 */
const STABLE_SEMVER = /^\d+\.\d+\.\d+$/;
const KNOWN_REGIONS = new Set(['cn', 'global']);

const args = {};
for (let i = 0; i < process.argv.length; i += 1) {
  if (process.argv[i] === '--version') args.version = process.argv[++i];
  else if (process.argv[i] === '--regions') args.regions = process.argv[++i];
}

const failures = [];

if (typeof args.version !== 'string' || !STABLE_SEMVER.test(args.version)) {
  failures.push(`--version must be an exact stable semver x.y.z, got: ${String(args.version)}`);
}

if (args.regions !== undefined) {
  const regions = args.regions
    .split(',')
    .map((r) => r.trim())
    .filter(Boolean);
  const seen = new Set();
  if (regions.length === 0) failures.push('--regions must list at least one region');
  for (const region of regions) {
    if (!KNOWN_REGIONS.has(region)) {
      failures.push(`unknown region '${region}' (expected cn or global)`);
    }
    if (seen.has(region)) failures.push(`duplicate region '${region}'`);
    seen.add(region);
  }
}

if (failures.length > 0) {
  console.error('release input validation failed:');
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log(
  `release inputs valid${args.version ? `: version ${args.version}` : ''}${
    args.regions ? ` regions ${args.regions}` : ''
  }`,
);
