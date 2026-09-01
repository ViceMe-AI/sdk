#!/usr/bin/env node
/**
 * Build the release manifest for `packages/sdk/dist`.
 *
 * Computes SHA-256, SRI (sha384), raw and gzip sizes for every runtime
 * artifact. The npm tarball and the CDN upload must carry byte-identical
 * files — this manifest is the single source of digests for both.
 *
 * Run after `build:esm`, `build:loader`, and `build:types` (fixed order).
 */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { createGzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { readApiMajor } from './lib/version-source.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const sdkDir = join(here, '..', 'packages', 'sdk');
const distDir = join(sdkDir, 'dist');

const pkg = JSON.parse(await readFile(join(sdkDir, 'package.json'), 'utf8'));

async function listFiles(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await listFiles(full)));
    else out.push(full);
  }
  return out;
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function sri384(buffer) {
  const digest = createHash('sha384').update(buffer).digest('base64');
  return `sha384-${digest}`;
}

async function gzipBytes(file) {
  const chunks = [];
  await pipeline(createReadStream(file), createGzip({ level: 9 }), async (source) => {
    for await (const chunk of source) chunks.push(chunk);
  });
  return Buffer.concat(chunks).length;
}

const files = await listFiles(distDir);
const manifest = {
  version: pkg.version,
  // Must come from the runtime source of truth: the loader refuses a
  // manifest whose major does not match its own API_MAJOR.
  apiMajor: readApiMajor(sdkDir),
  loader: 'viceme.min.js',
  features: {},
  files: {},
};

for (const file of files.sort()) {
  const rel = relative(distDir, file);
  if (
    rel === 'manifest.json' ||
    rel.endsWith('.map') ||
    rel.endsWith('.d.ts') ||
    rel.endsWith('.d.ts.map')
  ) {
    continue;
  }
  const buffer = await readFile(file);
  const info = await stat(file);
  manifest.files[rel] = {
    sha256: sha256(buffer),
    sri: sri384(buffer),
    bytes: info.size,
    gzipBytes: await gzipBytes(file),
  };
}

// Sanity: npm and hosted-loader runtime entries must all be present.
for (const required of [
  'index.js',
  'viceme.min.js',
  'danmaku.js',
  'testing.js',
  'tip.js',
  'tip/testing.js',
]) {
  if (!manifest.files[required]) {
    console.error(`manifest: missing required artifact ${required}`);
    process.exit(1);
  }
}

manifest.features.danmaku = 'danmaku.js';
manifest.features.tip = 'tip.js';

await writeFile(join(distDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`manifest: ${Object.keys(manifest.files).length} artifacts @ ${pkg.version}`);
