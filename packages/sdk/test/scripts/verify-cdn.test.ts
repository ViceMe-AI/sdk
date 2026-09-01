// @vitest-environment node
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync as writeFile } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createServer, type Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const exec = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, '..', '..', '..', '..', 'scripts', 'verify-cdn.mjs');
const distDir = mkdtempSync(join(tmpdir(), 'viceme-verify-cdn-'));

/**
 * CDN read-back verification tests. The fixture "release" (files + manifest
 * with real digests) is generated here, so the tests never depend on build
 * artifacts and run in any pipeline order.
 */

interface ServedFile {
  body: Buffer;
  contentType: string;
}

async function digestInfo(body: Buffer) {
  return {
    sha256: createHash('sha256').update(body).digest('hex'),
    sri: `sha384-${createHash('sha384').update(body).digest('base64')}`,
    bytes: body.length,
    gzipBytes: body.length,
  };
}

const files = new Map<string, ServedFile>();

const indexBody = Buffer.from('export const SDK_VERSION = "0.1.0";\n');
const loaderBody = Buffer.from('(function(){/* data-viceme loader */})();\n');
const danmakuBody = Buffer.from('export const mount = () => {};\n');
const tipBody = Buffer.from('export const mountTip = () => {};\n');
const tipTestingBody = Buffer.from('export const createTestTip = () => {};\n');

let server:
  | {
      url: string;
      close: () => Promise<void>;
    }
  | undefined;

beforeAll(async () => {
  await writeFile(join(distDir, 'index.js'), indexBody);
  await writeFile(join(distDir, 'danmaku.js'), danmakuBody);
  await writeFile(join(distDir, 'tip.js'), tipBody);
  mkdirSync(join(distDir, 'tip'));
  await writeFile(join(distDir, 'tip', 'testing.js'), tipTestingBody);
  await writeFile(join(distDir, 'viceme.min.js'), loaderBody);

  files.set('index.js', { body: indexBody, contentType: 'text/javascript; charset=utf-8' });
  files.set('danmaku.js', { body: danmakuBody, contentType: 'text/javascript; charset=utf-8' });
  files.set('tip.js', { body: tipBody, contentType: 'text/javascript; charset=utf-8' });
  files.set('tip/testing.js', {
    body: tipTestingBody,
    contentType: 'text/javascript; charset=utf-8',
  });
  files.set('viceme.min.js', {
    body: loaderBody,
    contentType: 'text/javascript; charset=utf-8',
  });

  const manifest = {
    version: '0.1.0',
    apiMajor: 1,
    loader: 'viceme.min.js',
    features: { danmaku: 'danmaku.js', tip: 'tip.js' },
    files: {
      'index.js': await digestInfo(indexBody),
      'danmaku.js': await digestInfo(danmakuBody),
      'tip.js': await digestInfo(tipBody),
      'tip/testing.js': await digestInfo(tipTestingBody),
      'viceme.min.js': await digestInfo(loaderBody),
    },
  };
  const manifestBody = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  files.set('manifest.json', {
    body: manifestBody,
    contentType: 'application/json; charset=utf-8',
  });
  await writeFile(join(distDir, 'manifest.json'), manifestBody);

  const httpServer: Server = createServer((req, res) => {
    // The public server exposes only an immutable exact-version directory.
    const path = decodeURIComponent((req.url ?? '').replace(/^\/viceme-sdk\/[^/]+\//, ''));
    const file = files.get(path);
    if (!file) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    res.writeHead(200, {
      'content-type': file.contentType,
      'cache-control': 'public, max-age=31536000, immutable',
      ...(req.headers.origin === 'https://example.com'
        ? { 'access-control-allow-origin': '*' }
        : {}),
    });
    res.end(file.body);
  });

  await new Promise<void>((resolve) => {
    httpServer.listen(0, '127.0.0.1', resolve);
  });
  const address = httpServer.address();
  if (address === null || typeof address === 'string') throw new Error('bind failed');
  server = {
    url: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((done) => {
        httpServer.close(() => done());
      }),
  };
});

afterAll(async () => {
  await server?.close();
});

function run(...args: string[]) {
  return exec('node', [script, ...args]);
}

describe('verify-cdn.mjs', () => {
  it('passes for an untampered immutable exact version', async () => {
    const { stdout } = await run('--base', `${server!.url}/viceme-sdk/0.1.0/`);
    expect(stdout).toContain('cdn verification passed');
  });

  it('detects a tampered artifact', async () => {
    const entry = files.get('index.js')!;
    const original = entry.body;
    const tampered = Buffer.from(original);
    tampered[tampered.length - 2] = tampered[tampered.length - 2]! ^ 0xff;
    files.set('index.js', { ...entry, body: tampered });
    try {
      await expect(run('--base', `${server!.url}/viceme-sdk/0.1.0/`)).rejects.toMatchObject({
        code: 1,
      });
    } finally {
      files.set('index.js', { ...entry, body: original });
    }
  });

  it('binds the expected version to the exact path and manifest', async () => {
    await expect(
      run('--base', `${server!.url}/viceme-sdk/0.1.0/`, '--expect-version', '0.1.0'),
    ).resolves.toMatchObject({ stdout: expect.stringContaining('0.1.0') });

    await expect(
      run('--base', `${server!.url}/viceme-sdk/0.1.0/`, '--expect-version', '9.9.9'),
    ).rejects.toMatchObject({ code: 1 });
  });

  it('rejects every non-exact remote base', async () => {
    await expect(run('--base', `${server!.url}/viceme-sdk/latest/`)).rejects.toMatchObject({
      code: 1,
    });
  });

  it('local mode verifies the fixture directory', async () => {
    const { stdout } = await run('--local', distDir);
    expect(stdout).toContain('local verification passed');
  });
});
