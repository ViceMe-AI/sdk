#!/usr/bin/env node
/**
 * Public CDN read-back verification (§14.2 step 8, §15.2).
 *
 * Modes:
 *   node scripts/verify-cdn.mjs --base https://cdn.viceme.cn/sdk/1.2.3/
 *       Fetch the release manifest over the public network and verify every
 *       artifact: sha256, sri (sha384), bytes, content-type, and immutable
 *       cache headers for exact versions.
 *
 *   node scripts/verify-cdn.mjs --base https://cdn.viceme.cn/sdk/v1/ --expect-version 1.2.3
 *       Alias mode: the stable-major manifest must resolve to the exact
 *       expected version, and alias artifacts must be byte-identical.
 *
 *   node scripts/verify-cdn.mjs --local packages/sdk/dist
 *       Self-check a local build directory against its own manifest.
 *
 * Exit code 0 = every check passed; any mismatch fails loudly — the SDK never
 * guesses at runtime and promotion never continues on a bad read-back.
 */
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--base') args.base = argv[++i];
    else if (arg === '--expect-version') args.expectVersion = argv[++i];
    else if (arg === '--local') args.local = argv[++i];
    else if (arg === '--allow-mutable-cache') args.allowMutableCache = true;
    else args._.push(arg);
  }
  return args;
}

const MIME_BY_EXT = {
  '.js': ['text/javascript', 'application/javascript'],
  '.mjs': ['text/javascript', 'application/javascript'],
  '.json': ['application/json'],
  '.map': ['application/json', 'application/octet-stream'],
};

function expectedContentTypes(file) {
  const ext = file.slice(file.lastIndexOf('.'));
  return MIME_BY_EXT[ext] ?? null;
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function sri384(buffer) {
  return `sha384-${createHash('sha384').update(buffer).digest('base64')}`;
}

const failures = [];
function check(condition, message) {
  if (!condition) failures.push(message);
}

async function verifyLocal(distDir) {
  const manifest = JSON.parse(await readFile(join(distDir, 'manifest.json'), 'utf8'));
  const files = [];
  const walk = async (dir) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else files.push(full);
    }
  };
  await walk(distDir);
  const relative = new Set(
    files.map((f) => f.slice(distDir.length + 1)).filter((f) => !f.endsWith('.map')),
  );
  const listed = new Set(Object.keys(manifest.files));
  for (const file of listed) {
    if (!relative.has(file)) check(false, `manifest lists missing file: ${file}`);
  }
  for (const file of Object.keys(manifest.files)) {
    const buffer = await readFile(join(distDir, file));
    const info = manifest.files[file];
    check(sha256(buffer) === info.sha256, `${file}: sha256 mismatch`);
    check(sri384(buffer) === info.sri, `${file}: sri mismatch`);
    check(buffer.length === info.bytes, `${file}: bytes mismatch`);
  }
  return manifest;
}

async function fetchOrThrow(url) {
  const response = await fetch(url, { credentials: 'omit' });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  return { response, buffer };
}

async function verifyRemote(base, { expectVersion, allowMutableCache }) {
  if (expectVersion !== undefined && !allowMutableCache) {
    // Alias verification on the S3 topology resolves the POINTER, then
    // fully verifies the pointed-to exact version (the alias path itself
    // holds no manifest copy).
    const aliasBase = new URL(base.endsWith('/') ? base : `${base}/`);
    if (!/^\/viceme-sdk\/\d+\.\d+\.\d+[^/]*\//.test(aliasBase.pathname)) {
      return verifyAliasByPointer(aliasBase, expectVersion);
    }
  }
  return verifyExactVersion(base, { expectVersion, allowMutableCache });
}

/** Alias mode: pointer must equal the expected version; then verify it. */
async function verifyAliasByPointer(aliasBase, expectVersion) {
  const pointerUrl = new URL('/viceme-sdk/-/aliases/v1', aliasBase);
  const { buffer: pointerBuffer } = await fetchOrThrow(pointerUrl);
  const pointerVersion = pointerBuffer.toString('utf8').trim();
  check(
    pointerVersion === expectVersion,
    `alias pointer is '${pointerVersion}', expected '${expectVersion}'`,
  );
  console.log(`alias pointer verified -> ${pointerVersion}`);
  const exactBase = new URL(`/viceme-sdk/${expectVersion}/`, aliasBase);
  return verifyExactVersion(exactBase.toString(), {
    expectVersion,
    allowMutableCache: false,
  });
}

async function verifyExactVersion(base, { expectVersion, allowMutableCache }) {
  const manifestUrl = new URL('manifest.json', base.endsWith('/') ? base : `${base}/`);
  const { response: manifestResponse, buffer: manifestBuffer } = await fetchOrThrow(manifestUrl);
  const manifest = JSON.parse(manifestBuffer.toString('utf8'));

  const manifestContentType = manifestResponse.headers.get('content-type') ?? '';
  check(
    manifestContentType.includes('application/json'),
    `manifest.json: content-type is "${manifestContentType}"`,
  );
  if (expectVersion !== undefined) {
    check(
      manifest.version === expectVersion,
      `alias manifest version ${manifest.version} != expected ${expectVersion}`,
    );
  }
  const isExactVersion = /^\/viceme-sdk\/\d+\.\d+\.\d+[^/]*\//.test(manifestUrl.pathname);
  if (isExactVersion && !allowMutableCache) {
    const cacheControl = manifestResponse.headers.get('cache-control') ?? '';
    check(
      /immutable|max-age=\d{9,}/.test(cacheControl),
      `manifest.json: exact version must be immutable, cache-control is "${cacheControl}"`,
    );
  }

  for (const [file, info] of Object.entries(manifest.files)) {
    const url = new URL(file, manifestUrl);
    const { response, buffer } = await fetchOrThrow(url);
    check(sha256(buffer) === info.sha256, `${file}: sha256 mismatch`);
    check(sri384(buffer) === info.sri, `${file}: sri mismatch`);
    check(buffer.length === info.bytes, `${file}: bytes mismatch (got ${buffer.length})`);
    const contentType = response.headers.get('content-type') ?? '';
    const allowed = expectedContentTypes(file);
    if (allowed) {
      check(
        allowed.some((candidate) => contentType.includes(candidate)),
        `${file}: content-type is "${contentType}"`,
      );
    }
    if (isExactVersion && !allowMutableCache) {
      const cacheControl = response.headers.get('cache-control') ?? '';
      check(
        /immutable|max-age=\d{9,}/.test(cacheControl),
        `${file}: exact version must be immutable, cache-control is "${cacheControl}"`,
      );
    }
    const cors = response.headers.get('access-control-allow-origin');
    check(cors !== null, `${file}: missing access-control-allow-origin`);
  }
  return manifest;
}

const args = parseArgs(process.argv.slice(2));
try {
  if (args.local) {
    const manifest = await verifyLocal(args.local);
    console.log(
      `local verification passed: ${manifest.version} (${Object.keys(manifest.files).length} artifacts)`,
    );
  } else if (args.base) {
    const manifest = await verifyRemote(args.base, args);
    console.log(
      `cdn verification passed: ${manifest.version} @ ${args.base} (${Object.keys(manifest.files).length} artifacts)`,
    );
  } else {
    console.error('usage: verify-cdn.mjs --base <url> [--expect-version x.y.z] | --local <dir>');
    process.exit(2);
  }
} catch (error) {
  console.error(`verification failed: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
}

if (failures.length > 0) {
  console.error(`verification failed with ${failures.length} finding(s):`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
