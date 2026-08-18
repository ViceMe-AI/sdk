#!/usr/bin/env node
/**
 * Post-publish npm dist-tag read-back.
 *
 * Every reviewed SDK release is stable and publishes under `latest`, matching
 * the CLI release channel. This script verifies the live registry state:
 *
 *   - version is an exact stable semantic version
 *   - tag is exactly `latest`
 *   - dist-tags.latest === version
 *
 * Usage:
 *   node scripts/verify-npm-dist-tag.mjs --package @viceme-ai/sdk --version 1.2.3 --tag latest
 *   node scripts/verify-npm-dist-tag.mjs --version 1.2.3 --tag latest \
 *     --dist-tags-json '{"latest":"1.2.3"}'   # tests: inject registry state
 */
import { execFileSync } from 'node:child_process';

function parseArgs(argv) {
  const args = { package: '@viceme-ai/sdk' };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--package') args.package = argv[++i];
    else if (argv[i] === '--version') args.version = argv[++i];
    else if (argv[i] === '--tag') args.tag = argv[++i];
    else if (argv[i] === '--dist-tags-json') args.distTagsJson = argv[++i];
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
if (!args.version || !args.tag) {
  console.error(
    'usage: verify-npm-dist-tag.mjs --version <v> --tag <tag> [--package <pkg>] [--dist-tags-json <json>]',
  );
  process.exit(2);
}

const stable =
  args.package === '@viceme-ai/sdk' &&
  /^\d+\.\d+\.\d+$/.test(args.version) &&
  args.tag === 'latest';
const poc =
  args.package === '@viceme-ai/sdk-poc' &&
  /^\d+\.\d+\.\d+-poc\.\d+$/.test(args.version) &&
  args.tag === 'poc';
if (!stable && !poc) {
  console.error('npm dist-tag read-back received an unapproved package/version/tag combination');
  process.exit(2);
}

let distTags;
if (args.distTagsJson !== undefined) {
  distTags = JSON.parse(args.distTagsJson);
} else {
  // Public read: dist-tags of a published public package need no auth.
  distTags = JSON.parse(
    execFileSync('npm', ['view', args.package, 'dist-tags', '--json'], { encoding: 'utf8' }),
  );
}

const failures = [];
if (distTags[args.tag] !== args.version) {
  failures.push(
    `dist-tag "${args.tag}" is ${distTags[args.tag] ?? 'unset'}, expected ${args.version}`,
  );
}
if (failures.length > 0) {
  console.error('npm dist-tag read-back failed:');
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log(`npm dist-tag ok: ${args.tag} -> ${args.version}`);
