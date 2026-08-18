#!/usr/bin/env node
/**
 * Fetch the EXACT published artifacts of an approved SDK package from npm.
 *
 * The published tarball is the authoritative byte source for every
 * downstream delivery (GitHub release assets, CDN/S3 objects): all of them
 * stay byte-identical to what npm serves (§13.3).
 *
 * Usage:
 *   node scripts/fetch-npm-dist.mjs --package @viceme-ai/sdk --version 1.2.3 --out verified-dist
 *
 * Verifies the extracted dist against its own manifest before exiting.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { cpSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const args = { package: '@viceme-ai/sdk' };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--package') args.package = argv[++i];
    else if (argv[i] === '--version') args.version = argv[++i];
    else if (argv[i] === '--out') args.out = argv[++i];
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
if (!args.version || !args.out) {
  console.error('usage: fetch-npm-dist.mjs --package <pkg> --version <v> --out <dir>');
  process.exit(2);
}
if (!['@viceme-ai/sdk', '@viceme-ai/sdk-poc'].includes(args.package)) {
  console.error(`fetch-npm-dist: unsupported package ${args.package}`);
  process.exit(1);
}
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(args.version)) {
  console.error(`fetch-npm-dist: invalid version ${args.version}`);
  process.exit(1);
}

const tmp = mkdtempSync(join(tmpdir(), 'viceme-fetch-dist-'));
try {
  execFileSync('npm', ['pack', `${args.package}@${args.version}`, '--pack-destination', tmp], {
    cwd: tmp,
    stdio: 'inherit',
  });
  const tarball = readdirSync(tmp).find((f) => f.endsWith('.tgz'));
  if (!tarball) throw new Error('npm pack produced no tarball');

  const extractDir = join(tmp, 'extracted');
  mkdirSync(extractDir, { recursive: true });
  execFileSync('tar', ['-xzf', join(tmp, tarball), '-C', extractDir], { stdio: 'inherit' });

  const dist = join(extractDir, 'package', 'dist');
  mkdirSync(args.out, { recursive: true });
  rmSync(args.out, { recursive: true, force: true });
  cpSync(dist, args.out, { recursive: true });

  execFileSync(process.execPath, [join(here, 'verify-cdn.mjs'), '--local', args.out], {
    stdio: 'inherit',
  });
  console.log(`fetched ${args.package}@${args.version} dist into ${args.out}`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
