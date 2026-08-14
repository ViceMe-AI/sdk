// @vitest-environment node
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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
 * - release-gate.mjs: license preconditions fail closed.
 * - upload-plan.mjs: immutability planning (missing / identical / conflict).
 * - verify-npm-dist-tag.mjs: dist-tag read-back policy.
 */

function run(script: string, ...args: string[]) {
  return exec('node', [join(scriptsDir, script), ...args]);
}

/* ------------------------------ release gate ----------------------------- */

describe('release-gate.mjs', () => {
  it('fails while the license is pending', async () => {
    const root = mkdtempSync(join(tmpdir(), 'viceme-gate-'));
    mkdirSync(join(root, 'packages', 'sdk'), { recursive: true });
    writeFileSync(join(root, 'LICENSE-PENDING.md'), '# License (pending)\nplaceholder\n');
    writeFileSync(
      join(root, 'packages', 'sdk', 'package.json'),
      JSON.stringify({
        files: ['dist', 'README.md', 'LICENSE'],
        publishConfig: { access: 'public' },
      }),
    );
    await expect(run('release-gate.mjs', '--root', root)).rejects.toMatchObject({ code: 1 });
  });

  it('passes with a final license and correct package metadata', async () => {
    const root = mkdtempSync(join(tmpdir(), 'viceme-gate-'));
    mkdirSync(join(root, 'packages', 'sdk'), { recursive: true });
    writeFileSync(join(root, 'LICENSE'), 'Apache License\n2.0\n');
    writeFileSync(
      join(root, 'packages', 'sdk', 'package.json'),
      JSON.stringify({
        files: ['dist', 'README.md', 'LICENSE'],
        publishConfig: { access: 'public' },
      }),
    );
    const { stdout } = await run('release-gate.mjs', '--root', root);
    expect(stdout).toContain('release gate passed');
  });

  it('fails when both LICENSE and the placeholder exist', async () => {
    const root = mkdtempSync(join(tmpdir(), 'viceme-gate-'));
    mkdirSync(join(root, 'packages', 'sdk'), { recursive: true });
    writeFileSync(join(root, 'LICENSE'), 'Apache License\n2.0\n');
    writeFileSync(join(root, 'LICENSE-PENDING.md'), 'stale\n');
    writeFileSync(
      join(root, 'packages', 'sdk', 'package.json'),
      JSON.stringify({
        files: ['dist', 'README.md', 'LICENSE'],
        publishConfig: { access: 'public' },
      }),
    );
    await expect(run('release-gate.mjs', '--root', root)).rejects.toMatchObject({ code: 1 });
  });

  it('fails on the real repo today (license still pending)', async () => {
    const repoRoot = join(here, '..', '..', '..', '..');
    await expect(run('release-gate.mjs', '--root', repoRoot)).rejects.toMatchObject({ code: 1 });
  });
});

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
  const digest = (body: Buffer) => ({
    sha256: createHash('sha256').update(body).digest('hex'),
    sri: `sha384-${createHash('sha384').update(body).digest('base64')}`,
    bytes: body.length,
    gzipBytes: body.length,
  });
  writeFileSync(join(distDir, 'index.js'), indexBody);
  mkdirSync(join(distDir, 'loader'), { recursive: true });
  writeFileSync(join(distDir, 'loader', 'viceme.min.js'), loaderBody);
  writeFileSync(
    join(distDir, 'manifest.json'),
    `${JSON.stringify(
      {
        version: '0.1.0',
        apiMajor: 1,
        loader: 'loader/viceme.min.js',
        features: {},
        files: {
          'index.js': digest(indexBody),
          'loader/viceme.min.js': digest(loaderBody),
        },
      },
      null,
      2,
    )}\n`,
  );

  // Remote starts empty; tests mutate it.
  const httpServer: Server = createServer((req, res) => {
    const path = decodeURIComponent((req.url ?? '').replace(/^\/sdk\/[^/]+\//, ''));
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
      `${server!.url}/sdk/0.1.0/`,
    );
    // manifest.json is a first-class immutable object even though it is not
    // listed inside manifest.files: verify-cdn reads it from this path.
    expect(stdout.split('\n').filter(Boolean).sort()).toEqual([
      'index.js',
      'loader/viceme.min.js',
      'manifest.json',
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
      `${server!.url}/sdk/0.1.0/`,
    );
    expect(stdout.split('\n').filter(Boolean).sort()).toEqual([
      'loader/viceme.min.js',
      'manifest.json',
    ]);
  });

  it('fails closed when the remote object has different bytes', async () => {
    remote.set('index.js', {
      body: Buffer.from('tampered content\n'),
      contentType: 'text/javascript; charset=utf-8',
    });
    await expect(
      run('upload-plan.mjs', '--dist', distDir, '--base', `${server!.url}/sdk/0.1.0/`),
    ).rejects.toMatchObject({ code: 1 });
    remote.delete('index.js');
  });

  it('guards manifest.json itself against overwrite', async () => {
    remote.set('manifest.json', {
      body: Buffer.from('{"version":"0.0.0-tampered"}\n'),
      contentType: 'application/json; charset=utf-8',
    });
    await expect(
      run('upload-plan.mjs', '--dist', distDir, '--base', `${server!.url}/sdk/0.1.0/`),
    ).rejects.toMatchObject({ code: 1 });
    remote.delete('manifest.json');
  });
});

/* --------------------------- dist-tag read-back -------------------------- */

describe('verify-npm-dist-tag.mjs', () => {
  function runJson(json: string, ...args: string[]) {
    return run('verify-npm-dist-tag.mjs', '--dist-tags-json', json, ...args);
  }

  it('passes when the tag points at the version and latest does not', async () => {
    const { stdout } = await runJson(
      '{"next":"0.1.1-next.0","latest":"0.0.9"}',
      '--version',
      '0.1.1-next.0',
      '--tag',
      'next',
    );
    expect(stdout).toContain('next -> 0.1.1-next.0');
  });

  it('fails when the tag is unset or points elsewhere', async () => {
    await expect(
      runJson('{"latest":"0.0.9"}', '--version', '0.1.1-next.0', '--tag', 'next'),
    ).rejects.toMatchObject({ code: 1 });
    await expect(
      runJson('{"next":"0.0.9"}', '--version', '0.1.1-next.0', '--tag', 'next'),
    ).rejects.toMatchObject({ code: 1 });
  });

  it('fails when latest points at a next-tagged version', async () => {
    await expect(
      runJson(
        '{"next":"0.1.1-next.0","latest":"0.1.1-next.0"}',
        '--version',
        '0.1.1-next.0',
        '--tag',
        'next',
      ),
    ).rejects.toMatchObject({ code: 1 });
  });
});

/* --------------------------- alias pointer write ------------------------- */

describe('write-alias-pointer.mjs', () => {
  const tmpRoot = mkdtempSync(join(tmpdir(), 'viceme-alias-'));

  // Fake region-scoped CDN: `fake-upload <region> <file> <key>` stores the
  // file under <root>/<region>/<key>; two static servers expose each region.
  const fakeUpload = join(tmpRoot, 'fake-upload.mjs');
  writeFileSync(
    fakeUpload,
    [
      "import { mkdirSync, copyFileSync } from 'node:fs';",
      "import { dirname, join } from 'node:path';",
      'const [, , region, file, key] = process.argv;',
      "const target = join(process.env.FAKE_CDN_ROOT ?? '', region, key);",
      'mkdirSync(dirname(target), { recursive: true });',
      'copyFileSync(file, target);',
    ].join('\n'),
  );

  function startRegionServer(region: string) {
    const regionRoot = join(tmpRoot, region);
    const httpServer: Server = createServer((req, res) => {
      const path = decodeURIComponent(req.url ?? '').replace(/^\/+/, '');
      try {
        const body = readFileSync(join(regionRoot, path));
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end(body);
      } catch {
        res.writeHead(404);
        res.end('not found');
      }
    });
    return new Promise<{ url: string; close: () => Promise<void> }>((resolve) => {
      httpServer.listen(0, '127.0.0.1', () => {
        const address = httpServer.address();
        if (address === null || typeof address === 'string') throw new Error('bind failed');
        resolve({
          url: `http://127.0.0.1:${address.port}`,
          close: () => new Promise((done) => httpServer.close(() => done())),
        });
      });
    });
  }

  it('writes one pointer object per region and verifies the read-back', async () => {
    const cn = await startRegionServer('cn');
    const global = await startRegionServer('global');
    try {
      const { stdout } = await exec(
        'node',
        [
          join(scriptsDir, 'write-alias-pointer.mjs'),
          '--version',
          '0.2.0',
          '--regions',
          'cn,global',
          '--hosts',
          `cn=${cn.url},global=${global.url}`,
          '--upload-command',
          `node ${fakeUpload}`,
        ],
        { env: { ...process.env, FAKE_CDN_ROOT: tmpRoot } },
      );
      expect(stdout).toContain('alias pointer written and verified in 2 region(s)');
      for (const region of ['cn', 'global']) {
        expect(readFileSync(join(tmpRoot, region, 'sdk', '-', 'aliases', 'v1'), 'utf8')).toBe(
          '0.2.0',
        );
      }
    } finally {
      await cn.close();
      await global.close();
    }
  });

  it('fails closed when the pointer read-back does not match', async () => {
    const cn = await startRegionServer('cn');
    try {
      // Pre-seed a wrong pointer and make the upload a no-op.
      mkdirSync(join(tmpRoot, 'cn', 'sdk', '-', 'aliases'), { recursive: true });
      writeFileSync(join(tmpRoot, 'cn', 'sdk', '-', 'aliases', 'v1'), '9.9.9');
      await expect(
        exec(
          'node',
          [
            join(scriptsDir, 'write-alias-pointer.mjs'),
            '--version',
            '0.2.0',
            '--regions',
            'cn',
            '--hosts',
            `cn=${cn.url}`,
            '--upload-command',
            'true',
          ],
          { env: { ...process.env, FAKE_CDN_ROOT: tmpRoot } },
        ),
      ).rejects.toMatchObject({ code: 1 });
    } finally {
      await cn.close();
    }
  });

  it('rejects unknown regions', async () => {
    await expect(
      run(
        'write-alias-pointer.mjs',
        '--version',
        '0.2.0',
        '--regions',
        'eu',
        '--hosts',
        'eu=https://example.com',
        '--upload-command',
        'true',
      ),
    ).rejects.toMatchObject({ code: 1 });
  });
});
