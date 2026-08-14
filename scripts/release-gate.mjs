#!/usr/bin/env node
/**
 * Release gate — fail-closed preconditions for publishing (machine-enforced,
 * not a human convention).
 *
 * Blocks publishing when:
 *   - the final `LICENSE` is missing, or
 *   - the `LICENSE-PENDING.md` placeholder still exists, or
 *   - the publishable package would not ship the LICENSE in its files
 *     allowlist.
 *
 * Usage:
 *   pnpm release:gate                                  # repo root
 *   node scripts/release-gate.mjs --root <dir>         # tests / other checkouts
 *
 * Wired into the publish path (`pnpm release:publish` runs this first), so a
 * pending license stops the npm publish — never the version-PR flow.
 */
import { access, constants, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--root') args.root = argv[++i];
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const root = args.root ?? join(dirname(fileURLToPath(import.meta.url)), '..');
const failures = [];

async function exists(path) {
  try {
    await access(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

if (!(await exists(join(root, 'LICENSE')))) {
  failures.push('LICENSE is missing — the final license must be confirmed before publishing.');
}
if (await exists(join(root, 'LICENSE-PENDING.md'))) {
  failures.push(
    'LICENSE-PENDING.md still exists — replace it with the final LICENSE before publishing.',
  );
}

try {
  const pkg = JSON.parse(await readFile(join(root, 'packages', 'sdk', 'package.json'), 'utf8'));
  if (
    !Array.isArray(pkg.files) ||
    !pkg.files.includes('LICENSE') ||
    !pkg.files.includes('README.md')
  ) {
    failures.push(
      'packages/sdk/package.json "files" must include LICENSE and README.md so the tarball ships them.',
    );
  }
  if (pkg.publishConfig?.access !== 'public') {
    failures.push('packages/sdk/package.json publishConfig.access must be "public".');
  }
} catch (error) {
  failures.push(`could not read packages/sdk/package.json: ${String(error)}`);
}

if (failures.length > 0) {
  console.error('release gate failed:');
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log('release gate passed');
