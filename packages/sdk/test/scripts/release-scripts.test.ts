// @vitest-environment node
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createServer, type Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const exec = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const scriptsDir = join(here, '..', '..', '..', '..', 'scripts');

/**
 * Subprocess tests for the release scripts:
 * - upload-plan.mjs: immutability planning (missing / identical / conflict).
 * - verify-npm-dist-tag.mjs: dist-tag read-back policy.
 */

function run(script: string, ...args: string[]) {
  return exec('node', [join(scriptsDir, script), ...args]);
}

/* ------------------------------ upload plan ------------------------------ */

interface ServedFile {
  body: Buffer;
  contentType: string;
}

const distDir = mkdtempSync(join(tmpdir(), 'viceme-upload-plan-'));
const remote = new Map<string, ServedFile>();

let server:
  | {
      url: string;
      close: () => Promise<void>;
    }
  | undefined;

beforeAll(async () => {
  const indexBody = Buffer.from('export const SDK_VERSION = "0.1.0";\n');
  const loaderBody = Buffer.from('(function(){/* loader */})();\n');
  const danmakuBody = Buffer.from('export const mount = () => {};\n');
  const tipBody = Buffer.from('export const mountTip = () => {};\n');
  const tipTestingBody = Buffer.from('export const createTestTip = () => {};\n');
  const digest = (body: Buffer) => ({
    sha256: createHash('sha256').update(body).digest('hex'),
    sri: `sha384-${createHash('sha384').update(body).digest('base64')}`,
    bytes: body.length,
    gzipBytes: body.length,
  });
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

  // Remote starts empty; tests mutate it.
  const httpServer: Server = createServer((req, res) => {
    const path = decodeURIComponent((req.url ?? '').replace(/^\/viceme-sdk\/[^/]+\//, ''));
    const file = remote.get(path);
    if (!file) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    res.writeHead(200, {
      'content-type': file.contentType,
      'cache-control': 'public, max-age=31536000, immutable',
      'access-control-allow-origin': '*',
    });
    res.end(file.body);
  });
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const address = httpServer.address();
  if (address === null || typeof address === 'string') throw new Error('bind failed');
  server = {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((done) => httpServer.close(() => done())),
  };
});

afterAll(async () => {
  await server?.close();
});

describe('upload-plan.mjs', () => {
  it('lists every file — including manifest.json itself — when the remote is empty', async () => {
    const { stdout } = await run(
      'upload-plan.mjs',
      '--dist',
      distDir,
      '--base',
      `${server!.url}/viceme-sdk/0.1.0/`,
    );
    // manifest.json is a first-class immutable object even though it is not
    // listed inside manifest.files: verify-cdn reads it from this path.
    expect(stdout.split('\n').filter(Boolean).sort()).toEqual([
      'danmaku.js',
      'index.js',
      'manifest.json',
      'tip.js',
      'tip/testing.js',
      'viceme.min.js',
    ]);
  });

  it('skips byte-identical objects and lists only the missing ones', async () => {
    remote.set('index.js', {
      body: await import('node:fs/promises').then((fs) => fs.readFile(join(distDir, 'index.js'))),
      contentType: 'text/javascript; charset=utf-8',
    });
    const { stdout } = await run(
      'upload-plan.mjs',
      '--dist',
      distDir,
      '--base',
      `${server!.url}/viceme-sdk/0.1.0/`,
    );
    expect(stdout.split('\n').filter(Boolean).sort()).toEqual([
      'danmaku.js',
      'manifest.json',
      'tip.js',
      'tip/testing.js',
      'viceme.min.js',
    ]);
  });

  it('fails closed when the remote object has different bytes', async () => {
    remote.set('index.js', {
      body: Buffer.from('tampered content\n'),
      contentType: 'text/javascript; charset=utf-8',
    });
    await expect(
      run('upload-plan.mjs', '--dist', distDir, '--base', `${server!.url}/viceme-sdk/0.1.0/`),
    ).rejects.toMatchObject({ code: 1 });
    remote.delete('index.js');
  });

  it('guards manifest.json itself against overwrite', async () => {
    remote.set('manifest.json', {
      body: Buffer.from('{"version":"0.0.0-tampered"}\n'),
      contentType: 'application/json; charset=utf-8',
    });
    await expect(
      run('upload-plan.mjs', '--dist', distDir, '--base', `${server!.url}/viceme-sdk/0.1.0/`),
    ).rejects.toMatchObject({ code: 1 });
    remote.delete('manifest.json');
  });
});

/* --------------------------- dist-tag read-back -------------------------- */

describe('verify-npm-dist-tag.mjs', () => {
  function runJson(json: string, ...args: string[]) {
    return run('verify-npm-dist-tag.mjs', '--dist-tags-json', json, ...args);
  }

  it('passes when latest points at the stable version', async () => {
    const { stdout } = await runJson('{"latest":"0.2.0"}', '--version', '0.2.0', '--tag', 'latest');
    expect(stdout).toContain('latest -> 0.2.0');
  });

  it('fails when the tag is unset or points elsewhere', async () => {
    await expect(
      runJson('{"latest":"0.1.0"}', '--version', '0.2.0', '--tag', 'latest'),
    ).rejects.toMatchObject({ code: 1 });
    await expect(runJson('{}', '--version', '0.2.0', '--tag', 'latest')).rejects.toMatchObject({
      code: 1,
    });
  });

  it('rejects prerelease versions and non-latest tags', async () => {
    await expect(
      runJson('{"next":"0.2.0-next.0"}', '--version', '0.2.0-next.0', '--tag', 'next'),
    ).rejects.toMatchObject({ code: 2 });
  });
});

/* ---------------------------- input validation --------------------------- */

describe('validate-release-inputs.mjs', () => {
  it('accepts exact semver versions and known region sets', async () => {
    await expect(run('validate-release-inputs.mjs', '--version', '1.2.3')).resolves.toMatchObject({
      stdout: expect.stringContaining('valid'),
    });
    await expect(
      run('validate-release-inputs.mjs', '--version', '1.2.3', '--regions', 'cn,global'),
    ).resolves.toMatchObject({ stdout: expect.stringContaining('valid') });
  });

  it('rejects malformed versions and unknown or duplicate regions', async () => {
    for (const bad of ['1.2', 'v1.2.3', '1.2.3-next.0', '1.2.3;rm -rf', '../escape', '']) {
      await expect(run('validate-release-inputs.mjs', '--version', bad)).rejects.toMatchObject({
        code: 1,
      });
    }
    await expect(
      run('validate-release-inputs.mjs', '--version', '1.2.3', '--regions', 'eu'),
    ).rejects.toMatchObject({ code: 1 });
    await expect(
      run('validate-release-inputs.mjs', '--version', '1.2.3', '--regions', 'cn,cn'),
    ).rejects.toMatchObject({ code: 1 });
    await expect(
      run('validate-release-inputs.mjs', '--version', '1.2.3', '--regions', ','),
    ).rejects.toMatchObject({ code: 1 });
  });
});
