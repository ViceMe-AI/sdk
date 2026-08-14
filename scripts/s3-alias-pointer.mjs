#!/usr/bin/env node
/**
 * Move the stable `/sdk/v1` alias on the dual-region S3 topology.
 *
 * Per region (credentials via env, region-selected):
 *   1. read the current public pointer and apply the shared policy
 *      (promote = monotonic forward only; rollback = explicit, requires
 *      --from-current to match the live value);
 *   2. publish the loader object at sdk/v1/viceme.min.js with immutable
 *      semantics (absent -> upload; identical -> skip; different -> fail);
 *      loader bytes are content-stable, so a torn write stays functional;
 *   3. write the single pointer object sdk/-/aliases/v1 (the one mutable
 *      object) and poll the public URL until it converges.
 *
 * No CDN edge sits in front of the S3 public entries, so reads are
 * origin-fresh and the convergence budget is small.
 *
 * Usage:
 *   node scripts/s3-alias-pointer.mjs --version 1.2.3 --regions cn,global \
 *     [--mode promote|rollback] [--from-current 1.1.0] \
 *     [--public-base-cn https://s3.viceme.cn] [--public-base-global https://s3.viceme.ai] \
 *     [--converge-timeout-ms 30000]
 *
 * Env per region R in {CN, GLOBAL}: S3_ENDPOINT_R, S3_BUCKET_R,
 * S3_ACCESS_KEY_ID_R, S3_SECRET_ACCESS_KEY_R. Optional AWS_BIN (tests),
 * EXPECT_BUCKET (default viceme-sdk).
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decideMutableTagMove } from './lib/release-policy.mjs';
import { awaitPointerConvergence, readPointerValue } from './lib/pointer-client.mjs';

const POINTER_KEY = 'sdk/-/aliases/v1';
const ALIAS_SEGMENT = 'v1';
const EXPECTED_BUCKET = process.env.EXPECT_BUCKET ?? 'viceme-sdk';
const awsBin = process.env.AWS_BIN ?? 'aws';
const DEFAULT_BASES = { cn: 'https://s3.viceme.cn', global: 'https://s3.viceme.ai' };

function parseArgs(argv) {
  const args = { mode: 'promote', convergeTimeoutMs: 30_000 };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--version') args.version = argv[++i];
    else if (argv[i] === '--regions') args.regions = argv[++i];
    else if (argv[i] === '--mode') args.mode = argv[++i];
    else if (argv[i] === '--from-current') args.fromCurrent = argv[++i];
    else if (argv[i] === '--public-base-cn') args.publicBaseCn = argv[++i];
    else if (argv[i] === '--public-base-global') args.publicBaseGlobal = argv[++i];
    else if (argv[i] === '--converge-timeout-ms') args.convergeTimeoutMs = Number(argv[++i]);
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const regions = (args.regions ?? '')
  .split(',')
  .map((r) => r.trim())
  .filter(Boolean);

if (!args.version || regions.length === 0 || !['promote', 'rollback'].includes(args.mode)) {
  console.error(
    'usage: s3-alias-pointer.mjs --version <v> --regions cn,global [--mode promote|rollback] [--from-current <v>]',
  );
  process.exit(2);
}

function regionConfig(region) {
  const suffix = region.toUpperCase();
  const config = {
    endpoint: process.env[`S3_ENDPOINT_${suffix}`] ?? '',
    bucket: process.env[`S3_BUCKET_${suffix}`] ?? '',
    accessKeyId: process.env[`S3_ACCESS_KEY_ID_${suffix}`] ?? '',
    secretAccessKey: process.env[`S3_SECRET_ACCESS_KEY_${suffix}`] ?? '',
    publicBase:
      (region === 'cn' ? args.publicBaseCn : args.publicBaseGlobal) ?? DEFAULT_BASES[region],
    // Only the CN region egresses through the CN proxy; the GLOBAL region
    // must never inherit it.
    proxy: region === 'cn' ? (process.env.CN_S3_HTTPS_PROXY ?? '') : '',
  };
  const missing = Object.entries(config)
    .filter(([key, value]) => value === '' && key !== 'proxy')
    .map(([key]) => `${key.toUpperCase()}_${suffix}`);
  if (config.proxy === '' && region === 'cn') {
    missing.push('CN_S3_HTTPS_PROXY');
  }
  if (missing.length > 0) {
    console.error(`s3-alias-pointer: missing ${region} configuration: ${missing.join(', ')}`);
    process.exit(1);
  }
  if (config.bucket !== EXPECTED_BUCKET) {
    console.error(
      `s3-alias-pointer: ${region} bucket must be '${EXPECTED_BUCKET}', got '${config.bucket}'`,
    );
    process.exit(1);
  }
  return config;
}

function makeAws(config) {
  const env = {
    ...process.env,
    AWS_ACCESS_KEY_ID: config.accessKeyId,
    AWS_SECRET_ACCESS_KEY: config.secretAccessKey,
    AWS_DEFAULT_REGION: 'us-east-1',
  };
  if (config.proxy) {
    env.HTTPS_PROXY = config.proxy;
    env.https_proxy = config.proxy;
  } else {
    delete env.HTTPS_PROXY;
    delete env.https_proxy;
  }
  return (...cliArgs) =>
    spawnSync(awsBin, ['--endpoint-url', config.endpoint, ...cliArgs], {
      encoding: 'utf8',
      env,
    });
}

const scratch = mkdtempSync(join(tmpdir(), 'viceme-s3-alias-'));
try {
  for (const region of regions) {
    const config = regionConfig(region);
    const aws = makeAws(config);
    const pointerUrl = `${config.publicBase}/${POINTER_KEY}`;

    // 1. Policy against the live public pointer, BEFORE any write.
    const current = await readPointerValue(pointerUrl);
    const decision = decideMutableTagMove({
      mode: args.mode,
      current,
      target: args.version,
      expectedCurrent: args.fromCurrent,
    });
    if (!decision.allowed) {
      console.error(`alias policy refused for ${region}: ${decision.reason}`);
      process.exit(1);
    }
    console.log(`alias policy ${region}: ${decision.reason}`);

    // 2. Loader object under the alias path (immutable semantics).
    const loaderLocal = join(scratch, 'viceme.min.js');
    rmSync(loaderLocal, { force: true });
    const loaderGet = aws(
      's3',
      'cp',
      `s3://${config.bucket}/sdk/${args.version}/viceme.min.js`,
      loaderLocal,
      '--only-show-errors',
    );
    if (loaderGet.status !== 0) {
      console.error(
        `s3-alias-pointer: loader object missing at sdk/${args.version}/viceme.min.js for ${region} — publish the exact version first`,
      );
      process.exit(1);
    }
    const aliasLoaderKey = `sdk/${ALIAS_SEGMENT}/viceme.min.js`;
    const aliasHead = aws(
      's3api',
      'head-object',
      '--bucket',
      config.bucket,
      '--key',
      aliasLoaderKey,
    );
    if (aliasHead.status === 0) {
      const existing = join(scratch, 'existing-loader');
      rmSync(existing, { force: true });
      const cp = aws(
        's3',
        'cp',
        `s3://${config.bucket}/${aliasLoaderKey}`,
        existing,
        '--only-show-errors',
      );
      if (cp.status !== 0) {
        console.error(
          `s3-alias-pointer: could not read existing alias loader:\n${cp.stderr ?? ''}`,
        );
        process.exit(1);
      }
      const a = createHash('sha256').update(readFileSync(loaderLocal)).digest('hex');
      const b = createHash('sha256').update(readFileSync(existing)).digest('hex');
      if (a !== b) {
        console.error(
          `immutable violation: ${aliasLoaderKey} exists with different bytes in ${region}`,
        );
        process.exit(1);
      }
      console.log(`${region}: alias loader already identical`);
    } else if (
      /404|NoSuchKey|Not Found/i.test(`${aliasHead.stderr ?? ''}${aliasHead.stdout ?? ''}`)
    ) {
      const cp = aws(
        's3',
        'cp',
        loaderLocal,
        `s3://${config.bucket}/${aliasLoaderKey}`,
        '--cache-control',
        'public,max-age=31536000,immutable',
        '--only-show-errors',
      );
      if (cp.status !== 0) {
        console.error(`s3-alias-pointer: alias loader upload failed:\n${cp.stderr ?? ''}`);
        process.exit(1);
      }
    } else {
      console.error(`head-object failed for ${aliasLoaderKey}:\n${aliasHead.stderr ?? ''}`);
      process.exit(1);
    }

    // 3. The single mutable pointer object, then bounded convergence.
    const pointerLocal = join(scratch, 'pointer-version');
    writeFileSync(pointerLocal, args.version);
    const put = aws(
      's3',
      'cp',
      pointerLocal,
      `s3://${config.bucket}/${POINTER_KEY}`,
      '--content-type',
      'text/plain',
      '--cache-control',
      'public,max-age=300',
      '--only-show-errors',
    );
    if (put.status !== 0) {
      console.error(`s3-alias-pointer: pointer upload failed:\n${put.stderr ?? ''}`);
      process.exit(1);
    }
    await awaitPointerConvergence(pointerUrl, args.version, args.convergeTimeoutMs, 1_000);
    console.log(`${region}: ${pointerUrl} -> ${args.version}`);
  }
  console.log(`alias written and verified in ${regions.length} region(s)`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
