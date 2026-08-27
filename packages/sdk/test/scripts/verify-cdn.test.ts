// @vitest-environment node
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync as writeFile } from 'node:fs';
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
const bootstrapBody = Buffer.from('(function(){/* fixed alias bootstrap */})();\n');
const danmakuBody = Buffer.from('export const mount = () => {};\n');
const tipBody = Buffer.from('export const mountTip = () => {};\n');

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
  await writeFile(join(distDir, 'viceme.min.js'), loaderBody);

  files.set('index.js', { body: indexBody, contentType: 'text/javascript; charset=utf-8' });
  files.set('danmaku.js', { body: danmakuBody, contentType: 'text/javascript; charset=utf-8' });
  files.set('tip.js', { body: tipBody, contentType: 'text/javascript; charset=utf-8' });
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
    // Both /viceme-sdk/<version>/ and /viceme-sdk/v1/ map to the same dist layout.
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

  it('enforces the alias expectation', async () => {
    await expect(
      run(
        '--base',
        `${server!.url}/viceme-sdk/v1/`,
        '--expect-version',
        '0.1.0',
        '--allow-mutable-cache',
      ),
    ).resolves.toMatchObject({ stdout: expect.stringContaining('0.1.0') });

    await expect(
      run(
        '--base',
        `${server!.url}/viceme-sdk/v1/`,
        '--expect-version',
        '9.9.9',
        '--allow-mutable-cache',
      ),
    ).rejects.toMatchObject({ code: 1 });
  });

  it('alias mode byte-verifies the alias loader against the canonical bootstrap', async () => {
    // Dedicated server preserving full keys under /viceme-sdk/.
    const bytes = new Map<string, Buffer>([
      ['-/aliases/v1', Buffer.from('0.1.0\n')],
      ['v1/viceme.min.js', bootstrapBody],
      ['0.1.0/bootstrap.min.js', bootstrapBody],
      ['0.1.0/manifest.json', readFileSync(join(distDir, 'manifest.json'))],
      ['0.1.0/index.js', indexBody],
      ['0.1.0/viceme.min.js', loaderBody],
      ['0.1.0/danmaku.js', danmakuBody],
      ['0.1.0/tip.js', tipBody],
    ]);
    const httpServer = createServer((req, res) => {
      const key = decodeURIComponent((req.url ?? '').replace(/^\/viceme-sdk\//, ''));
      const body = bytes.get(key);
      if (!body) {
        res.writeHead(404);
        res.end('not found');
        return;
      }
      res.writeHead(200, {
        'content-type': key.endsWith('.json')
          ? 'application/json; charset=utf-8'
          : key === '-/aliases/v1'
            ? 'text/plain; charset=utf-8'
            : 'text/javascript; charset=utf-8',
        'cache-control': 'public,max-age=31536000,immutable',
        ...(req.headers.origin === 'https://example.com'
          ? { 'access-control-allow-origin': '*' }
          : {}),
      });
      res.end(body);
    });
    await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
    const address = httpServer.address();
    if (address === null || typeof address === 'string') throw new Error('bind failed');
    const url = `http://127.0.0.1:${address.port}`;
    try {
      // Canonical bytes on the alias path: verification passes.
      await expect(
        run('--base', `${url}/viceme-sdk/v1/`, '--expect-version', '0.1.0'),
      ).resolves.toMatchObject({ stdout: expect.stringContaining('alias loader byte-verified') });

      // Corrupted alias loader (HTTP 200 with wrong bytes): fails closed.
      bytes.set('v1/viceme.min.js', Buffer.from('(function(){/* corrupted */})();\n'));
      await expect(
        run('--base', `${url}/viceme-sdk/v1/`, '--expect-version', '0.1.0'),
      ).rejects.toMatchObject({ code: 1 });

      // Pointer mismatch: fails closed.
      bytes.set('v1/viceme.min.js', bootstrapBody);
      bytes.set('-/aliases/v1', Buffer.from('9.9.9\n'));
      await expect(
        run('--base', `${url}/viceme-sdk/v1/`, '--expect-version', '0.1.0'),
      ).rejects.toMatchObject({ code: 1 });
    } finally {
      await new Promise<void>((done) => httpServer.close(() => done()));
    }
  });

  it('local mode verifies the fixture directory', async () => {
    const { stdout } = await run('--local', distDir);
    expect(stdout).toContain('local verification passed');
  });
});
