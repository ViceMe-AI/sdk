// @vitest-environment node
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
const bootstrapBody = Buffer.from('(function(){/* fixed alias bootstrap */})();\n');
const danmakuBody = Buffer.from('export const mount = () => {};\n');
mkdirSync(distDir, { recursive: true });
writeFileSync(join(distDir, 'index.js'), indexBody);
writeFileSync(join(distDir, 'viceme.min.js'), loaderBody);
writeFileSync(join(distDir, 'bootstrap.min.js'), bootstrapBody);
writeFileSync(join(distDir, 'danmaku.js'), danmakuBody);
writeFileSync(
  join(distDir, 'manifest.json'),
  `${JSON.stringify(
    {
      version: '0.1.0',
      apiMajor: 1,
      loader: 'viceme.min.js',
      features: { danmaku: 'danmaku.js' },
      files: {
        'index.js': digest(indexBody),
        'viceme.min.js': digest(loaderBody),
        'bootstrap.min.js': digest(bootstrapBody),
        'danmaku.js': digest(danmakuBody),
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
        'content-type': path === '-/aliases/v1' ? 'text/plain; charset=utf-8' : type,
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
    expect(first.stdout).toContain('CN: 5 uploaded, 0 already identical');

    // Re-run: byte-identical objects are skipped.
    const second = await runS3('publish-s3-region.mjs', args, REGION_ENV);
    expect(second.stdout).toContain('CN: 0 uploaded, 5 already identical');

    // Tamper one object: the immutable violation fails closed.
    writeFileSync(join(storeRoot, '0.1.0/index.js'), 'tampered\n');
    await expect(runS3('publish-s3-region.mjs', args, REGION_ENV)).rejects.toMatchObject({
      code: 1,
    });
    writeFileSync(join(storeRoot, '0.1.0/index.js'), indexBody);
  });
});

describe('s3-alias-pointer.mjs', () => {
  const ALIAS_ENV = {
    S3_ENDPOINT_CN: 'https://fake.cn',
    S3_BUCKET_CN: 'viceme-sdk',
    S3_ACCESS_KEY_ID_CN: 'test-key',
    S3_SECRET_ACCESS_KEY_CN: 'test-secret',
    CN_S3_HTTPS_PROXY: 'http://127.0.0.1:9',
    S3_ENDPOINT_GLOBAL: 'https://fake.global',
    S3_BUCKET_GLOBAL: 'viceme-sdk',
    S3_ACCESS_KEY_ID_GLOBAL: 'test-key',
    S3_SECRET_ACCESS_KEY_GLOBAL: 'test-secret',
  };

  function aliasArgs(extra: string[]) {
    return [
      '--version',
      '0.1.0',
      '--regions',
      'cn',
      '--public-base-cn',
      publicServer!.url,
      '--converge-timeout-ms',
      '5000',
      ...extra,
    ];
  }

  it('fails closed when region configuration is incomplete', async () => {
    const env: Record<string, string> = { ...ALIAS_ENV };
    delete env.CN_S3_HTTPS_PROXY;
    await expect(runS3('s3-alias-pointer.mjs', aliasArgs([]), env)).rejects.toMatchObject({
      code: 1,
    });
  });

  it('requires the exact version objects before promoting the alias', async () => {
    // 9.9.9 was never published to the store: the alias must not move.
    await expect(
      runS3(
        's3-alias-pointer.mjs',
        [
          '--version',
          '9.9.9',
          '--regions',
          'cn',
          '--public-base-cn',
          publicServer!.url,
          '--converge-timeout-ms',
          '5000',
        ],
        ALIAS_ENV,
      ),
    ).rejects.toMatchObject({ code: 1 });
  });

  it('a partial-success rerun converges remaining regions (same version = converged)', async () => {
    // CN fully at 0.2.0 (previous run wrote loader + pointer), GLOBAL unset
    // (previous run failed midway). The rerun must treat CN as converged
    // and finish GLOBAL.
    mkdirSync(join(storeRoot, '0.2.0'), { recursive: true });
    writeFileSync(join(storeRoot, '0.2.0', 'viceme.min.js'), loaderBody);
    writeFileSync(join(storeRoot, '0.2.0', 'bootstrap.min.js'), bootstrapBody);
    mkdirSync(join(storeRoot, 'v1'), { recursive: true });
    writeFileSync(join(storeRoot, 'v1', 'viceme.min.js'), bootstrapBody);
    mkdirSync(join(storeRoot, '-', 'aliases'), { recursive: true });
    writeFileSync(join(storeRoot, '-', 'aliases', 'v1'), '0.2.0');

    const rerun = await exec(
      'node',
      [
        join(scriptsDir, 's3-alias-pointer.mjs'),
        '--version',
        '0.2.0',
        '--regions',
        'cn,global',
        '--public-base-cn',
        publicServer!.url,
        '--public-base-global',
        publicServer!.url,
        '--converge-timeout-ms',
        '5000',
      ],
      {
        env: {
          ...process.env,
          AWS_BIN: fakeAws,
          FAKE_AWS_STORE: storeRoot,
          EXPECT_BUCKET: 'viceme-sdk',
          ...ALIAS_ENV,
        },
      },
    );
    expect(rerun.stdout).toContain('pointer already at 0.2.0 (region converged)');
    expect(rerun.stdout).toContain('alias written and verified in 2 region(s)');
  });

  it('fails closed when the live pointer read errors (no unset fallback)', async () => {
    // A pointer endpoint returning 503 must NOT be treated as "unset":
    // an older-version rerun could otherwise overwrite a newer pointer.
    const failing = createServer((_req, res) => {
      res.writeHead(503);
      res.end('unavailable');
    });
    await new Promise<void>((resolve) => failing.listen(0, '127.0.0.1', resolve));
    const failingAddress = failing.address();
    if (failingAddress === null || typeof failingAddress === 'string') throw new Error('bind');
    const failingUrl = `http://127.0.0.1:${failingAddress.port}`;
    try {
      const result = await exec(
        'node',
        [
          join(scriptsDir, 's3-alias-pointer.mjs'),
          '--version',
          '0.1.0',
          '--regions',
          'cn',
          '--public-base-cn',
          failingUrl,
          '--converge-timeout-ms',
          '5000',
        ],
        {
          env: {
            ...process.env,
            AWS_BIN: fakeAws,
            FAKE_AWS_STORE: storeRoot,
            EXPECT_BUCKET: 'viceme-sdk',
            ...ALIAS_ENV,
          },
        },
      ).catch((error: { code?: number; stderr?: string }) => error);
      expect(result).toMatchObject({ code: 1 });
      expect(String((result as { stderr?: string }).stderr)).toContain('failing closed');
    } finally {
      await new Promise<void>((done) => failing.close(() => done()));
    }
  });

  it('a hung pointer response cannot stall the bounded wait (per-request timeout)', async () => {
    // Server accepts the connection but never responds: every fetch must
    // hit its own timeout so the run fails within the budget.
    const hung = createServer(() => {
      /* deliberately never respond */
    });
    await new Promise<void>((resolve) => hung.listen(0, '127.0.0.1', resolve));
    const hungAddress = hung.address();
    if (hungAddress === null || typeof hungAddress === 'string') throw new Error('bind');
    const hungUrl = `http://127.0.0.1:${hungAddress.port}`;
    try {
      const result = await exec(
        'node',
        [
          join(scriptsDir, 's3-alias-pointer.mjs'),
          '--version',
          '0.1.0',
          '--regions',
          'cn',
          '--public-base-cn',
          hungUrl,
          '--converge-timeout-ms',
          '8000',
        ],
        {
          env: {
            ...process.env,
            AWS_BIN: fakeAws,
            FAKE_AWS_STORE: storeRoot,
            EXPECT_BUCKET: 'viceme-sdk',
            ...ALIAS_ENV,
          },
        },
      ).catch((error: { code?: number }) => error);
      expect(result).toMatchObject({ code: 1 });
    } finally {
      await new Promise<void>((done) => hung.close(() => done()));
    }
  }, 30_000);

  it('promotes forward after the exact version exists, then refuses a backward promote', async () => {
    // Isolate the pointer for this scenario's lifecycle.
    rmSync(join(storeRoot, '-', 'aliases', 'v1'), { force: true });
    rmSync(join(storeRoot, 'v1', 'viceme.min.js'), { force: true });
    mkdirSync(join(storeRoot, '0.2.0'), { recursive: true });
    writeFileSync(join(storeRoot, '0.2.0', 'viceme.min.js'), loaderBody);

    const promote = await runS3(
      's3-alias-pointer.mjs',
      [
        '--version',
        '0.1.0',
        '--regions',
        'cn',
        '--public-base-cn',
        publicServer!.url,
        '--converge-timeout-ms',
        '5000',
      ],
      ALIAS_ENV,
    );
    expect(promote.stdout).toContain('pointer unset; promoting to 0.1.0');
    expect(readFileSync(join(storeRoot, '-', 'aliases', 'v1'), 'utf8')).toBe('0.1.0');
    expect(readFileSync(join(storeRoot, 'v1/viceme.min.js'), 'utf8')).toBe(
      bootstrapBody.toString('utf8'),
    );

    // Forward promote to 0.2.0 succeeds.
    const forward = await runS3(
      's3-alias-pointer.mjs',
      [
        '--version',
        '0.2.0',
        '--regions',
        'cn',
        '--public-base-cn',
        publicServer!.url,
        '--converge-timeout-ms',
        '5000',
      ],
      ALIAS_ENV,
    );
    expect(forward.stdout).toContain('forward move 0.1.0 -> 0.2.0');

    // Backward promote is refused and the pointer is untouched.
    const failure = await exec(
      'node',
      [
        join(scriptsDir, 's3-alias-pointer.mjs'),
        '--version',
        '0.1.0',
        '--regions',
        'cn',
        '--public-base-cn',
        publicServer!.url,
        '--converge-timeout-ms',
        '5000',
      ],
      {
        env: {
          ...process.env,
          AWS_BIN: fakeAws,
          FAKE_AWS_STORE: storeRoot,
          EXPECT_BUCKET: 'viceme-sdk',
          ...ALIAS_ENV,
        },
      },
    ).catch((error: { code?: number; stderr?: string }) => error);
    expect(failure).toMatchObject({ code: 1 });
    expect(String((failure as { stderr?: string }).stderr)).toContain(
      'refusing to move pointer backward',
    );
    expect(readFileSync(join(storeRoot, '-', 'aliases', 'v1'), 'utf8')).toBe('0.2.0');
  });
});
