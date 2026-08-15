#!/usr/bin/env node
/**
 * Publish one release's exact-version artifacts to ONE S3 region.
 *
 * Ports the dual-region AWS CLI semantics from ViceMe-AI/cli release.yml:
 *   - explicit endpoint / bucket / access key / secret key (no ambient
 *     credentials, no arbitrary shell secrets);
 *   - head-bucket first (connectivity + permission proof);
 *   - immutable exact-version semantics per object: absent -> upload with
 *     immutable cache headers; present -> download and byte-compare
 *     (identical => idempotent skip, different => fail closed);
 *   - public read-back from the region's public base after the uploads.
 *
 * Usage (secret values arrive via env, never argv):
 *   S3_ENDPOINT=... S3_BUCKET=viceme-sdk S3_ACCESS_KEY_ID=... \
 *   S3_SECRET_ACCESS_KEY=... node scripts/publish-s3-region.mjs \
 *     --dist release/dist --prefix sdk/1.2.3 \
 *     --public-base https://s3.viceme.cn/sdk/1.2.3/ --label CN
 *
 * Optional env: EXPECT_BUCKET (default viceme-sdk — the dedicated SDK
 * bucket, never shared), AWS_BIN (tests).
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const EXPECTED_BUCKET = process.env.EXPECT_BUCKET ?? 'viceme-sdk';
const awsBin = process.env.AWS_BIN ?? 'aws';

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--dist') args.dist = argv[++i];
    else if (argv[i] === '--prefix') args.prefix = argv[++i];
    else if (argv[i] === '--public-base') args.publicBase = argv[++i];
    else if (argv[i] === '--label') args.label = argv[++i];
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const endpoint = process.env.S3_ENDPOINT ?? '';
const bucket = process.env.S3_BUCKET ?? '';
const accessKeyId = process.env.S3_ACCESS_KEY_ID ?? '';
const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY ?? '';

const missing = [];
if (!args.dist) missing.push('--dist');
if (!args.prefix) missing.push('--prefix');
if (!args.publicBase) missing.push('--public-base');
if (!args.label) missing.push('--label');
if (!endpoint) missing.push('S3_ENDPOINT');
if (!bucket) missing.push('S3_BUCKET');
if (!accessKeyId) missing.push('S3_ACCESS_KEY_ID');
if (!secretAccessKey) missing.push('S3_SECRET_ACCESS_KEY');
if (missing.length > 0) {
  console.error(`publish-s3-region: missing required configuration: ${missing.join(', ')}`);
  process.exit(1);
}
if (bucket !== EXPECTED_BUCKET) {
  console.error(
    `publish-s3-region: S3_BUCKET must be the dedicated '${EXPECTED_BUCKET}' bucket, got '${bucket}'`,
  );
  process.exit(1);
}

const s3Env = {
  ...process.env,
  AWS_ACCESS_KEY_ID: accessKeyId,
  AWS_SECRET_ACCESS_KEY: secretAccessKey,
  AWS_DEFAULT_REGION: 'us-east-1',
};

function aws(...cliArgs) {
  const result = spawnSync(awsBin, ['--endpoint-url', endpoint, ...cliArgs], {
    encoding: 'utf8',
    env: s3Env,
  });
  return result;
}

function awsOrThrow(...cliArgs) {
  const result = aws(...cliArgs);
  if (result.status !== 0) {
    console.error(`aws ${cliArgs.join(' ')} failed:\n${result.stderr ?? ''}`);
    process.exit(1);
  }
  return result;
}

// Connectivity + credential proof before any transfer.
if (aws('s3api', 'head-bucket', '--bucket', bucket).status !== 0) {
  console.error(`publish-s3-region: head-bucket failed for ${bucket} at ${endpoint}`);
  process.exit(1);
}

const manifest = JSON.parse(readFileSync(join(args.dist, 'manifest.json'), 'utf8'));
const objects = [
  'manifest.json',
  ...Object.keys(manifest.files).filter((f) => !f.endsWith('.map')),
];

const scratch = mkdtempSync(join(tmpdir(), 'viceme-s3-region-'));
try {
  let uploaded = 0;
  let identical = 0;
  for (const file of objects) {
    const local = join(args.dist, file);
    const key = `${args.prefix}${file}`;
    const head = aws('s3api', 'head-object', '--bucket', bucket, '--key', key);
    if (head.status === 0) {
      const existing = join(scratch, 'existing');
      rmSync(existing, { force: true });
      awsOrThrow('s3', 'cp', `s3://${bucket}/${key}`, existing, '--only-show-errors');
      const a = readFileSync(local);
      const b = readFileSync(existing);
      if (
        createHash('sha256').update(a).digest('hex') !==
        createHash('sha256').update(b).digest('hex')
      ) {
        console.error(
          `immutable violation: s3://${bucket}/${key} exists with different bytes (release ${createHash('sha256').update(a).digest('hex').slice(0, 12)}…)`,
        );
        process.exit(1);
      }
      identical += 1;
      continue;
    }
    // head-object non-zero for any reason other than absence is fatal.
    if (!/404|NoSuchKey|Not Found/i.test(`${head.stderr ?? ''}${head.stdout ?? ''}`)) {
      console.error(`head-object failed for ${key}:\n${head.stderr ?? ''}`);
      process.exit(1);
    }
    awsOrThrow(
      's3',
      'cp',
      local,
      `s3://${bucket}/${key}`,
      '--cache-control',
      'public,max-age=31536000,immutable',
      '--only-show-errors',
    );
    uploaded += 1;
  }
  console.log(
    `${args.label}: ${uploaded} uploaded, ${identical} already identical under ${args.prefix}`,
  );
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

// Public read-back from the region's real public entry.
execFileSync(process.execPath, [join(here, 'verify-cdn.mjs'), '--base', args.publicBase], {
  stdio: 'inherit',
});
console.log(`${args.label}: public read-back verified at ${args.publicBase}`);
