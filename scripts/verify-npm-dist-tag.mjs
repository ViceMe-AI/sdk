#!/usr/bin/env node
/**
 * Post-publish npm dist-tag read-back.
 *
 * The 0.x phase publishes under the `next` dist-tag only (§14.1); `latest`
 * must never point at an unreleased-capability build. This script verifies
 * the live registry state after publishing:
 *
 *   - dist-tags[tag] === version            (required)
 *   - dist-tags.latest !== version          (when tag !== latest)
 *
 * Usage:
 *   node scripts/verify-npm-dist-tag.mjs --package @viceme-ai/sdk --version 1.2.3 --tag next
 *   node scripts/verify-npm-dist-tag.mjs --version 1.2.3 --tag next \
 *     --dist-tags-json '{"next":"1.2.3"}'   # tests: inject the registry state
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
if (args.tag !== 'latest' && distTags.latest === args.version) {
  failures.push(
    `dist-tag "latest" must not point at ${args.version} while publishing "${args.tag}"`,
  );
}

if (failures.length > 0) {
  console.error('npm dist-tag read-back failed:');
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log(`npm dist-tag ok: ${args.tag} -> ${args.version}`);
