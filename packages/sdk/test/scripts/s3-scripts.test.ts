// @vitest-environment node
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createServer, type Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const exec = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const scriptsDir = join(here, '..', '..', '..', '..', 'scripts');
const tmpRoot = mkdtempSync(join(tmpdir(), 'viceme-s3-scripts-'));

/**
 * Fake `aws` CLI: records invocations and emulates an S3-compatible origin
 * backed by a directory (head-bucket always OK; head-object exits 254 with
 * 404 text for missing keys; s3 cp copies both ways; verify-cdn's public
 * read-back is served by a local static server over that directory).
 */
const fakeAws = join(tmpRoot, 'fake-aws.mjs');
const storeRoot = join(tmpRoot, 'store');
mkdirSync(storeRoot, { recursive: true });
writeFileSync(
  fakeAws,
  [
    '#!/usr/bin/env node',
    "import { cpSync, existsSync, mkdirSync, appendFileSync } from 'node:fs';",
    "import { dirname, join } from 'node:path';",
    "const log = process.env.FAKE_AWS_LOG ?? '';",
    "const store = process.env.FAKE_AWS_STORE ?? '';",
    'const argv = process.argv.slice(2);',
    '// argv: --endpoint-url <url> <command...>',
    'const command = argv.slice(2);',
    "const sub = command.join(' ');",
    "if (log) appendFileSync(log, sub + '\\n');",
    "const keyOf = (s) => s.replace(/^s3:\\/\\/[^/]+\\//, '');",
    "if (sub.startsWith('s3api head-bucket')) process.exit(0);",
    "if (sub.startsWith('s3api head-object')) {",
    "  const key = command[command.indexOf('--key') + 1];",
    '  if (existsSync(join(store, key))) process.exit(0);',
    "  process.stderr.write('404 NoSuchKey');",
    '  process.exit(254);',
    '}',
    "if (sub.startsWith('s3 cp')) {",
    '  const positional = command.slice(2).filter((a) => !a.startsWith("--"));',
    '  const [from, to] = positional;',
    '  const src = from.startsWith("s3://") ? join(store, keyOf(from)) : from;',
    '  const dst = to.startsWith("s3://") ? join(store, keyOf(to)) : to;',
    '  if (!existsSync(src)) { process.stderr.write("404 NoSuchKey"); process.exit(254); }',
    '  mkdirSync(dirname(dst), { recursive: true });',
    '  cpSync(src, dst);',
    '  process.exit(0);',
    '}',
    "process.stderr.write('unsupported: ' + sub);",
    'process.exit(1);',
  ].join('\n'),
);
chmodSync(fakeAws, 0o755);

const distDir = join(tmpRoot, 'dist');
const digest = (body: Buffer) => ({
  sha256: createHash('sha256').update(body).digest('hex'),
  sri: `sha384-${createHash('sha384').update(body).digest('base64')}`,
  bytes: body.length,
  gzipBytes: body.length,
});
const indexBody = Buffer.from('export const SDK_VERSION = "0.1.0";\n');
const loaderBody = Buffer.from('(function(){/* data-viceme */})();\n');
const danmakuBody = Buffer.from('export const mount = () => {};\n');
const tipBody = Buffer.from('export const mountTip = () => {};\n');
const tipTestingBody = Buffer.from('export const createTestTip = () => {};\n');
const licenseBody = Buffer.from('Test-only approved license fixture.\n');
mkdirSync(distDir, { recursive: true });
writeFileSync(join(distDir, 'LICENSE'), licenseBody);
writeFileSync(join(distDir, 'index.js'), indexBody);
writeFileSync(join(distDir, 'viceme.min.js'), loaderBody);
writeFileSync(join(distDir, 'danmaku.js'), danmakuBody);
writeFileSync(join(distDir, 'tip.js'), tipBody);
mkdirSync(join(distDir, 'tip'));
writeFileSync(join(distDir, 'tip', 'testing.js'), tipTestingBody);
writeFileSync(
  join(distDir, 'manifest.json'),
  `${JSON.stringify(
    {
      version: '0.1.0',
      apiMajor: 1,
      loader: 'viceme.min.js',
      features: { danmaku: 'danmaku.js', tip: 'tip.js' },
      files: {
        'index.js': digest(indexBody),
        'viceme.min.js': digest(loaderBody),
        'danmaku.js': digest(danmakuBody),
        'tip.js': digest(tipBody),
        'tip/testing.js': digest(tipTestingBody),
      },
    },
    null,
    2,
  )}\n`,
);

let publicServer: { url: string; close: () => Promise<void> } | undefined;

beforeAll(async () => {
  // Public entry: serves the same store the fake aws writes into, with the
  // headers verify-cdn expects.
  const httpServer: Server = createServer((req, res) => {
    const path = decodeURIComponent((req.url ?? '').replace(/^\/viceme-sdk\//, ''));
    try {
      const body = readFileSync(join(storeRoot, path));
      const type = path.endsWith('.json')
        ? 'application/json; charset=utf-8'
        : 'text/javascript; charset=utf-8';
      res.writeHead(200, {
        'content-type': type,
        'cache-control': 'public,max-age=31536000,immutable',
        ...(req.headers.origin === 'https://example.com'
          ? { 'access-control-allow-origin': '*' }
          : {}),
      });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end('not found');
    }
  });
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const address = httpServer.address();
  if (address === null || typeof address === 'string') throw new Error('bind failed');
  publicServer = {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((done) => httpServer.close(() => done())),
  };
});

afterAll(async () => {
  await publicServer?.close();
});

function runS3(script: string, args: string[], env: Record<string, string>) {
  return exec('node', [join(scriptsDir, script), ...args], {
    env: {
      ...process.env,
      AWS_BIN: fakeAws,
      FAKE_AWS_STORE: storeRoot,
      EXPECT_BUCKET: 'viceme-sdk',
      ...env,
    },
  });
}

const REGION_ENV = {
  S3_ENDPOINT: 'https://fake.example',
  S3_BUCKET: 'viceme-sdk',
  S3_ACCESS_KEY_ID: 'test-key',
  S3_SECRET_ACCESS_KEY: 'test-secret',
};

describe('publish-s3-region.mjs', () => {
  it('refuses verified dist bytes without the npm tarball license', async () => {
    const unlicensedDist = join(tmpRoot, 'unlicensed-dist');
    cpSync(distDir, unlicensedDist, { recursive: true });
    rmSync(join(unlicensedDist, 'LICENSE'));

    await expect(
      runS3(
        'publish-s3-region.mjs',
        [
          '--dist',
          unlicensedDist,
          '--prefix',
          '0.1.0/',
          '--public-base',
          `${publicServer!.url}/viceme-sdk/0.1.0/`,
          '--label',
          'CN',
        ],
        REGION_ENV,
      ),
    ).rejects.toMatchObject({ code: 1 });
  });

  it('fails closed when any credential is missing', async () => {
    for (const key of ['S3_ENDPOINT', 'S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY']) {
      const env = { ...REGION_ENV };
      delete env[key as keyof typeof REGION_ENV];
      await expect(
        runS3(
          'publish-s3-region.mjs',
          [
            '--dist',
            distDir,
            '--prefix',
            '0.1.0/',
            '--public-base',
            `${publicServer!.url}/viceme-sdk/0.1.0/`,
            '--label',
            'CN',
          ],
          env,
        ),
      ).rejects.toMatchObject({ code: 1 });
    }
  });

  it('fails closed on a non-dedicated bucket', async () => {
    await expect(
      runS3(
        'publish-s3-region.mjs',
        [
          '--dist',
          distDir,
          '--prefix',
          '0.1.0/',
          '--public-base',
          `${publicServer!.url}/viceme-sdk/0.1.0/`,
          '--label',
          'CN',
        ],
        { ...REGION_ENV, S3_BUCKET: 'shared-shop-bucket' },
      ),
    ).rejects.toMatchObject({ code: 1 });
  });

  it('uploads to an empty region, then is idempotent, then fails on tampering', async () => {
    const args = [
      '--dist',
      distDir,
      '--prefix',
      '0.1.0/',
      '--public-base',
      `${publicServer!.url}/viceme-sdk/0.1.0/`,
      '--label',
      'CN',
    ];
    // Empty region: everything uploads and the public read-back passes.
    const first = await runS3('publish-s3-region.mjs', args, REGION_ENV);
    expect(first.stdout).toContain('CN: 7 uploaded, 0 already identical');

    // Re-run: byte-identical objects are skipped.
    const second = await runS3('publish-s3-region.mjs', args, REGION_ENV);
    expect(second.stdout).toContain('CN: 0 uploaded, 7 already identical');

    // Tamper one object: the immutable violation fails closed.
    writeFileSync(join(storeRoot, '0.1.0/index.js'), 'tampered\n');
    await expect(runS3('publish-s3-region.mjs', args, REGION_ENV)).rejects.toMatchObject({
      code: 1,
    });
    writeFileSync(join(storeRoot, '0.1.0/index.js'), indexBody);
  });
});
