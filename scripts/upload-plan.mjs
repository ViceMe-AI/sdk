#!/usr/bin/env node
/**
 * Immutability-aware CDN upload planner.
 *
 * Exact versions are never overwritten (§14.2). For every file in the
 * release manifest this script checks the public target:
 *
 *   - target missing (404)          -> listed for upload
 *   - target bytes match sha256     -> skipped (idempotent re-run)
 *   - target bytes differ           -> HARD FAIL (immutable violation)
 *
 * Usage:
 *   node scripts/upload-plan.mjs --dist <dir> --base https://<host>/viceme-sdk/<version>/
 *
 * Prints the files to upload (one POSIX relative path per line) to stdout.
 * The workflow then uploads exactly those files, per region, and re-runs
 * scripts/verify-cdn.mjs for a full read-back.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--dist') args.dist = argv[++i];
    else if (argv[i] === '--base') args.base = argv[++i];
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
if (!args.dist || !args.base) {
  console.error('usage: upload-plan.mjs --dist <dir> --base https://host/viceme-sdk/<version>/');
  process.exit(2);
}

const manifestPath = join(args.dist, 'manifest.json');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
const base = args.base.endsWith('/') ? args.base : `${args.base}/`;

const toUpload = [];
let identical = 0;

/**
 * Probe one exact-version object. `localBytes` are the release bytes to
 * compare against; `expectedSha256` (optional) is the manifest digest.
 * 404 => queue for upload; identical => skip; different => fail closed.
 */
async function probe(file, localBytes, expectedSha256) {
  let response;
  try {
    response = await fetch(new URL(file, base), { credentials: 'omit' });
  } catch (error) {
    console.error(`upload plan: could not probe ${file}: ${String(error)}`);
    process.exit(1);
  }
  if (response.status === 404) {
    toUpload.push(file);
    return;
  }
  if (!response.ok) {
    console.error(`upload plan: ${file}: unexpected HTTP ${response.status}`);
    process.exit(1);
  }
  const remote = Buffer.from(await response.arrayBuffer());
  const remoteSha256 = createHash('sha256').update(remote).digest('hex');
  const expected = expectedSha256 ?? createHash('sha256').update(localBytes).digest('hex');
  if (remoteSha256 !== expected) {
    console.error(`immutable violation: ${base}${file} already exists with different bytes`);
    console.error(`  remote:  ${remoteSha256}`);
    console.error(`  release: ${expected}`);
    process.exit(1);
  }
  identical += 1;
}

// The manifest itself is a first-class immutable object: build-manifest does
// not list it in `files`, but verify-cdn reads it from the exact-version
// path — a first promotion on an empty CDN must upload it too.
const manifestBytes = await readFile(manifestPath);
await probe('manifest.json', manifestBytes);

for (const [file, info] of Object.entries(manifest.files)) {
  if (file.endsWith('.map')) continue;
  await probe(file, await readFile(join(args.dist, file)), info.sha256);
}

for (const file of toUpload) console.log(file);
console.error(`upload plan: ${toUpload.length} to upload, ${identical} already identical`);
