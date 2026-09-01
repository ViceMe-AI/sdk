#!/usr/bin/env node
/**
 * Move the stable `/viceme-sdk/v1` alias on the dual-region S3 topology.
 *
 * Per region (credentials via env, region-selected):
 *   1. verify the exact version's license and manifest, then read the current
 *      public pointer and apply the shared policy
 *      (promote = monotonic forward only; rollback = explicit, requires
 *      --from-current to match the live value);
 *   2. publish the loader object at bucket key v1/viceme.min.js with immutable
 *      semantics (absent -> upload; identical -> skip; different -> fail);
 *      loader bytes are content-stable, so a torn write stays functional;
 *   3. write the single pointer object at bucket key -/aliases/v1 (the one mutable
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
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decideMutableTagMove } from './lib/release-policy.mjs';
import {
  awaitBodyEquals,
  awaitPointerConvergence,
  readPointerState,
} from './lib/pointer-client.mjs';

const BUCKET_PATH = 'viceme-sdk';
const POINTER_KEY = '-/aliases/v1';
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

    const licenseLocal = join(scratch, `LICENSE-${region}`);
    const licenseGet = aws(
      's3',
      'cp',
      `s3://${config.bucket}/${args.version}/LICENSE`,
      licenseLocal,
      '--only-show-errors',
    );
    if (licenseGet.status !== 0 || readFileSync(licenseLocal, 'utf8').trim() === '') {
      console.error(
        `s3-alias-pointer: exact version ${args.version} has no non-empty LICENSE in ${region}`,
      );
      process.exit(1);
    }

    const manifestLocal = join(scratch, `manifest-${region}.json`);
    const manifestGet = aws(
      's3',
      'cp',
      `s3://${config.bucket}/${args.version}/manifest.json`,
      manifestLocal,
      '--only-show-errors',
    );
    let manifest;
    try {
      manifest = manifestGet.status === 0 ? JSON.parse(readFileSync(manifestLocal, 'utf8')) : null;
    } catch {
      manifest = null;
    }
    if (manifest?.version !== args.version || manifest?.apiMajor !== 1) {
      console.error(
        `s3-alias-pointer: exact version ${args.version} has an invalid manifest in ${region}`,
      );
      process.exit(1);
    }
    const pointerUrl = `${config.publicBase}/${BUCKET_PATH}/${POINTER_KEY}`;

    // 1. Policy against the live public pointer, BEFORE any write. The
    // read is strict: only an explicit 404 means "unset"; 403/5xx/timeouts
    // or a garbage body fail closed, so a stale run can never overwrite a
    // newer pointer during a transient read fault.
    const state = await readPointerState(pointerUrl);
    if (state.kind === 'error') {
      console.error(`pointer read failed for ${region}: ${state.detail} — failing closed`);
      process.exit(1);
    }
    const current = state.kind === 'value' ? state.value : undefined;
    const decision = decideMutableTagMove({
      mode: args.mode,
      current,
      target: args.version,
      expectedCurrent: args.fromCurrent,
    });
    if (!decision.allowed) {
      if (decision.converged) {
        // Partial-success rerun: this region already serves the target;
        // verify the alias bootstrap BYTES against the canonical build and
        // the pointer value, then continue with the other regions.
        const bootstrapLocal = join(scratch, `bootstrap-${region}.js`);
        rmSync(bootstrapLocal, { force: true });
        const bootstrapGet = aws(
          's3',
          'cp',
          `s3://${config.bucket}/${args.version}/bootstrap.min.js`,
          bootstrapLocal,
          '--only-show-errors',
        );
        if (bootstrapGet.status !== 0) {
          console.error(`converged region ${region}: canonical bootstrap missing`);
          process.exit(1);
        }
        const aliasLoaderUrl = `${config.publicBase}/${BUCKET_PATH}/${ALIAS_SEGMENT}/viceme.min.js`;
        await awaitBodyEquals(aliasLoaderUrl, readFileSync(bootstrapLocal), 15_000);
        await awaitPointerConvergence(pointerUrl, args.version, 2_000, 500);
        console.log(`alias policy ${region}: ${decision.reason}`);
        continue;
      }
      console.error(`alias policy refused for ${region}: ${decision.reason}`);
      process.exit(1);
    }
    console.log(`alias policy ${region}: ${decision.reason}`);

    // 2. The alias path carries the FIXED bootstrap (byte-stable for the
    // whole API major): canonical bytes come from
    // <version>/bootstrap.min.js in this bucket. v1/viceme.min.js is an
    // alias object — writable like the pointer — and correctness is
    // guarded by an exact public byte read-back, never by assuming the
    // first release's bytes are frozen forever.
    const bootstrapLocal = join(scratch, 'bootstrap.min.js');
    rmSync(bootstrapLocal, { force: true });
    const bootstrapGet = aws(
      's3',
      'cp',
      `s3://${config.bucket}/${args.version}/bootstrap.min.js`,
      bootstrapLocal,
      '--only-show-errors',
    );
    if (bootstrapGet.status !== 0) {
      console.error(
        `s3-alias-pointer: canonical bootstrap missing at ${args.version}/bootstrap.min.js for ${region} — publish the exact version first`,
      );
      process.exit(1);
    }
    const canonicalBootstrap = readFileSync(bootstrapLocal);
    const aliasLoaderKey = `${ALIAS_SEGMENT}/viceme.min.js`;
    const put = aws(
      's3',
      'cp',
      bootstrapLocal,
      `s3://${config.bucket}/${aliasLoaderKey}`,
      '--cache-control',
      'public,max-age=300',
      '--only-show-errors',
    );
    if (put.status !== 0) {
      console.error(`s3-alias-pointer: alias bootstrap upload failed:\n${put.stderr ?? ''}`);
      process.exit(1);
    }
    const aliasLoaderUrl = `${config.publicBase}/${BUCKET_PATH}/${aliasLoaderKey}`;
    await awaitBodyEquals(aliasLoaderUrl, canonicalBootstrap, 15_000);

    // 3. The single mutable pointer object, then bounded convergence.
    const pointerLocal = join(scratch, 'pointer-version');
    writeFileSync(pointerLocal, args.version);
    const pointerPut = aws(
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
    if (pointerPut.status !== 0) {
      console.error(`s3-alias-pointer: pointer upload failed:\n${pointerPut.stderr ?? ''}`);
      process.exit(1);
    }
    await awaitPointerConvergence(pointerUrl, args.version, args.convergeTimeoutMs, 1_000);
    console.log(`${region}: ${pointerUrl} -> ${args.version}`);
  }
  console.log(`alias written and verified in ${regions.length} region(s)`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
